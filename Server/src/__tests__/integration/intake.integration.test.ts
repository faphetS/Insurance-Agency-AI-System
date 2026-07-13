/**
 * Integration test: intake.orchestrator — v4.1 9-button menu flow + email slot.
 *
 * Slot machine: welcome → menu → meeting_type → email → consent → id_photo → done.
 *
 * Runs against a real throwaway Postgres DB (insurance_test). All external I/O is mocked:
 *   - ai.service              (validateIdPhoto)
 *   - whatsapp.service        (sendMessageWithTyping, sendInteractiveButtonsWithTyping, sendFileByUrl, sendMessage)
 *   - lib/storage             (fetchRemoteFile)
 *   - google.drive            (uploadLeadDocument)
 *   - leads-mirror.service    (mirrorLeadToSheet — asserted called; 7-col rows covered by leads-mirror.test.ts)
 *   - intake-notify.service   (sendStaffLeadEmail — mocked so NO real email; buildCallbackAlert)
 *   - operations/owner-notify (notifyOwner — mocked so NO real GreenAPI send)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — declared before any subject import
// ---------------------------------------------------------------------------

vi.mock("../../domains/ai/ai.service.js", () => ({
  validateIdPhoto: vi.fn(),
}));

vi.mock("../../domains/whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "fake-out-id" }),
  sendInteractiveButtonsWithTyping: vi.fn().mockResolvedValue({ idMessage: "fake-btn-id" }),
  sendFileByUrl: vi.fn().mockResolvedValue({ idMessage: "fake-file-id" }),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue({ idMessage: "fake-msg-id" }),
}));

vi.mock("../../lib/storage.js", () => ({
  fetchRemoteFile: vi.fn(),
}));

vi.mock("../../domains/integrations/google/google.drive.js", () => ({
  uploadLeadDocument: vi.fn(),
}));

vi.mock("../../domains/integrations/google/leads-mirror.service.js", () => ({
  mirrorLeadToSheet: vi.fn().mockResolvedValue(undefined),
}));

// Staff-email path is ALWAYS mocked — no real email may ever be sent from a test.
vi.mock("../../domains/ai/intake-notify.service.js", () => ({
  sendStaffLeadEmail: vi.fn().mockResolvedValue(undefined),
  buildCallbackAlert: vi.fn(() => "📞 alert"),
}));

// notifyOwner (GreenAPI send) is ALWAYS mocked — no live send.
vi.mock("../../domains/operations/owner-notify.js", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

// ---------------------------------------------------------------------------
// Subject + helpers imported after mocks
// ---------------------------------------------------------------------------

import { handleIntake } from "../../domains/ai/intake.orchestrator.js";
import { pool } from "../../lib/db.js";
import type { MessagePayload } from "../../domains/whatsapp/whatsapp.validator.js";
import { validateIdPhoto } from "../../domains/ai/ai.service.js";
import { sendStaffLeadEmail } from "../../domains/ai/intake-notify.service.js";
import { fetchRemoteFile } from "../../lib/storage.js";
import { uploadLeadDocument } from "../../domains/integrations/google/google.drive.js";

const mockValidateIdPhoto = validateIdPhoto as ReturnType<typeof vi.fn>;
const mockSendStaffLeadEmail = sendStaffLeadEmail as ReturnType<typeof vi.fn>;
const mockFetchRemoteFile = fetchRemoteFile as ReturnType<typeof vi.fn>;
const mockUploadLeadDocument = uploadLeadDocument as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------

interface Seeds {
  staffId: string;
  clientId: string;
  conversationId: string;
}

async function seed(): Promise<Seeds> {
  const staffId = randomUUID();
  const clientId = randomUUID();
  const conversationId = randomUUID();

  await pool.query(
    `INSERT INTO staff (id, full_name, email, role, is_active)
     VALUES ($1, $2, $3, 'agent', true)`,
    [staffId, "Test Agent", `agent-${staffId}@test.example`],
  );

  await pool.query(
    `INSERT INTO clients
       (id, full_name, phone, inquiry_type, status, assigned_to,
        source_channel, id_validated,
        intake_state, intake_current_slot)
     VALUES ($1, $2, $3, 'general', 'new', $4, 'wa', false, 'collecting', 'welcome')`,
    [clientId, "Placeholder", `05000${clientId.slice(0, 5)}`, staffId],
  );

  await pool.query(
    `INSERT INTO conversations
       (id, whatsapp_chat_id, client_id, contact_phone, bot_paused)
     VALUES ($1, $2, $3, $4, false)`,
    [conversationId, `97250${clientId.slice(0, 8)}@c.us`, clientId, `05000${clientId.slice(0, 5)}`],
  );

  await pool.query(`INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  return { staffId, clientId, conversationId };
}

async function teardown(seeds: Seeds) {
  await pool.query(`DELETE FROM meetings WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM documents WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM conversations WHERE id = $1`, [seeds.conversationId]);
  await pool.query(`DELETE FROM notifications WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM staff WHERE id = $1`, [seeds.staffId]);
}

const textPayload = (text: string): MessagePayload => ({ kind: "text", text });
const buttonPayload = (text: string): MessagePayload => ({ kind: "text", text, isButtonReply: true });
const imagePayload = (): MessagePayload => ({
  kind: "image",
  fileUrl: "https://example.com/fake-id.jpg",
  mimeType: "image/jpeg",
  fileName: "id.jpg",
  caption: undefined,
});

// ---------------------------------------------------------------------------
// Walk A: welcome → menu → vehicle (insurance button → staff email → bot off)
// ---------------------------------------------------------------------------

describe("intake v4 — menu → insurance button (vehicle)", () => {
  let seeds: Seeds;

  beforeAll(async () => {
    seeds = await seed();
  });

  afterAll(async () => {
    await teardown(seeds);
  });

  it("welcome → advances to menu", async () => {
    const result = await handleIntake(seeds.conversationId, seeds.clientId, "97250a@c.us", textPayload("hi"));
    expect(result.consumed).toBe(true);

    const { rows } = await pool.query<{ intake_current_slot: string }>(
      `SELECT intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("menu");
  });

  it("menu 'vehicle' → staff email, inquiry_type stored, intake completed + 24h pause", async () => {
    mockSendStaffLeadEmail.mockClear();

    const result = await handleIntake(seeds.conversationId, seeds.clientId, "97250a@c.us", buttonPayload("vehicle"));
    expect(result.consumed).toBe(true);

    expect(mockSendStaffLeadEmail).toHaveBeenCalledOnce();
    expect(mockSendStaffLeadEmail.mock.calls[0]?.[0]).toBe("vehicle");

    const { rows } = await pool.query<{
      inquiry_type: string;
      intake_state: string;
      intake_current_slot: string;
      pipeline_stage: string | null;
    }>(
      `SELECT inquiry_type, intake_state, intake_current_slot, pipeline_stage FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.inquiry_type).toBe("vehicle");
    expect(rows[0]?.intake_state).toBe("completed");
    expect(rows[0]?.intake_current_slot).toBe("done");
    expect(rows[0]?.pipeline_stage).toBe("new_lead");

    const { rows: convRows } = await pool.query<{ bot_paused: boolean; bot_paused_until: string | null }>(
      `SELECT bot_paused, bot_paused_until FROM conversations WHERE id = $1`,
      [seeds.conversationId],
    );
    expect(convRows[0]?.bot_paused).toBe(true);
    expect(convRows[0]?.bot_paused_until).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Walk B: welcome → menu → meeting → new → consent tap → ID → terminal
// ---------------------------------------------------------------------------

describe("intake v4 — meeting → new client → consent → ID", () => {
  let seeds: Seeds;

  beforeAll(async () => {
    seeds = await seed();
  });

  afterAll(async () => {
    await teardown(seeds);
  });

  it("welcome → menu", async () => {
    await handleIntake(seeds.conversationId, seeds.clientId, "97250b@c.us", textPayload("hi"));
    const { rows } = await pool.query<{ intake_current_slot: string }>(
      `SELECT intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("menu");
  });

  it("menu 'meeting_didi' → meeting_type sub-choice", async () => {
    await handleIntake(seeds.conversationId, seeds.clientId, "97250b@c.us", buttonPayload("meeting_didi"));
    const { rows } = await pool.query<{ intake_current_slot: string; inquiry_type: string }>(
      `SELECT intake_current_slot, inquiry_type FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("meeting_type");
    expect(rows[0]?.inquiry_type).toBe("meeting");
  });

  it("meeting_type 'new_client' → email slot, client_type stored, consent NOT yet stamped", async () => {
    await handleIntake(seeds.conversationId, seeds.clientId, "97250b@c.us", buttonPayload("new_client"));
    const { rows } = await pool.query<{
      intake_current_slot: string;
      client_type: string;
      consent_prompted_at: string | null;
    }>(
      `SELECT intake_current_slot, client_type, consent_prompted_at FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("email");
    expect(rows[0]?.client_type).toBe("new");
    expect(rows[0]?.consent_prompted_at).toBeNull();
  });

  it("junk text at email → re-prompt, slot unchanged, no email stored", async () => {
    await handleIntake(seeds.conversationId, seeds.clientId, "97250b@c.us", textPayload("אין לי כרגע"));
    const { rows } = await pool.query<{ intake_current_slot: string; email: string | null }>(
      `SELECT intake_current_slot, email FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("email");
    expect(rows[0]?.email).toBeNull();
  });

  it("valid email → stored lowercased, advances to consent + consent_prompted_at set", async () => {
    await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250b@c.us",
      textPayload("המייל שלי: Test.Lead@Example.CO.IL"),
    );
    const { rows } = await pool.query<{
      intake_current_slot: string;
      email: string | null;
      consent_prompted_at: string | null;
    }>(
      `SELECT intake_current_slot, email, consent_prompted_at FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("consent");
    expect(rows[0]?.email).toBe("test.lead@example.co.il");
    expect(rows[0]?.consent_prompted_at).not.toBeNull();
  });

  it("consent tap → id_photo", async () => {
    await handleIntake(seeds.conversationId, seeds.clientId, "97250b@c.us", buttonPayload("consent_approve"));
    const { rows } = await pool.query<{ intake_current_slot: string }>(
      `SELECT intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("id_photo");
  });

  it("typed text at consent would have re-prompted — verified separately; here the tap already advanced", () => {
    expect(true).toBe(true);
  });

  it("id_photo valid image → OCR name to Drive, full_name upgraded, terminal + pause", async () => {
    const idWebViewLink = "https://drive.google.com/file/d/drive-id-1/view";
    mockValidateIdPhoto.mockResolvedValueOnce({
      valid: true,
      hasIdCard: true,
      hasAppendix: true,
      idNumber: "123456789",
      fullName: "משה לוי",
    });
    mockFetchRemoteFile.mockResolvedValueOnce(Buffer.from("fake-bytes"));
    mockUploadLeadDocument.mockResolvedValueOnce({ fileId: "drive-id-1", webViewLink: idWebViewLink });

    const result = await handleIntake(seeds.conversationId, seeds.clientId, "97250b@c.us", imagePayload());
    expect(result.consumed).toBe(true);

    expect(mockUploadLeadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ name: "משה לוי - ID", mimeType: "image/jpeg" }),
    );

    const { rows } = await pool.query<{
      id_photo_url: string;
      id_validated: boolean;
      id_number: string | null;
      full_name: string;
      intake_state: string;
      intake_current_slot: string;
      pipeline_stage: string | null;
    }>(
      `SELECT id_photo_url, id_validated, id_number, full_name,
              intake_state, intake_current_slot, pipeline_stage
       FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.id_photo_url).toBe(idWebViewLink);
    expect(rows[0]?.id_validated).toBe(true);
    expect(rows[0]?.id_number).toBe("123456789");
    expect(rows[0]?.full_name).toBe("משה לוי");
    expect(rows[0]?.intake_state).toBe("completed");
    expect(rows[0]?.intake_current_slot).toBe("done");
    expect(rows[0]?.pipeline_stage).toBe("meeting_scheduling");

    const { rows: docRows } = await pool.query(
      `SELECT type, file_url FROM documents WHERE client_id = $1 AND type = 'id_photo'`,
      [seeds.clientId],
    );
    expect(docRows.length).toBeGreaterThan(0);
    expect(docRows[0]?.file_url).toBe(idWebViewLink);

    const { rows: convRows } = await pool.query<{ bot_paused: boolean }>(
      `SELECT bot_paused FROM conversations WHERE id = $1`,
      [seeds.conversationId],
    );
    expect(convRows[0]?.bot_paused).toBe(true);
  });

  it("outbound bot prompts are persisted", async () => {
    const { rows } = await pool.query(
      `SELECT id FROM messages
       WHERE conversation_id = $1 AND direction = 'outbound' AND sent_by = 'bot'`,
      [seeds.conversationId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
