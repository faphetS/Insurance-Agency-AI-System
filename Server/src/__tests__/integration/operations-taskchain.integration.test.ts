/**
 * Integration test: operations.service — createTaskChain
 *
 * Seeds a staff member, client, and meeting, then calls createTaskChain.
 * Asserts:
 *   - 5 task rows are created with the correct types and due_at offsets
 *     (forms_check+7d, receipt_check+14d, policy_check+30d, deposit_check+60d, cross_check+90d)
 *   - clients.pipeline_stage is advanced to 'forms'
 *   - a notification row is created with reference_key = `task_chain:<meetingId>`
 *   - calling createTaskChain twice does NOT duplicate the notification
 *     (upsert with ignoreDuplicates on reference_key)
 *   - all WhatsApp sends (notifyStaffHandoff) are mocked — no real I/O
 *
 * Mocks:
 *   - whatsapp/whatsapp.service.js  (sendMessageWithTyping, sendInteractiveButtonsWithTyping)
 *   - lib/storage.js                (getSignedDocUrl — used by staff-handoff)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — declared before any subject import
// ---------------------------------------------------------------------------

vi.mock("../../domains/whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `wamt-${Math.random().toString(36).slice(2)}` })),
  sendInteractiveButtonsWithTyping: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `wabi-${Math.random().toString(36).slice(2)}` })),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `wam-${Math.random().toString(36).slice(2)}` })),
}));

vi.mock("../../lib/storage.js", () => ({
  getSignedDocUrl: vi.fn().mockResolvedValue(null),
  persistRemoteFile: vi.fn().mockResolvedValue("fake/path.jpg"),
  extFor: vi.fn().mockReturnValue("jpg"),
}));

// ---------------------------------------------------------------------------
// Subject + helpers
// ---------------------------------------------------------------------------

import { createTaskChain } from "../../domains/operations/operations.service.js";
import { pool } from "../../lib/db.js";
import { TASK_CHAIN_DEFINITION } from "../../domains/operations/operations.types.js";

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------

interface Seeds {
  staffId: string;
  clientId: string;
  meetingId: string;
}

async function seed(): Promise<Seeds> {
  const staffId = randomUUID();
  const clientId = randomUUID();
  const meetingId = randomUUID();

  await pool.query(
    `INSERT INTO staff (id, full_name, email, role, is_active)
     VALUES ($1, $2, $3, 'agent', true)`,
    [staffId, "TC Agent", `tc-agent-${staffId}@test.example`],
  );

  await pool.query(
    `INSERT INTO clients
       (id, full_name, phone, inquiry_type, status, assigned_to,
        source_channel, id_validated, pipeline_stage)
     VALUES ($1, $2, $3, 'general', 'active', $4, 'wa', false, 'awaiting_approval')`,
    [clientId, "TC Client", `0500${staffId.slice(0, 6)}`, staffId],
  );

  await pool.query(
    `INSERT INTO meetings
       (id, client_id, type, scheduled_at, status, summary_status, client_confirmed)
     VALUES ($1, $2, 'phone', now() - interval '1 day', 'done', 'approved', true)`,
    [meetingId, clientId],
  );

  return { staffId, clientId, meetingId };
}

async function teardown(seeds: Seeds) {
  await pool.query(`DELETE FROM notifications WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM tasks WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM meetings WHERE id = $1`, [seeds.meetingId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM staff WHERE id = $1`, [seeds.staffId]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("operations.service — createTaskChain", () => {
  let seeds: Seeds;

  beforeAll(async () => {
    seeds = await seed();
  });

  afterAll(async () => {
    await teardown(seeds);
  });

  it("creates the correct number of tasks with right types", async () => {
    await createTaskChain(seeds.meetingId);

    const { rows } = await pool.query<{ type: string }>(
      `SELECT type FROM tasks WHERE meeting_id = $1 ORDER BY due_at ASC`,
      [seeds.meetingId],
    );

    expect(rows).toHaveLength(TASK_CHAIN_DEFINITION.length);
    const types = rows.map((r) => r.type);
    expect(types).toEqual(TASK_CHAIN_DEFINITION.map((s) => s.type));
  });

  it("due_at offsets match TASK_CHAIN_DEFINITION delayDays", async () => {
    const { rows } = await pool.query<{ type: string; due_at: Date }>(
      `SELECT type, due_at FROM tasks WHERE meeting_id = $1 ORDER BY due_at ASC`,
      [seeds.meetingId],
    );

    const now = new Date();

    for (let i = 0; i < TASK_CHAIN_DEFINITION.length; i++) {
      const step = TASK_CHAIN_DEFINITION[i]!;
      const row = rows[i]!;
      expect(row.type).toBe(step.type);

      const expectedMs = step.delayDays * 24 * 60 * 60 * 1000;
      const actualMs = row.due_at.getTime() - now.getTime();
      // Allow ±5 seconds of clock drift
      expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5_000);
    }
  });

  it("tasks are assigned to the client's staff member", async () => {
    const { rows } = await pool.query<{ assigned_to: string }>(
      `SELECT DISTINCT assigned_to FROM tasks WHERE meeting_id = $1`,
      [seeds.meetingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assigned_to).toBe(seeds.staffId);
  });

  it("tasks are inserted with status=pending and reminder_sent=false", async () => {
    const { rows } = await pool.query<{ status: string; reminder_sent: boolean }>(
      `SELECT status, reminder_sent FROM tasks WHERE meeting_id = $1`,
      [seeds.meetingId],
    );
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.reminder_sent).toBe(false);
    }
  });

  it("advances client pipeline_stage to 'forms'", async () => {
    const { rows } = await pool.query<{ pipeline_stage: string }>(
      `SELECT pipeline_stage FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]!.pipeline_stage).toBe("forms");
  });

  it("creates a notification with the correct reference_key", async () => {
    const { rows } = await pool.query<{
      type: string;
      reference_key: string;
      client_id: string;
      meeting_id: string;
    }>(
      `SELECT type, reference_key, client_id, meeting_id
       FROM notifications
       WHERE reference_key = $1`,
      [`task_chain:${seeds.meetingId}`],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("summary_ready");
    expect(rows[0]!.client_id).toBe(seeds.clientId);
    expect(rows[0]!.meeting_id).toBe(seeds.meetingId);
  });

  it("idempotent: second call does NOT duplicate the task_chain notification", async () => {
    // createTaskChain will insert more tasks (no guard) but the notification
    // must NOT be duplicated (upsert with ignoreDuplicates on reference_key).
    await createTaskChain(seeds.meetingId);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM notifications WHERE reference_key = $1`,
      [`task_chain:${seeds.meetingId}`],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

describe("operations.service — createTaskChain with assigned_handler_id override", () => {
  let staffId: string;
  let handlerId: string;
  let clientId: string;
  let meetingId: string;

  beforeAll(async () => {
    staffId = randomUUID();
    handlerId = randomUUID();
    clientId = randomUUID();
    meetingId = randomUUID();

    await pool.query(
      `INSERT INTO staff (id, full_name, email, role, is_active) VALUES ($1, $2, $3, 'agent', true)`,
      [staffId, "TC Base Agent", `tc-base-${staffId}@test.example`],
    );
    await pool.query(
      `INSERT INTO staff (id, full_name, email, role, is_active) VALUES ($1, $2, $3, 'agent', true)`,
      [handlerId, "TC Handler", `tc-handler-${handlerId}@test.example`],
    );
    await pool.query(
      `INSERT INTO clients
         (id, full_name, phone, inquiry_type, status, assigned_to,
          assigned_handler_id, source_channel, id_validated)
       VALUES ($1, $2, $3, 'health', 'active', $4, $5, 'wa', false)`,
      [clientId, "TC Handler Client", `0501${staffId.slice(0, 6)}`, staffId, handlerId],
    );
    await pool.query(
      `INSERT INTO meetings
         (id, client_id, type, scheduled_at, status, summary_status, client_confirmed)
       VALUES ($1, $2, 'phone', now() - interval '1 day', 'done', 'approved', true)`,
      [meetingId, clientId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM notifications WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM tasks WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM meetings WHERE id = $1`, [meetingId]);
    await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
    await pool.query(`DELETE FROM staff WHERE id = $1`, [handlerId]);
    await pool.query(`DELETE FROM staff WHERE id = $1`, [staffId]);
  });

  it("prefers assigned_handler_id over assigned_to", async () => {
    await createTaskChain(meetingId);

    const { rows } = await pool.query<{ assigned_to: string }>(
      `SELECT DISTINCT assigned_to FROM tasks WHERE meeting_id = $1`,
      [meetingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assigned_to).toBe(handlerId);
  });
});
