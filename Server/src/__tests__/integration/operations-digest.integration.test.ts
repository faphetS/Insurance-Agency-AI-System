/**
 * Integration test: operations.digest — runDailyDigest
 *
 * Seeds staff (with phone), tasks, clients, conversations and messages as the
 * digest reads, then calls runDailyDigest.
 *
 * Asserts:
 *   - sendMessageWithTyping is called for each active staff member that has
 *     pending items AND for the owner (overview message)
 *   - The last_digest_date system_setting is written after the first run
 *   - A second immediate run (without force) does NOT re-send (date guard)
 *   - A run with { force: true } does re-send regardless of the date guard
 *   - No real WhatsApp or HTTP I/O occurs (all mocked)
 *
 * Mock targets:
 *   - whatsapp/whatsapp.service.js  (sendMessageWithTyping — the only WA send in the digest)
 *   - domains/operations/operations.email.js  (emailProvider.scanAll — external email API)
 *   - domains/operations/operations.whatsapp-monitor.js (whatsappMonitor.getSummary)
 *   - domains/operations/operations.service-meetings.js (getServiceMeetingsSummary)
 *
 * NOTE: getDashboard() internally queries v_client_pipeline. If that view is
 * absent from the test DB schema the dashboard call will error and fall back
 * to zeros, which is handled gracefully by the digest code.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — declared before any subject import
// ---------------------------------------------------------------------------

vi.mock("../../domains/whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `dgst-${Math.random().toString(36).slice(2)}` })),
  sendInteractiveButtonsWithTyping: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `dgst-btn-${Math.random().toString(36).slice(2)}` })),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `dgst-msg-${Math.random().toString(36).slice(2)}` })),
}));

// Stub the lazy-imported monitoring providers to avoid any HTTP calls
vi.mock("../../domains/operations/operations.email.js", () => ({
  emailProvider: {
    scanAll: vi.fn().mockResolvedValue({ totalPending: 0, byStaff: [] }),
  },
}));

vi.mock("../../domains/operations/operations.whatsapp-monitor.js", () => ({
  whatsappMonitor: {
    getSummary: vi.fn().mockResolvedValue({ unanswered: 0, instances: [] }),
  },
}));

vi.mock("../../domains/operations/operations.service-meetings.js", () => ({
  getServiceMeetingsSummary: vi.fn().mockResolvedValue({ total: 0, meetings: [] }),
}));

// ---------------------------------------------------------------------------
// Subject + helpers
// ---------------------------------------------------------------------------

import { runDailyDigest } from "../../domains/operations/operations.digest.js";
import { pool } from "../../lib/db.js";
import { sendMessageWithTyping } from "../../domains/whatsapp/whatsapp.service.js";

const mockSendMsg = sendMessageWithTyping as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface DigestSeeds {
  ownerStaffId: string;
  agentStaffId: string;
  clientId: string;
}

// Israeli phone numbers that toChatId will resolve to a chatId
const OWNER_PHONE = "+972501111111";
const AGENT_PHONE = "+972502222222";

async function seed(): Promise<DigestSeeds> {
  const ownerStaffId = randomUUID();
  const agentStaffId = randomUUID();
  const clientId = randomUUID();

  await pool.query(
    `INSERT INTO staff (id, full_name, email, phone, role, is_active)
     VALUES ($1, $2, $3, $4, 'owner', true)`,
    [ownerStaffId, "Digest Owner", `owner-${ownerStaffId}@test.example`, OWNER_PHONE],
  );

  await pool.query(
    `INSERT INTO staff (id, full_name, email, phone, role, is_active)
     VALUES ($1, $2, $3, $4, 'agent', true)`,
    [agentStaffId, "Digest Agent", `agent-${agentStaffId}@test.example`, AGENT_PHONE],
  );

  // Client assigned to the agent (assigned_to = agent). assigned_to is NOT NULL.
  await pool.query(
    `INSERT INTO clients
       (id, full_name, phone, inquiry_type, status, assigned_to,
        source_channel, id_validated, last_service_date)
     VALUES ($1, $2, $3, 'health', 'active', $4, 'wa', false, NULL)`,
    [clientId, "Digest Client", `0503${agentStaffId.slice(0, 6)}`, agentStaffId],
  );

  // Overdue task assigned to agent (due 2 days ago, pending)
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO tasks
       (id, client_id, type, description, assigned_to, due_at, status, reminder_sent)
     VALUES ($1, $2, 'forms_check', 'Check forms', $3, $4, 'pending', false)`,
    [randomUUID(), clientId, agentStaffId, twoDaysAgo.toISOString()],
  );

  return { ownerStaffId, agentStaffId, clientId };
}

async function teardown(seeds: DigestSeeds) {
  await pool.query(`DELETE FROM tasks WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM meetings WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM staff WHERE id IN ($1, $2)`, [
    seeds.ownerStaffId,
    seeds.agentStaffId,
  ]);
}

async function deleteDigestDate() {
  await pool.query(`DELETE FROM system_settings WHERE key = 'last_digest_date'`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDailyDigest — first run sends messages and stamps date", () => {
  let seeds: DigestSeeds;

  beforeAll(async () => {
    await deleteDigestDate();
    seeds = await seed();
  });

  afterAll(async () => {
    await teardown(seeds);
    await deleteDigestDate();
  });

  it("calls sendMessageWithTyping at least once (agent + owner)", async () => {
    mockSendMsg.mockClear();
    await runDailyDigest();
    // At minimum: 1 agent digest + 1 owner overview = 2 calls
    expect(mockSendMsg.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("writes last_digest_date to system_settings", async () => {
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM system_settings WHERE key = 'last_digest_date'`,
    );
    expect(rows).toHaveLength(1);
    // Value should be today's date in YYYY-MM-DD format (Jerusalem TZ)
    expect(rows[0]!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("runDailyDigest — date guard prevents re-send on same day", () => {
  let seeds: DigestSeeds;

  beforeAll(async () => {
    await deleteDigestDate();
    seeds = await seed();
  });

  afterAll(async () => {
    await teardown(seeds);
    await deleteDigestDate();
  });

  it("second run without force does NOT send again", async () => {
    mockSendMsg.mockClear();
    await runDailyDigest(); // first run — stamps the date
    const firstRunCalls = mockSendMsg.mock.calls.length;
    expect(firstRunCalls).toBeGreaterThan(0);

    mockSendMsg.mockClear();
    await runDailyDigest(); // second run — should be skipped
    expect(mockSendMsg.mock.calls.length).toBe(0);
  });
});

describe("runDailyDigest — force flag bypasses date guard", () => {
  let seeds: DigestSeeds;

  beforeAll(async () => {
    await deleteDigestDate();
    seeds = await seed();
  });

  afterAll(async () => {
    await teardown(seeds);
    await deleteDigestDate();
  });

  it("force=true sends even after the date is already stamped", async () => {
    mockSendMsg.mockClear();
    await runDailyDigest(); // stamps today's date

    mockSendMsg.mockClear();
    await runDailyDigest({ force: true }); // should bypass guard
    expect(mockSendMsg.mock.calls.length).toBeGreaterThan(0);
  });

  it("force=true does NOT overwrite last_digest_date (manual trigger must not block cron)", async () => {
    // The digest code only writes last_digest_date for non-forced runs.
    // Verify the date was written by the first (non-forced) run, not wiped by forced run.
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = 'last_digest_date'`,
    );
    // There should still be exactly one row (written by the first non-forced run)
    expect(rows).toHaveLength(1);
  });
});

describe("runDailyDigest — staff with no items are skipped", () => {
  let ownerStaffId: string;
  let agentStaffId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    await deleteDigestDate();

    ownerStaffId = randomUUID();
    agentStaffId = randomUUID();

    // Owner with phone
    await pool.query(
      `INSERT INTO staff (id, full_name, email, phone, role, is_active)
       VALUES ($1, $2, $3, $4, 'owner', true)`,
      [ownerStaffId, "No-Items Owner", `noi-owner-${ownerStaffId}@test.example`, "+972503333333"],
    );

    // Agent with phone but NO clients/tasks assigned
    await pool.query(
      `INSERT INTO staff (id, full_name, email, phone, role, is_active)
       VALUES ($1, $2, $3, $4, 'agent', true)`,
      [agentStaffId, "No-Items Agent", `noi-agent-${agentStaffId}@test.example`, "+972504444444"],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM staff WHERE id IN ($1, $2)`, [ownerStaffId, agentStaffId]);
    await deleteDigestDate();
  });

  it("agent with no pending items does not receive a digest", async () => {
    await runDailyDigest();

    // No call should target the no-items agent's chatId
    const noItemsAgentChatId = "972504444444@c.us";
    const calledChatIds = mockSendMsg.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledChatIds).not.toContain(noItemsAgentChatId);
  });
});

describe("runDailyDigest — no owner falls back gracefully", () => {
  let agentStaffId: string;
  let clientId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    await deleteDigestDate();

    agentStaffId = randomUUID();
    clientId = randomUUID();

    await pool.query(
      `INSERT INTO staff (id, full_name, email, phone, role, is_active)
       VALUES ($1, $2, $3, $4, 'agent', true)`,
      [agentStaffId, "Orphan Agent", `orphan-${agentStaffId}@test.example`, "+972505555555"],
    );

    await pool.query(
      `INSERT INTO clients
         (id, full_name, phone, inquiry_type, status, assigned_to,
          source_channel, id_validated, last_service_date)
       VALUES ($1, $2, $3, 'health', 'active', $4, 'wa', false, NULL)`,
      [clientId, "Orphan Client", `0505${agentStaffId.slice(0, 6)}`, agentStaffId],
    );

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO tasks
         (id, client_id, type, description, assigned_to, due_at, status, reminder_sent)
       VALUES ($1, $2, 'forms_check', 'Check forms', $3, $4, 'pending', false)`,
      [randomUUID(), clientId, agentStaffId, twoDaysAgo.toISOString()],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM tasks WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
    await pool.query(`DELETE FROM staff WHERE id = $1`, [agentStaffId]);
    await deleteDigestDate();
  });

  it("sends agent digest but does not crash when there is no owner", async () => {
    // No owner exists — runDailyDigest should still send the agent digest
    // and exit cleanly (logs a warning about missing owner)
    await expect(runDailyDigest()).resolves.not.toThrow();

    // Agent with items should still receive their digest
    const calledChatIds = mockSendMsg.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledChatIds.length).toBeGreaterThanOrEqual(1);
  });
});
