/**
 * Integration test: operations.checker — checkDueAndOverdueTasks
 *
 * Seeds tasks with due_at in the past and future.
 * Mocks all external I/O (WhatsApp sends, milestone stubs, AI cross-check, storage).
 * Asserts:
 *   - Tasks with due_at in the future are NOT processed (no reminder, no status change)
 *   - Past-due task (not yet overdue by >3 days): reminder_sent flips to true,
 *     status stays 'pending', sendMessageWithTyping (notifyStaffTaskOverdue) called
 *   - Past-due task (>3 days overdue): status changes to 'overdue',
 *     a notification with reference_key `overdue:<taskId>` is created,
 *     sendOverdueAlert fires (sendMessageWithTyping called for staff)
 *   - milestoneProvider.checkForms returns { found: false } so tasks are NOT completed
 *   - checkSummaryApprovals: notifyStaffSummaryReady fires for draft meetings
 *   - checkServiceMeetingEligibility: service_due notification created for eligible client
 *
 * Mock targets:
 *   - whatsapp/whatsapp.service.js  (sendMessageWithTyping, sendInteractiveButtonsWithTyping)
 *   - domains/ai/ai.service.js      (generateReply — cross-check AI)
 *   - lib/storage.js                (getSignedDocUrl)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../domains/ai/ai.service.js", () => ({
  generateReply: vi.fn().mockResolvedValue("AI assessment mock"),
  classifyIntakeResponse: vi.fn(),
  analyzeImage: vi.fn(),
  classifyComplexity: vi.fn(),
}));

vi.mock("../../lib/storage.js", () => ({
  getSignedDocUrl: vi.fn().mockResolvedValue(null),
  persistRemoteFile: vi.fn().mockResolvedValue("fake/path.jpg"),
  extFor: vi.fn().mockReturnValue("jpg"),
}));

// ---------------------------------------------------------------------------
// Subject + helpers
// ---------------------------------------------------------------------------

import {
  checkDueAndOverdueTasks,
  checkSummaryApprovals,
  checkServiceMeetingEligibility,
} from "../../domains/operations/operations.checker.js";
import { pool } from "../../lib/db.js";
import {
  sendMessageWithTyping,
  sendInteractiveButtonsWithTyping,
} from "../../domains/whatsapp/whatsapp.service.js";

const mockSendMsg = sendMessageWithTyping as ReturnType<typeof vi.fn>;
const mockSendButtons = sendInteractiveButtonsWithTyping as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface BaseSeeds {
  staffId: string;
  clientId: string;
}

async function seedBase(overrides?: { phone?: string }): Promise<BaseSeeds> {
  const staffId = randomUUID();
  const clientId = randomUUID();
  // Must be a valid number toChatId() accepts (>=11 digits after normalizing).
  // A UUID slice contains letters that get stripped to too few digits, so build
  // a real 10-digit Israeli mobile (05X-XXXXXXX) from random digits.
  const staffPhone =
    overrides?.phone ?? `05${Math.floor(10000000 + Math.random() * 89999999)}`;

  await pool.query(
    `INSERT INTO staff (id, full_name, email, phone, role, is_active)
     VALUES ($1, $2, $3, $4, 'agent', true)`,
    [staffId, "Checker Agent", `checker-${staffId}@test.example`, staffPhone],
  );

  await pool.query(
    `INSERT INTO clients
       (id, full_name, phone, inquiry_type, status, assigned_to, source_channel, id_validated)
     VALUES ($1, $2, $3, 'health', 'active', $4, 'wa', false)`,
    [clientId, "Checker Client", `0502${staffId.slice(0, 6)}`, staffId],
  );

  return { staffId, clientId };
}

async function teardownBase(seeds: BaseSeeds, extraMeetingIds: string[] = []) {
  for (const mid of extraMeetingIds) {
    await pool.query(`DELETE FROM tasks WHERE meeting_id = $1`, [mid]);
  }
  await pool.query(`DELETE FROM notifications WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM tasks WHERE client_id = $1`, [seeds.clientId]);
  // meetings FK to conversations is RESTRICT — delete meetings before conversations
  await pool.query(`DELETE FROM meetings WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM staff WHERE id = $1`, [seeds.staffId]);
}

async function insertTask(
  clientId: string,
  staffId: string,
  opts: {
    type?: string;
    dueAt: Date;
    status?: string;
    reminderSent?: boolean;
    meetingId?: string;
  },
): Promise<string> {
  const taskId = randomUUID();
  await pool.query(
    `INSERT INTO tasks
       (id, client_id, meeting_id, type, description, assigned_to,
        due_at, status, reminder_sent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      taskId,
      clientId,
      opts.meetingId ?? null,
      opts.type ?? "forms_check",
      "Test task",
      staffId,
      opts.dueAt.toISOString(),
      opts.status ?? "pending",
      opts.reminderSent ?? false,
    ],
  );
  return taskId;
}

// ---------------------------------------------------------------------------
// Tests: future tasks are not touched
// ---------------------------------------------------------------------------

describe("checkDueAndOverdueTasks — future tasks ignored", () => {
  let seeds: BaseSeeds;
  let futureTaskId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    seeds = await seedBase();
    // Due in 7 days — should not be processed
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    futureTaskId = await insertTask(seeds.clientId, seeds.staffId, { dueAt: futureDate });
  });

  afterEach(async () => {
    await teardownBase(seeds);
  });

  it("does not send a reminder for a task due in the future", async () => {
    await checkDueAndOverdueTasks();

    const { rows } = await pool.query<{ reminder_sent: boolean; status: string }>(
      `SELECT reminder_sent, status FROM tasks WHERE id = $1`,
      [futureTaskId],
    );
    expect(rows[0]!.reminder_sent).toBe(false);
    expect(rows[0]!.status).toBe("pending");
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: task just past due (< 3 days overdue) — reminder only
// ---------------------------------------------------------------------------

describe("checkDueAndOverdueTasks — recently past-due task (reminder_sent flip)", () => {
  let seeds: BaseSeeds;
  let taskId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    seeds = await seedBase();
    // Due 1 hour ago — past due but <= 3 days, so only reminder fires
    const recentPast = new Date(Date.now() - 60 * 60 * 1000);
    taskId = await insertTask(seeds.clientId, seeds.staffId, {
      dueAt: recentPast,
      type: "forms_check",
      reminderSent: false,
    });
  });

  afterEach(async () => {
    await teardownBase(seeds);
  });

  it("flips reminder_sent to true", async () => {
    await checkDueAndOverdueTasks();

    const { rows } = await pool.query<{ reminder_sent: boolean }>(
      `SELECT reminder_sent FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]!.reminder_sent).toBe(true);
  });

  it("does NOT change status to overdue", async () => {
    await checkDueAndOverdueTasks();

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]!.status).toBe("pending");
  });

  it("attempts to send a WhatsApp reminder to staff", async () => {
    await checkDueAndOverdueTasks();
    expect(mockSendMsg).toHaveBeenCalled();
  });

  it("does NOT create an overdue notification", async () => {
    await checkDueAndOverdueTasks();

    const { rows } = await pool.query(
      `SELECT id FROM notifications WHERE reference_key = $1`,
      [`overdue:${taskId}`],
    );
    expect(rows).toHaveLength(0);
  });

  it("second run does NOT re-send the reminder (reminder_sent already true)", async () => {
    await checkDueAndOverdueTasks();
    mockSendMsg.mockClear();
    await checkDueAndOverdueTasks();

    // task is still 'pending' so it's still fetched, but reminder_sent=true
    // means notifyStaffTaskOverdue is NOT called again
    const reminderSendCount = mockSendMsg.mock.calls.length;
    // sendOverdueAlert won't fire either (< 3d). So total sends = 0.
    expect(reminderSendCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: task >3 days overdue — status change + alert
// ---------------------------------------------------------------------------

describe("checkDueAndOverdueTasks — heavily overdue task (>3 days)", () => {
  let seeds: BaseSeeds;
  let taskId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    seeds = await seedBase();
    // Due 4 days ago — exceeds the 3-day overdue threshold
    const oldPast = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    taskId = await insertTask(seeds.clientId, seeds.staffId, {
      dueAt: oldPast,
      type: "receipt_check",
      reminderSent: false,
    });
  });

  afterEach(async () => {
    await teardownBase(seeds);
  });

  it("changes task status to 'overdue'", async () => {
    await checkDueAndOverdueTasks();

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]!.status).toBe("overdue");
  });

  it("creates an overdue notification with correct reference_key", async () => {
    await checkDueAndOverdueTasks();

    const { rows } = await pool.query<{ type: string; severity: string }>(
      `SELECT type, severity FROM notifications WHERE reference_key = $1`,
      [`overdue:${taskId}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("overdue_task");
    expect(rows[0]!.severity).toBe("urgent");
  });

  it("sends overdue alert via WhatsApp", async () => {
    await checkDueAndOverdueTasks();
    // Both reminder (notifyStaffTaskOverdue) and alert (sendOverdueAlert) fire
    expect(mockSendMsg.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT duplicate the overdue notification on re-run", async () => {
    await checkDueAndOverdueTasks();
    await checkDueAndOverdueTasks(); // task is now 'overdue', not 'pending' → skipped

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM notifications WHERE reference_key = $1`,
      [`overdue:${taskId}`],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: task with reminder already sent (skips re-send even on >3d overdue)
// ---------------------------------------------------------------------------

describe("checkDueAndOverdueTasks — reminder already sent flag respected", () => {
  let seeds: BaseSeeds;

  beforeEach(async () => {
    vi.clearAllMocks();
    seeds = await seedBase();
    const recentPast = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago, < 3d
    await insertTask(seeds.clientId, seeds.staffId, {
      dueAt: recentPast,
      type: "policy_check",
      reminderSent: true,
    });
  });

  afterEach(async () => {
    await teardownBase(seeds);
  });

  it("does not re-send reminder when reminder_sent is already true", async () => {
    await checkDueAndOverdueTasks();
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: checkSummaryApprovals — draft meeting triggers notification + staff notify
// ---------------------------------------------------------------------------

describe("checkSummaryApprovals — draft meeting with summary", () => {
  let seeds: BaseSeeds;
  let meetingId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    seeds = await seedBase();
    meetingId = randomUUID();

    await pool.query(
      `INSERT INTO meetings
         (id, client_id, type, scheduled_at, status, summary_status, summary_draft,
          client_confirmed, staff_summary_notified_at)
       VALUES ($1, $2, 'phone', now() - interval '1 hour', 'done', 'draft', $3, false, NULL)`,
      [meetingId, seeds.clientId, "טיוטת סיכום לדוגמה"],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM notifications WHERE meeting_id = $1`, [meetingId]);
    await pool.query(`DELETE FROM meetings WHERE id = $1`, [meetingId]);
    await teardownBase(seeds);
  });

  it("creates a summary_ready notification for the draft meeting", async () => {
    await checkSummaryApprovals();

    const { rows } = await pool.query<{ type: string; reference_key: string }>(
      `SELECT type, reference_key FROM notifications WHERE meeting_id = $1 AND type = 'summary_ready'`,
      [meetingId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.reference_key).toBe(`summary_ready:${meetingId}`);
  });

  it("attempts to notify staff via WhatsApp (interactive buttons)", async () => {
    await checkSummaryApprovals();
    // notifyStaffSummaryReady sends interactive buttons to staff
    expect(mockSendButtons).toHaveBeenCalled();
  });

  it("does NOT duplicate the summary_ready notification on re-run", async () => {
    await checkSummaryApprovals();
    await checkSummaryApprovals();

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM notifications WHERE reference_key = $1`,
      [`summary_ready:${meetingId}`],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: checkServiceMeetingEligibility — active client with no service date
// ---------------------------------------------------------------------------

describe("checkServiceMeetingEligibility — eligible client", () => {
  let seeds: BaseSeeds;
  const currentYear = new Date().getFullYear();

  beforeEach(async () => {
    vi.clearAllMocks();
    seeds = await seedBase();
    // last_service_date = NULL → eligible
    await pool.query(
      `UPDATE clients SET last_service_date = NULL WHERE id = $1`,
      [seeds.clientId],
    );
  });

  afterEach(async () => {
    await pool.query(
      `DELETE FROM notifications WHERE reference_key = $1`,
      [`service_due:${seeds.clientId}:${currentYear}`],
    );
    await teardownBase(seeds);
  });

  it("creates a service_due notification for eligible active client", async () => {
    await checkServiceMeetingEligibility();

    const { rows } = await pool.query<{ type: string; severity: string }>(
      `SELECT type, severity FROM notifications
       WHERE reference_key = $1`,
      [`service_due:${seeds.clientId}:${currentYear}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("service_due");
    expect(rows[0]!.severity).toBe("warning");
  });

  it("sends service-due invite to staff via WhatsApp", async () => {
    await checkServiceMeetingEligibility();
    expect(mockSendMsg).toHaveBeenCalled();
  });

  it("does NOT duplicate the notification on re-run", async () => {
    await checkServiceMeetingEligibility();
    await checkServiceMeetingEligibility();

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM notifications WHERE reference_key = $1`,
      [`service_due:${seeds.clientId}:${currentYear}`],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

describe("checkServiceMeetingEligibility — recently serviced client NOT eligible", () => {
  let seeds: BaseSeeds;
  const currentYear = new Date().getFullYear();

  beforeEach(async () => {
    vi.clearAllMocks();
    seeds = await seedBase();
    // last_service_date = 6 months ago → NOT eligible (< 24 months)
    await pool.query(
      `UPDATE clients SET last_service_date = (now() - interval '6 months')::date WHERE id = $1`,
      [seeds.clientId],
    );
  });

  afterEach(async () => {
    await pool.query(
      `DELETE FROM notifications WHERE reference_key = $1`,
      [`service_due:${seeds.clientId}:${currentYear}`],
    );
    await teardownBase(seeds);
  });

  it("does NOT create a service_due notification for recently serviced client", async () => {
    await checkServiceMeetingEligibility();

    const { rows } = await pool.query(
      `SELECT id FROM notifications WHERE reference_key = $1`,
      [`service_due:${seeds.clientId}:${currentYear}`],
    );
    expect(rows).toHaveLength(0);
  });

  it("does NOT send a WhatsApp invite for recently serviced client", async () => {
    await checkServiceMeetingEligibility();
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});
