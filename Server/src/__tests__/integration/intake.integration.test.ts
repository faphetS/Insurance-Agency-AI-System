/**
 * Integration test: intake.orchestrator — data collection flow
 *
 * Drives handleIntake() through all slots (welcome → full_name → email →
 * inquiry_type → id_photo → poa → done) against a real throwaway Postgres DB
 * (insurance_test). All external I/O is mocked:
 *   - ai.service  (classifyIntakeResponse, validateIdPhoto, classifyComplexity)
 *   - whatsapp.service (sendMessageWithTyping, sendInteractiveButtonsWithTyping)
 *   - lib/storage (fetchRemoteFile)
 *   - domains/integrations/google/google.drive (uploadLeadDocument)
 *   - domains/integrations/google/leads-mirror.service (mirrorLeadToSheet)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any subject import
// ---------------------------------------------------------------------------

vi.mock("../../domains/ai/ai.service.js", () => ({
  classifyIntakeResponse: vi.fn(),
  validateIdPhoto: vi.fn(),
  classifyComplexity: vi.fn(),
}));

vi.mock("../../domains/whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "fake-out-id" }),
  sendInteractiveButtonsWithTyping: vi.fn().mockResolvedValue({ idMessage: "fake-btn-id" }),
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

// ---------------------------------------------------------------------------
// Subject + helpers imported after mocks
// ---------------------------------------------------------------------------

import { handleIntake } from "../../domains/ai/intake.orchestrator.js";
import { pool } from "../../lib/db.js";
import type { MessagePayload } from "../../domains/whatsapp/whatsapp.validator.js";
import {
  classifyIntakeResponse,
  validateIdPhoto,
  classifyComplexity,
} from "../../domains/ai/ai.service.js";
import { sendMessageWithTyping } from "../../domains/whatsapp/whatsapp.service.js";
import { fetchRemoteFile } from "../../lib/storage.js";
import { uploadLeadDocument } from "../../domains/integrations/google/google.drive.js";

// ---------------------------------------------------------------------------
// Typed cast helpers for vi mocks
// ---------------------------------------------------------------------------

const mockClassify = classifyIntakeResponse as ReturnType<typeof vi.fn>;
const mockValidateIdPhoto = validateIdPhoto as ReturnType<typeof vi.fn>;
const mockClassifyComplexity = classifyComplexity as ReturnType<typeof vi.fn>;
const mockSendMsg = sendMessageWithTyping as ReturnType<typeof vi.fn>;
const mockFetchRemoteFile = fetchRemoteFile as ReturnType<typeof vi.fn>;
const mockUploadLeadDocument = uploadLeadDocument as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Seed / teardown helpers
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

  // Ensure bot_settings singleton exists
  await pool.query(
    `INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  );

  return { staffId, clientId, conversationId };
}

async function teardown(seeds: Seeds) {
  // meetings.conversation_id FKs conversations (RESTRICT), so delete meetings
  // BEFORE conversations. messages cascade from conversations.
  await pool.query(`DELETE FROM meetings WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM documents WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM conversations WHERE id = $1`, [seeds.conversationId]);
  await pool.query(`DELETE FROM notifications WHERE client_id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM clients WHERE id = $1`, [seeds.clientId]);
  await pool.query(`DELETE FROM staff WHERE id = $1`, [seeds.staffId]);
}

// ---------------------------------------------------------------------------
// Payload factories
// ---------------------------------------------------------------------------

const textPayload = (text: string): MessagePayload => ({ kind: "text", text });
const imagePayload = (): MessagePayload => ({
  kind: "image",
  fileUrl: "https://example.com/fake-id.jpg",
  mimeType: "image/jpeg",
  fileName: "id.jpg",
  caption: undefined,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intake.orchestrator — full slot flow", () => {
  let seeds: Seeds;

  beforeAll(async () => {
    seeds = await seed();
  });

  afterAll(async () => {
    await teardown(seeds);
    // pool is a shared module singleton across test files — do not end it here
  });

  it("welcome slot: advances to client_type and sends button prompt", async () => {
    const { sendInteractiveButtonsWithTyping } = await import("../../domains/whatsapp/whatsapp.service.js");
    const mockSendButtons = sendInteractiveButtonsWithTyping as ReturnType<typeof vi.fn>;
    mockSendButtons.mockResolvedValue({ idMessage: "btn-client-type" });

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("hi"),
    );

    expect(result.consumed).toBe(true);
    expect(mockSendButtons).toHaveBeenCalled();

    const { rows } = await pool.query<{ intake_current_slot: string }>(
      `SELECT intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("client_type");
  });

  it("client_type slot: any reply advances to team_routing", async () => {
    const { sendInteractiveButtonsWithTyping } = await import("../../domains/whatsapp/whatsapp.service.js");
    const mockSendButtons = sendInteractiveButtonsWithTyping as ReturnType<typeof vi.fn>;
    mockSendButtons.mockResolvedValue({ idMessage: "btn-team-routing" });

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("New client"),
    );

    expect(result.consumed).toBe(true);

    const { rows } = await pool.query<{ intake_current_slot: string }>(
      `SELECT intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("team_routing");
  });

  it("client_type slot: image reply also advances to team_routing", async () => {
    // Reset back to client_type
    await pool.query(
      `UPDATE clients SET intake_current_slot = 'client_type' WHERE id = $1`,
      [seeds.clientId],
    );
    const { sendInteractiveButtonsWithTyping } = await import("../../domains/whatsapp/whatsapp.service.js");
    const mockSendButtons = sendInteractiveButtonsWithTyping as ReturnType<typeof vi.fn>;
    mockSendButtons.mockResolvedValue({ idMessage: "btn-team-routing-img" });

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      imagePayload(),
    );

    expect(result.consumed).toBe(true);

    const { rows } = await pool.query<{ intake_current_slot: string }>(
      `SELECT intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("team_routing");
  });

  it("team_routing slot: any reply advances to full_name", async () => {
    mockSendMsg.mockResolvedValue({ idMessage: "full-name-prompt" });

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("Team Y"),
    );

    expect(result.consumed).toBe(true);

    const { rows } = await pool.query<{ intake_current_slot: string }>(
      `SELECT intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("full_name");
  });

  it("full_name slot: extracts name and advances to email", async () => {
    mockClassify.mockResolvedValueOnce({ valid: true, extracted: "Test Lead" });

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("Test Lead"),
    );

    expect(result.consumed).toBe(true);
    expect(mockClassify).toHaveBeenCalledWith(
      "Test Lead",
      "full_name",
      expect.any(String),
      expect.any(String),
    );

    const { rows } = await pool.query<{ full_name: string; intake_current_slot: string }>(
      `SELECT full_name, intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.full_name).toBe("Test Lead");
    expect(rows[0]?.intake_current_slot).toBe("email");
  });

  it("email slot: fast-path regex accepts valid email and advances to inquiry_type", async () => {
    // classifyIntakeResponse must NOT be called for a regex-valid email
    mockClassify.mockClear();

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("lead@example.com"),
    );

    expect(result.consumed).toBe(true);
    // Fast-path: no LLM call for a well-formed email
    expect(mockClassify).not.toHaveBeenCalled();

    const { rows } = await pool.query<{ email: string; intake_current_slot: string }>(
      `SELECT email, intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.email).toBe("lead@example.com");
    expect(rows[0]?.intake_current_slot).toBe("inquiry_type");
  });

  it("inquiry_type slot: button id ('vehicle') advances to id_photo without LLM", async () => {
    mockClassify.mockClear();

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("vehicle"),
    );

    expect(result.consumed).toBe(true);
    expect(mockClassify).not.toHaveBeenCalled();

    const { rows } = await pool.query<{ inquiry_type: string; intake_current_slot: string }>(
      `SELECT inquiry_type, intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.inquiry_type).toBe("vehicle");
    expect(rows[0]?.intake_current_slot).toBe("id_photo");
  });

  it("id_photo slot: valid image passes OCR, uploads to Drive, advances to poa", async () => {
    const idWebViewLink = "https://drive.google.com/file/d/drive-id-1/view";
    mockValidateIdPhoto.mockResolvedValueOnce({
      valid: true,
      reason: "תעודת זהות תקינה",
      idNumber: "123456789",
    });
    mockFetchRemoteFile.mockResolvedValueOnce(Buffer.from("fake-bytes"));
    mockUploadLeadDocument.mockResolvedValueOnce({ fileId: "drive-id-1", webViewLink: idWebViewLink });

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      imagePayload(),
    );

    expect(result.consumed).toBe(true);
    expect(mockValidateIdPhoto).toHaveBeenCalledWith("https://example.com/fake-id.jpg");
    expect(mockUploadLeadDocument).toHaveBeenCalledOnce();
    expect(mockUploadLeadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/ - ID$/), mimeType: "image/jpeg" }),
    );

    const { rows } = await pool.query<{
      id_photo_url: string;
      id_validated: boolean;
      id_number: string | null;
      intake_current_slot: string;
    }>(
      `SELECT id_photo_url, id_validated, id_number, intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.id_photo_url).toBe(idWebViewLink);
    expect(rows[0]?.id_validated).toBe(true);
    expect(rows[0]?.id_number).toBe("123456789");
    expect(rows[0]?.intake_current_slot).toBe("poa");

    // Document row persisted with Drive webViewLink
    const { rows: docRows } = await pool.query(
      `SELECT type, file_url FROM documents WHERE client_id = $1 AND type = 'id_photo'`,
      [seeds.clientId],
    );
    expect(docRows.length).toBeGreaterThan(0);
    expect(docRows[0]?.file_url).toBe(idWebViewLink);
  });

  it("poa slot: document upload to Drive persists poa_doc_url and finalizes intake", async () => {
    const poaWebViewLink = "https://drive.google.com/file/d/drive-poa-1/view";
    mockFetchRemoteFile.mockResolvedValueOnce(Buffer.from("fake-poa-bytes"));
    mockUploadLeadDocument.mockResolvedValueOnce({ fileId: "drive-poa-1", webViewLink: poaWebViewLink });
    mockClassifyComplexity.mockResolvedValueOnce("simple");

    const poaPayload: MessagePayload = {
      kind: "document",
      fileUrl: "https://example.com/poa.pdf",
      mimeType: "application/pdf",
      fileName: "poa.pdf",
      caption: undefined,
    };

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      poaPayload,
    );

    expect(result.consumed).toBe(true);
    expect(mockUploadLeadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/ - POA$/) }),
    );

    // Read final client state
    const { rows } = await pool.query<{
      poa_doc_url: string;
      intake_state: string;
      intake_current_slot: string;
      intake_completed_at: string | null;
      pipeline_stage: string | null;
    }>(
      `SELECT poa_doc_url, intake_state, intake_current_slot,
              intake_completed_at, pipeline_stage
       FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.poa_doc_url).toBe(poaWebViewLink);
    expect(rows[0]?.intake_state).toBe("completed");
    expect(rows[0]?.intake_current_slot).toBe("done");
    expect(rows[0]?.intake_completed_at).not.toBeNull();
    expect(rows[0]?.pipeline_stage).toBe("meeting_scheduling");

    // POA document row with Drive webViewLink
    const { rows: docRows } = await pool.query(
      `SELECT type, file_url FROM documents WHERE client_id = $1 AND type = 'poa'`,
      [seeds.clientId],
    );
    expect(docRows.length).toBeGreaterThan(0);
    expect(docRows[0]?.file_url).toBe(poaWebViewLink);

    // Pending meeting row created by finalize()
    const { rows: meetingRows } = await pool.query(
      `SELECT status FROM meetings WHERE client_id = $1`,
      [seeds.clientId],
    );
    expect(meetingRows.length).toBeGreaterThan(0);
    expect(meetingRows[0]?.status).toBe("pending_booking");

    // Conversation paused after intake completes
    const { rows: convRows } = await pool.query<{ bot_paused: boolean }>(
      `SELECT bot_paused FROM conversations WHERE id = $1`,
      [seeds.conversationId],
    );
    expect(convRows[0]?.bot_paused).toBe(true);
  });

  it("already-completed slot returns consumed=false", async () => {
    // Intake state is now 'completed' from previous test
    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("any text"),
    );
    // handleIntake returns { consumed: false } when bot_paused is true
    // (conversation was paused in finalize()) — still the correct outcome
    expect(result.consumed).toBe(false);
  });

  it("message rows are persisted for outbound bot prompts", async () => {
    // At least one outbound message should have been written during the flow
    const { rows } = await pool.query(
      `SELECT id FROM messages
       WHERE conversation_id = $1
         AND direction = 'outbound'
         AND sent_by = 'bot'`,
      [seeds.conversationId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("intake.orchestrator — invalid responses re-prompt", () => {
  let seeds: Seeds;

  beforeAll(async () => {
    seeds = await seed();
    // Advance to full_name slot: welcome → client_type → team_routing → full_name
    mockSendMsg.mockResolvedValue({ idMessage: "setup-id" });
    const { sendInteractiveButtonsWithTyping } = await import("../../domains/whatsapp/whatsapp.service.js");
    (sendInteractiveButtonsWithTyping as ReturnType<typeof vi.fn>).mockResolvedValue({ idMessage: "btn-setup" });
    await handleIntake(seeds.conversationId, seeds.clientId, "97250x@c.us", textPayload("hi"));
    await handleIntake(seeds.conversationId, seeds.clientId, "97250x@c.us", textPayload("New client"));
    await handleIntake(seeds.conversationId, seeds.clientId, "97250x@c.us", textPayload("Team Y"));
  });

  afterAll(async () => {
    await teardown(seeds);
  });

  it("full_name: invalid LLM response re-prompts without advancing slot", async () => {
    mockClassify.mockResolvedValueOnce({ valid: false });

    await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250x@c.us",
      textPayload("what is this?"),
    );

    const { rows } = await pool.query<{ intake_current_slot: string }>(
      `SELECT intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.intake_current_slot).toBe("full_name");
    expect(mockSendMsg).toHaveBeenCalled();
  });
});

describe("intake.orchestrator — poa skip", () => {
  let seeds: Seeds;

  beforeAll(async () => {
    seeds = await seed();
    mockSendMsg.mockResolvedValue({ idMessage: "setup-id" });
    mockClassify.mockResolvedValue({ valid: true, extracted: "Test Lead" });
    mockValidateIdPhoto.mockResolvedValue({ valid: true, reason: "ok", idNumber: undefined });
    mockFetchRemoteFile.mockResolvedValue(Buffer.from("fake-bytes"));
    mockUploadLeadDocument.mockResolvedValue({
      fileId: "drive-skip-1",
      webViewLink: "https://drive.google.com/file/d/drive-skip-1/view",
    });
    mockClassifyComplexity.mockResolvedValue("simple");

    // Drive through welcome → client_type → team_routing → full_name → email → inquiry_type → id_photo
    const { sendInteractiveButtonsWithTyping } = await import("../../domains/whatsapp/whatsapp.service.js");
    (sendInteractiveButtonsWithTyping as ReturnType<typeof vi.fn>).mockResolvedValue({ idMessage: "btn-skip-setup" });
    await handleIntake(seeds.conversationId, seeds.clientId, "97250skip@c.us", textPayload("hi"));
    await handleIntake(seeds.conversationId, seeds.clientId, "97250skip@c.us", textPayload("New client"));
    await handleIntake(seeds.conversationId, seeds.clientId, "97250skip@c.us", textPayload("Stay"));
    await handleIntake(seeds.conversationId, seeds.clientId, "97250skip@c.us", textPayload("Test Lead"));
    await handleIntake(seeds.conversationId, seeds.clientId, "97250skip@c.us", textPayload("valid@email.com"));
    await handleIntake(seeds.conversationId, seeds.clientId, "97250skip@c.us", textPayload("vehicle"));
    await handleIntake(seeds.conversationId, seeds.clientId, "97250skip@c.us", imagePayload());
  });

  afterAll(async () => {
    await teardown(seeds);
  });

  it("poa slot: 'דלג' text skips poa and completes intake without poa_doc_url", async () => {
    mockClassifyComplexity.mockResolvedValueOnce("simple");

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250skip@c.us",
      textPayload("דלג"),
    );

    expect(result.consumed).toBe(true);

    const { rows } = await pool.query<{
      poa_doc_url: string | null;
      intake_state: string;
      intake_current_slot: string;
    }>(
      `SELECT poa_doc_url, intake_state, intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.poa_doc_url).toBeNull();
    expect(rows[0]?.intake_state).toBe("completed");
    expect(rows[0]?.intake_current_slot).toBe("done");
  });
});
