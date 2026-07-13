/**
 * Integration test: booking-sync.service — email-only matching + thank-you (v4.1)
 *
 * Seeds a client in meeting_scheduling stage whose email was stored LOWERCASED
 * by the intake email slot, then mocks the Google Calendar wrapper to return one
 * synthetic event whose attendee email is MIXED-CASE (proving the matcher
 * lowercases before comparing). Runs syncNewBookings() and asserts:
 *   - Exactly one meetings row is INSERTED for the calendar_event_id
 *     (status='scheduled', type, scheduled_at, client_id, conversation_id).
 *   - client.pipeline_stage advances to 'meeting_scheduled'.
 *   - The WhatsApp thank-you (mocked sendMessageWithTyping) uses the new v4.1
 *     copy and no longer promises a reminder (reminders stay disabled).
 *   - A message row is persisted for the outbound thank-you.
 *   - Re-running does not duplicate the meeting or re-send.
 *   - No real Google or WhatsApp I/O occurred.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — before any subject import
// ---------------------------------------------------------------------------

vi.mock("../../domains/whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "confirm-msg-id" }),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue({ idMessage: "fake-id" }),
  sendInteractiveButtonsWithTyping: vi.fn().mockResolvedValue({ idMessage: "fake-btn-id" }),
}));

// Mock calendar.service (getRecentEvents) to return a synthetic event
vi.mock("../../domains/calendar/calendar.service.js", () => ({
  getRecentEvents: vi.fn(),
}));

// Mock calendar.auth (getAuthenticatedClient) so no real OAuth happens
vi.mock("../../domains/calendar/calendar.auth.js", () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({ /* opaque oauth client */ }),
}));

// ---------------------------------------------------------------------------
// Subject + helpers imported after mocks
// ---------------------------------------------------------------------------

import { syncNewBookings } from "../../domains/calendar/booking-sync.service.js";
import { pool } from "../../lib/db.js";
import { getRecentEvents } from "../../domains/calendar/calendar.service.js";
import { sendMessageWithTyping } from "../../domains/whatsapp/whatsapp.service.js";

const mockGetRecentEvents = getRecentEvents as ReturnType<typeof vi.fn>;
const mockSendMsg = sendMessageWithTyping as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Seed / teardown helpers
// ---------------------------------------------------------------------------

interface Seeds {
  staffId: string;
  clientId: string;
  conversationId: string;
  eventId: string;
  scheduledAt: string;
  chatId: string;
}

