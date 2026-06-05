/**
 * Integration test: reminder.service — 24h / 1h reminder windows
 *
 * The EXACT window logic from checkAndSendReminders():
 *
 *   24h window:
 *     status='scheduled', reminder_24h_sent=false
 *     scheduled_at >= now  AND  scheduled_at <= (now + 25h)
 *
 *   1h window:
 *     status='scheduled', reminder_1h_sent=false
 *     scheduled_at >= now  AND  scheduled_at <= (now + 90min)
 *
 * Three meetings are seeded:
 *   A — in 20h  → 24h window only (inside 25h, outside 90min)
 *   B — in 45min → 1h window only  (inside 90min, inside 25h but
 *                                    reminder_24h_sent=true to isolate)
 *   C — in 30h  → control          (outside 25h window entirely)
 *
 * WhatsApp send is mocked. After running checkAndSendReminders():
 *   - Meeting A: reminder_24h_sent flips to true, send called once
 *   - Meeting B: reminder_1h_sent flips to true, send called once
 *   - Meeting C: neither flag changes, send NOT called for it
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — before any subject import
// ---------------------------------------------------------------------------

vi.mock("../../domains/whatsapp/whatsapp.service.js", () => ({
  // Return a UNIQUE idMessage per call — real GreenAPI does, and the messages
  // table has a UNIQUE index on whatsapp_message_id.
  sendMessageWithTyping: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `rem-${Math.random().toString(36).slice(2)}` })),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `msg-${Math.random().toString(36).slice(2)}` })),
  sendInteractiveButtonsWithTyping: vi.fn().mockResolvedValue({ idMessage: "fake-btn-id" }),
}));

// ---------------------------------------------------------------------------
// Subject + helpers imported after mocks
// ---------------------------------------------------------------------------

import { checkAndSendReminders } from "../../domains/calendar/reminder.service.js";
import { pool } from "../../lib/db.js";
import { sendMessageWithTyping } from "../../domains/whatsapp/whatsapp.service.js";

const mockSendMsg = sendMessageWithTyping as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Seed / teardown helpers
// ---------------------------------------------------------------------------

interface MeetingSeeds {
  staffId: string;
  clientId: string;
  conversationId: string;
  meetingIdA: string; // 24h window
  meetingIdB: string; // 1h window
  meetingIdC: string; // control (outside both windows)
  chatId: string;
}

async function seed(): Promise<MeetingSeeds> {
  const staffId = randomUUID();
  const clientId = randomUUID();
  const conversationId = randomUUID();
  const meetingIdA = randomUUID();
  const meetingIdB = randomUUID();
  const meetingIdC = randomUUID();
  const chatId = `972507${clientId.slice(0, 7)}@c.us`;

  const now = Date.now();
  // A — 20 hours from now: inside the 25h window, outside the 90min window
  const scheduledAtA = new Date(now + 20 * 60 * 60 * 1000).toISOString();
  // B — 45 minutes from now: inside both windows, but we seed reminder_24h_sent=true
  // so only the 1h reminder fires
  const scheduledAtB = new Date(now + 45 * 60 * 1000).toISOString();
  // C — 30 hours from now: outside the 25h window
  const scheduledAtC = new Date(now + 30 * 60 * 60 * 1000).toISOString();

  await pool.query(
    `INSERT INTO staff (id, full_name, email, role, is_active)
     VALUES ($1, $2, $3, 'agent', true)`,
    [staffId, "Reminder Agent", `reminder-${staffId}@test.example`],
  );

  await pool.query(
    `INSERT INTO clients
       (id, full_name, phone, inquiry_type, status, assigned_to,
        source_channel, id_validated,
        intake_state, intake_current_slot)
     VALUES ($1, $2, $3, 'vehicle', 'active', $4, 'wa', false, 'completed', 'done')`,
    [clientId, "Reminder Client", `0502${clientId.slice(0, 6)}`, staffId],
  );

  await pool.query(
    `INSERT INTO conversations
       (id, whatsapp_chat_id, client_id, contact_phone, bot_paused)
     VALUES ($1, $2, $3, $4, false)`,
    [conversationId, chatId, clientId, `0502${clientId.slice(0, 6)}`],
  );

  // Meeting A — 24h window target
  await pool.query(
    `INSERT INTO meetings
       (id, client_id, conversation_id, type, scheduled_at, status,
        reminder_24h_sent, reminder_1h_sent, created_at, updated_at)
     VALUES ($1, $2, $3, 'google_meet', $4, 'scheduled', false, false, now(), now())`,
    [meetingIdA, clientId, conversationId, scheduledAtA],
  );

  // Meeting B — 1h window target (24h already sent to isolate)
  await pool.query(
    `INSERT INTO meetings
       (id, client_id, conversation_id, type, scheduled_at, status,
        reminder_24h_sent, reminder_1h_sent, created_at, updated_at)
     VALUES ($1, $2, $3, 'google_meet', $4, 'scheduled', true, false, now(), now())`,
    [meetingIdB, clientId, conversationId, scheduledAtB],
  );

  // Meeting C — control, outside both windows
  await pool.query(
    `INSERT INTO meetings
       (id, client_id, conversation_id, type, scheduled_at, status,
        reminder_24h_sent, reminder_1h_sent, created_at, updated_at)
     VALUES ($1, $2, $3, 'google_meet', $4, 'scheduled', false, false, now(), now())`,
    [meetingIdC, clientId, conversationId, scheduledAtC],
  );

  return { staffId, clientId, conversationId, meetingIdA, meetingIdB, meetingIdC, chatId };
}

async function teardown(seeds: MeetingSeeds) {
  await pool.query(`DELETE FROM messages WHERE conversation_id = $1`, [seeds.conversationId]);
  await pool.query(
    `DELETE FROM meetings WHERE id IN ($1, $2, $3)`,
    [seeds.meetingIdA, seeds.meetingIdB, seeds.meetingIdC],
  );
  await pool.query(`DELETE FROM conversations WHERE id = $1`, [seeds.conversationId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM staff WHERE id = $1`, [seeds.staffId]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkAndSendReminders — window targeting", () => {
  let seeds: MeetingSeeds;

  beforeAll(async () => {
    seeds = await seed();
    mockSendMsg.mockClear();
    await checkAndSendReminders();
  });

  afterAll(async () => {
    await teardown(seeds);
    // pool is a shared module singleton across test files — do not end it here
  });

  it("meeting A (20h away): reminder_24h_sent flips to true", async () => {
    const { rows } = await pool.query<{
      reminder_24h_sent: boolean;
      reminder_1h_sent: boolean;
    }>(
      `SELECT reminder_24h_sent, reminder_1h_sent FROM meetings WHERE id = $1`,
      [seeds.meetingIdA],
    );
    expect(rows[0]?.reminder_24h_sent).toBe(true);
    // 1h reminder must not have fired (meeting is 20h away, outside 90min window)
    expect(rows[0]?.reminder_1h_sent).toBe(false);
  });

  it("meeting B (45min away): reminder_1h_sent flips to true", async () => {
    const { rows } = await pool.query<{
      reminder_24h_sent: boolean;
      reminder_1h_sent: boolean;
    }>(
      `SELECT reminder_24h_sent, reminder_1h_sent FROM meetings WHERE id = $1`,
      [seeds.meetingIdB],
    );
    expect(rows[0]?.reminder_1h_sent).toBe(true);
    // 24h flag was already true at seed time — should remain true
    expect(rows[0]?.reminder_24h_sent).toBe(true);
  });

  it("meeting C (30h away): neither reminder flag changes", async () => {
    const { rows } = await pool.query<{
      reminder_24h_sent: boolean;
      reminder_1h_sent: boolean;
    }>(
      `SELECT reminder_24h_sent, reminder_1h_sent FROM meetings WHERE id = $1`,
      [seeds.meetingIdC],
    );
    expect(rows[0]?.reminder_24h_sent).toBe(false);
    expect(rows[0]?.reminder_1h_sent).toBe(false);
  });

  it("sendMessageWithTyping was called exactly twice (once per in-window meeting)", () => {
    // A triggers 24h reminder, B triggers 1h reminder, C is outside both windows
    expect(mockSendMsg).toHaveBeenCalledTimes(2);
  });

  it("both sends targeted the correct chatId", () => {
    const chatIds = mockSendMsg.mock.calls.map((args: unknown[]) => args[0] as string);
    expect(chatIds.every((cid) => cid === seeds.chatId)).toBe(true);
  });

  it("24h reminder message contains the Hebrew 'תזכורת' keyword", () => {
    const messages = mockSendMsg.mock.calls.map((args: unknown[]) => args[1] as string);
    expect(messages.some((m) => m.includes("תזכורת"))).toBe(true);
  });

  it("outbound reminder message rows are persisted for both fired reminders", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE conversation_id = $1
         AND direction = 'outbound'
         AND sent_by = 'bot'`,
      [seeds.conversationId],
    );
    // At least 2 reminder messages were inserted (A and B)
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("checkAndSendReminders — idempotency (flags already set)", () => {
  let seeds: MeetingSeeds;

  beforeAll(async () => {
    seeds = await seed();
    // Pre-flip both flags on all meetings so no reminders should fire
    await pool.query(
      `UPDATE meetings
       SET reminder_24h_sent = true, reminder_1h_sent = true
       WHERE id IN ($1, $2, $3)`,
      [seeds.meetingIdA, seeds.meetingIdB, seeds.meetingIdC],
    );
    mockSendMsg.mockClear();
    await checkAndSendReminders();
  });

  afterAll(async () => {
    await teardown(seeds);
  });

  it("does not send any reminders when all flags are already set", () => {
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});

describe("checkAndSendReminders — only 'scheduled' status triggers reminders", () => {
  let seeds: MeetingSeeds;

  beforeAll(async () => {
    seeds = await seed();
    // Set meeting A to status='done' — reminder service filters on status='scheduled'
    await pool.query(
      `UPDATE meetings SET status = 'done' WHERE id = $1`,
      [seeds.meetingIdA],
    );
    // Set meeting B to status='cancelled'
    await pool.query(
      `UPDATE meetings SET status = 'cancelled' WHERE id = $1`,
      [seeds.meetingIdB],
    );
    mockSendMsg.mockClear();
    await checkAndSendReminders();
  });

  afterAll(async () => {
    await teardown(seeds);
  });

  it("sends no reminders for done/cancelled meetings even if in the time window", () => {
    // Meeting C (30h away, control) is still 'scheduled' but outside the 25h window.
    // A and B are in-window but wrong status.
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});
