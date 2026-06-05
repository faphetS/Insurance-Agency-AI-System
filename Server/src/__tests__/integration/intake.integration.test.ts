/**
 * Integration test: intake.orchestrator — data collection flow
 *
 * Drives handleIntake() through all slots (welcome → full_name → email →
 * inquiry_type → id_photo → poa → done) against a real throwaway Postgres DB
 * (insurance_test). All external I/O is mocked:
 *   - ai.service  (classifyIntakeResponse, analyzeImage, classifyComplexity)
 *   - whatsapp.service (sendMessageWithTyping, sendInteractiveButtonsWithTyping)
 *   - lib/storage (persistRemoteFile)
 *   - operations.service (createNotification) — fire-and-forget side effect
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any subject import
// ---------------------------------------------------------------------------

vi.mock("../../domains/ai/ai.service.js", () => ({
  classifyIntakeResponse: vi.fn(),
  analyzeImage: vi.fn(),
  classifyComplexity: vi.fn(),
}));

vi.mock("../../domains/whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi.fn().mockResolvedValue({ idMessage: "fake-out-id" }),
  sendInteractiveButtonsWithTyping: vi.fn().mockResolvedValue({ idMessage: "fake-btn-id" }),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue({ idMessage: "fake-msg-id" }),
}));

vi.mock("../../lib/storage.js", () => ({
  persistRemoteFile: vi.fn(),
  extFor: vi.fn().mockReturnValue("jpg"),
}));

vi.mock("../../domains/operations/operations.service.js", () => ({
  createNotification: vi.fn().mockResolvedValue(null),
  finalizeSummary: vi.fn().mockResolvedValue(undefined),
  handleClientConfirm: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Subject + helpers imported after mocks
// ---------------------------------------------------------------------------

import { handleIntake } from "../../domains/ai/intake.orchestrator.js";
import { pool } from "../../lib/db.js";
import type { MessagePayload } from "../../domains/whatsapp/whatsapp.validator.js";
import {
  classifyIntakeResponse,
  analyzeImage,
  classifyComplexity,
} from "../../domains/ai/ai.service.js";
import { sendMessageWithTyping } from "../../domains/whatsapp/whatsapp.service.js";
import { persistRemoteFile } from "../../lib/storage.js";

// ---------------------------------------------------------------------------
// Typed cast helpers for vi mocks
// ---------------------------------------------------------------------------

const mockClassify = classifyIntakeResponse as ReturnType<typeof vi.fn>;
const mockAnalyzeImage = analyzeImage as ReturnType<typeof vi.fn>;
const mockClassifyComplexity = classifyComplexity as ReturnType<typeof vi.fn>;
const mockSendMsg = sendMessageWithTyping as ReturnType<typeof vi.fn>;
const mockPersistFile = persistRemoteFile as ReturnType<typeof vi.fn>;

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

  it("welcome slot: sends prompts and advances to full_name", async () => {
    mockSendMsg.mockResolvedValue({ idMessage: "welcome-out" });

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("hi"),
    );

    expect(result.consumed).toBe(true);
    expect(mockSendMsg).toHaveBeenCalled();

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

  it("inquiry_type slot: exact match ('health') advances to id_photo", async () => {
    // 'health' is in INQUIRY_TYPES so no LLM call needed
    mockClassify.mockClear();

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      textPayload("health"),
    );

    expect(result.consumed).toBe(true);
    expect(mockClassify).not.toHaveBeenCalled();

    const { rows } = await pool.query<{ inquiry_type: string; intake_current_slot: string }>(
      `SELECT inquiry_type, intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.inquiry_type).toBe("health");
    expect(rows[0]?.intake_current_slot).toBe("id_photo");
  });

  it("id_photo slot: valid image passes OCR, persists file, advances to poa", async () => {
    mockAnalyzeImage.mockResolvedValueOnce(
      JSON.stringify({ valid: true, reason: "תעודת זהות תקינה" }),
    );
    mockPersistFile.mockResolvedValueOnce("clients/test/id_photo_123.jpg");

    const result = await handleIntake(
      seeds.conversationId,
      seeds.clientId,
      "97250test@c.us",
      imagePayload(),
    );

    expect(result.consumed).toBe(true);
    expect(mockAnalyzeImage).toHaveBeenCalledWith(
      "https://example.com/fake-id.jpg",
      expect.stringContaining("government-issued ID"),
    );
    expect(mockPersistFile).toHaveBeenCalledWith(
      "https://example.com/fake-id.jpg",
      expect.stringContaining("id_photo_"),
      "image/jpeg",
    );

    const { rows } = await pool.query<{
      id_photo_url: string;
      id_validated: boolean;
      intake_current_slot: string;
    }>(
      `SELECT id_photo_url, id_validated, intake_current_slot FROM clients WHERE id = $1`,
      [seeds.clientId],
    );
    expect(rows[0]?.id_photo_url).toBe("clients/test/id_photo_123.jpg");
    expect(rows[0]?.id_validated).toBe(true);
    expect(rows[0]?.intake_current_slot).toBe("poa");

    // Document row persisted
    const { rows: docRows } = await pool.query(
      `SELECT type, file_url FROM documents WHERE client_id = $1 AND type = 'id_photo'`,
      [seeds.clientId],
    );
    expect(docRows.length).toBeGreaterThan(0);
    expect(docRows[0]?.file_url).toBe("clients/test/id_photo_123.jpg");
  });

  it("poa slot: document upload persists poa_doc_url and finalizes intake", async () => {
    mockPersistFile.mockResolvedValueOnce("clients/test/poa_456.pdf");
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
    expect(mockPersistFile).toHaveBeenCalledWith(
      "https://example.com/poa.pdf",
      expect.stringContaining("poa_"),
      "application/pdf",
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
    expect(rows[0]?.poa_doc_url).toBe("clients/test/poa_456.pdf");
    expect(rows[0]?.intake_state).toBe("completed");
    expect(rows[0]?.intake_current_slot).toBe("done");
    expect(rows[0]?.intake_completed_at).not.toBeNull();
    expect(rows[0]?.pipeline_stage).toBe("meeting_scheduling");

    // POA document row
    const { rows: docRows } = await pool.query(
      `SELECT type FROM documents WHERE client_id = $1 AND type = 'poa'`,
      [seeds.clientId],
    );
    expect(docRows.length).toBeGreaterThan(0);

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
    // Advance to full_name slot by running welcome first
    mockSendMsg.mockResolvedValue({ idMessage: "setup-id" });
    await handleIntake(seeds.conversationId, seeds.clientId, "97250x@c.us", textPayload("hi"));
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
    mockAnalyzeImage.mockResolvedValue(JSON.stringify({ valid: true, reason: "ok" }));
    mockPersistFile.mockResolvedValue("clients/test/id_skip.jpg");
    mockClassifyComplexity.mockResolvedValue("simple");

    // Drive through welcome → full_name → email → inquiry_type → id_photo
    await handleIntake(seeds.conversationId, seeds.clientId, "97250skip@c.us", textPayload("hi"));
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