async function seed(): Promise<Seeds> {
  const staffId = randomUUID();
  const clientId = randomUUID();
  const conversationId = randomUUID();
  const eventId = `gcal_evt_${randomUUID()}`;
  const chatId = `9725011${clientId.slice(0, 6)}@c.us`;

  // 2 days from now — well within any upcoming-event window
  const scheduledAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  await pool.query(
    `INSERT INTO staff (id, full_name, email, role, is_active)
     VALUES ($1, $2, $3, 'agent', true)`,
    [staffId, "Booking Agent", `booking-${staffId}@test.example`],
  );

  // email is lowercase — exactly how the intake email slot stores it.
  await pool.query(
    `INSERT INTO clients
       (id, full_name, phone, email, inquiry_type, status, assigned_to,
        source_channel, id_validated, pipeline_stage,
        intake_state, intake_current_slot, intake_completed_at)
     VALUES ($1, $2, $3, $4, 'health', 'active', $5,
             'wa', true, 'meeting_scheduling',
             'completed', 'done', now())`,
    [clientId, "Booking Test Lead", "0501234999", "booklead@example.com", staffId],
  );

  await pool.query(
    `INSERT INTO conversations
       (id, whatsapp_chat_id, client_id, contact_phone, bot_paused)
     VALUES ($1, $2, $3, $4, true)`,
    [conversationId, chatId, clientId, "0501234999"],
  );

  // Ensure bot_settings singleton exists
  await pool.query(`INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // Ensure last-sync system_setting exists (far in the past so all events qualify)
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ('google_calendar_last_sync', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()],
  );

  return { staffId, clientId, conversationId, eventId, scheduledAt, chatId };
}

async function teardown(seeds: Seeds) {
  await pool.query(`DELETE FROM messages WHERE conversation_id = $1`, [seeds.conversationId]);
  await pool.query(`DELETE FROM meetings WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM conversations WHERE id = $1`, [seeds.conversationId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM staff WHERE id = $1`, [seeds.staffId]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncNewBookings — email-only match", () => {
  let seeds: Seeds;

  beforeAll(async () => {
    seeds = await seed();

    // Synthetic Google Calendar event — attendee email deliberately MIXED-CASE
    // while the seeded client email is lowercase (case-insensitive matching).
    const syntheticEvent = {
      id: seeds.eventId,
      summary: "Insurance consultation",
      created: new Date().toISOString(),
      start: { dateTime: seeds.scheduledAt },
      attendees: [
        { email: "BookLead@Example.com", displayName: "Booking Test Lead", self: false },
        { email: "agent@agency.example", displayName: "Agent", self: true },
      ],
    };

    mockGetRecentEvents.mockResolvedValue([syntheticEvent]);
    mockSendMsg.mockResolvedValue({ idMessage: "confirm-msg-id" });

    await syncNewBookings();
  });

  afterAll(async () => {
    await teardown(seeds);
    // pool is a shared module singleton across test files — do not end it here
  });

  it("inserts exactly one scheduled meetings row for the calendar event", async () => {
    const { rows } = await pool.query<{
      client_id: string;
      conversation_id: string | null;
      status: string;
      scheduled_at: string;
      type: string;
    }>(
      `SELECT client_id, conversation_id, status, scheduled_at, type
       FROM meetings WHERE calendar_event_id = $1`,
      [seeds.eventId],
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.client_id).toBe(seeds.clientId);
    expect(rows[0]?.conversation_id).toBe(seeds.conversationId);
    expect(rows[0]?.status).toBe("scheduled");
    expect(rows[0]?.type).toBe("google_meet");
    // scheduled_at should be within a second of the event's start.dateTime
    const diff = Math.abs(
      new Date(rows[0]!.scheduled_at).getTime() - new Date(seeds.scheduledAt).getTime(),
    );
    expect(diff).toBeLessThan(2000);
  });

  it("advances client pipeline_stage to meeting_scheduled", async () => {
    const { rows } = await pool.query<{ pipeline_stage: string }>(
      `SELECT pipeline_stage FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.pipeline_stage).toBe("meeting_scheduled");
  });

  it("sends the v4.1 thank-you to the conversation's chatId — no reminder promise", async () => {
    expect(mockSendMsg).toHaveBeenCalled();

    const [calledChatId, calledMsg] = mockSendMsg.mock.calls[0] as [string, string];
    expect(calledChatId).toBe(seeds.chatId);
    expect(calledMsg).toContain("תודה! הפגישה נקבעה בהצלחה לתאריך");
    expect(calledMsg).toContain("נתראה בפגישה.");
    // The old copy promised a reminder — the 24h/1h reminder loops stay OFF.
    expect(calledMsg).not.toMatch(/תזכורת/);
  });

  it("persists an outbound message row for the thank-you", async () => {
    const { rows } = await pool.query(
      `SELECT direction, sent_by, status
       FROM messages
       WHERE conversation_id = $1
         AND direction = 'outbound'
         AND sent_by = 'bot'`,
      [seeds.conversationId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.status).toBe("sent");
  });

  it("does not duplicate the meeting when syncNewBookings is run again", async () => {
    // Running again — the event is already tracked (calendar_event_id matches)
    const callsBefore = mockSendMsg.mock.calls.length;
    await syncNewBookings();
    // No additional send calls — the `existing` check prevents re-processing
    expect(mockSendMsg.mock.calls.length).toBe(callsBefore);

    const { rows } = await pool.query(
      `SELECT id FROM meetings WHERE calendar_event_id = $1`,
      [seeds.eventId],
    );
    expect(rows.length).toBe(1);
  });
});

describe("syncNewBookings — no matching client produces no meeting row", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('google_calendar_last_sync', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [new Date(Date.now() - 60 * 60 * 1000).toISOString()],
    );
  });

  it("skips an event with no matching client email", async () => {
    const unknownEventId = `gcal_unknown_${randomUUID()}`;
    mockGetRecentEvents.mockResolvedValue([
      {
        id: unknownEventId,
        summary: "Unrelated meeting",
        created: new Date().toISOString(),
        start: { dateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },
        attendees: [
          { email: "nobody@unknown-domain.example", self: false },
        ],
      },
    ]);
    mockSendMsg.mockClear();

    await syncNewBookings();

    const { rows } = await pool.query(
      `SELECT id FROM meetings WHERE calendar_event_id = $1`,
      [unknownEventId],
    );
    expect(rows.length).toBe(0);
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});
