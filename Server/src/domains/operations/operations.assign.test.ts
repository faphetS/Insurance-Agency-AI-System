import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared mock functions
// ---------------------------------------------------------------------------
const {
  mockSendMessageWithTyping,
  mockNotifyStaffHandoff,
  mockFromImpl,
} = vi.hoisted(() => {
  const mockSendMessageWithTyping = vi.fn().mockResolvedValue({ idMessage: "msg-assign" });
  const mockNotifyStaffHandoff = vi.fn().mockResolvedValue(undefined);
  const mockFromImpl = vi.fn();

  return { mockSendMessageWithTyping, mockNotifyStaffHandoff, mockFromImpl };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({
  env: {
    BACKEND_URL: "http://localhost:3000",
    NODE_ENV: "test",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: mockSendMessageWithTyping,
  sendInteractiveButtonsWithTyping: vi.fn().mockResolvedValue({ idMessage: "btn-msg" }),
  sendTyping: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../whatsapp/whatsapp.util.js", () => ({
  toChatId: vi.fn().mockReturnValue("972501234567@c.us"),
}));

vi.mock("./operations.staff-handoff.js", () => ({
  notifyStaffHandoff: mockNotifyStaffHandoff,
}));

// ---------------------------------------------------------------------------
// Builder shim helpers
// ---------------------------------------------------------------------------
type Builder = Record<string, unknown>;

function makeBuilder(result: unknown): Builder {
  const terminal = vi.fn().mockResolvedValue(result);
  const builder: Builder = {};
  const chainMethods = [
    "select", "eq", "neq", "is", "not", "in", "gte", "lte",
    "order", "insert", "upsert", "update", "limit", "range",
    "not", "head",
  ];
  for (const m of chainMethods) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder["maybeSingle"] = terminal;
  builder["single"] = terminal;
  builder["then"] = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return builder;
}

function setupFromSequence(builders: Builder[]): void {
  let callIndex = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[callIndex] ?? builders[builders.length - 1];
    callIndex++;
    return b;
  });
}

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------
import { assignStaffToMeeting, createTaskChain } from "./operations.service.js";

// ---------------------------------------------------------------------------
// assignStaffToMeeting
// ---------------------------------------------------------------------------
describe("assignStaffToMeeting", () => {
  const MEETING_ID = "meeting-assign-1";
  const STAFF_ID = "staff-assign-1";
  const CLIENT_ID = "client-assign-1";
  const OWNER_CHAT_ID = "972521111111@c.us";

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageWithTyping.mockResolvedValue({ idMessage: "msg-assign" });
    mockNotifyStaffHandoff.mockResolvedValue(undefined);
  });

  it("happy path: updates client, calls notifyStaffHandoff, sends הוקצה reply", async () => {
    const meetingBuilder = makeBuilder({ data: { id: MEETING_ID, client_id: CLIENT_ID }, error: null });
    const staffBuilder = makeBuilder({ data: { full_name: "אריאל כהן", phone: "0501234567" }, error: null });
    const clientUpdateBuilder = makeBuilder({ data: { id: CLIENT_ID }, error: null }); // first-tap claim wins
    // createTaskChain needs: meetings.select, clients.select, tasks.select (no existing), tasks.insert, clients.update, notifications.upsert
    const meetingForChainBuilder = makeBuilder({ data: { id: MEETING_ID, client_id: CLIENT_ID }, error: null });
    const clientForChainBuilder = makeBuilder({ data: { assigned_to: STAFF_ID, assigned_handler_id: null }, error: null });
    const existingTaskBuilder = makeBuilder({ data: null, error: null }); // no existing task
    const tasksInsertBuilder = makeBuilder({ data: null, error: null });
    const clientPipelineUpdateBuilder = makeBuilder({ data: null, error: null });
    const notificationBuilder = makeBuilder({ data: null, error: null });

    setupFromSequence([
      meetingBuilder,        // assignStaffToMeeting: meetings.select
      staffBuilder,          // assignStaffToMeeting: staff.select
      clientUpdateBuilder,   // assignStaffToMeeting: clients.update(assigned_handler_id)
      meetingForChainBuilder, // createTaskChain: meetings.select
      clientForChainBuilder,  // createTaskChain: clients.select
      existingTaskBuilder,    // createTaskChain: tasks.select (idempotency)
      tasksInsertBuilder,     // createTaskChain: tasks.insert
      clientPipelineUpdateBuilder, // createTaskChain: clients.update(pipeline_stage)
      notificationBuilder,    // createTaskChain: notifications.upsert
    ]);

    await assignStaffToMeeting(MEETING_ID, STAFF_ID, OWNER_CHAT_ID);

    // Client assigned_handler_id claimed atomically (only when currently null)
    const clientUpdateFn = clientUpdateBuilder["update"] as ReturnType<typeof vi.fn>;
    expect(clientUpdateFn).toHaveBeenCalledWith({ assigned_handler_id: STAFF_ID });
    const clientIsFn = clientUpdateBuilder["is"] as ReturnType<typeof vi.fn>;
    expect(clientIsFn).toHaveBeenCalledWith("assigned_handler_id", null);

    // notifyStaffHandoff called with viaConversationalBot: true
    expect(mockNotifyStaffHandoff).toHaveBeenCalledOnce();
    expect(mockNotifyStaffHandoff).toHaveBeenCalledWith(MEETING_ID, { viaConversationalBot: true });

    // Owner reply contains הוקצה
    expect(mockSendMessageWithTyping).toHaveBeenCalledOnce();
    const [chatId, message] = mockSendMessageWithTyping.mock.calls[0] as [string, string];
    expect(chatId).toBe(OWNER_CHAT_ID);
    expect(message).toContain("הוקצה");
  });

  it("already assigned (claim fails): no overwrite, no notifyStaffHandoff, reply names the current handler", async () => {
    const meetingBuilder = makeBuilder({ data: { id: MEETING_ID, client_id: CLIENT_ID }, error: null });
    const staffBuilder = makeBuilder({ data: { full_name: "דנה לוי", phone: "0509876543" }, error: null });
    // Atomic claim fails — a handler is already set, so 0 rows updated
    const claimBuilder = makeBuilder({ data: null, error: null });
    // Look up the current handler to report it back
    const currentClientBuilder = makeBuilder({ data: { assigned_handler_id: "existing-staff" }, error: null });
    const currentStaffBuilder = makeBuilder({ data: { full_name: "מירב ששון" }, error: null });

    setupFromSequence([
      meetingBuilder,        // meetings.select
      staffBuilder,          // staff.select
      claimBuilder,          // clients.update atomic claim → fails
      currentClientBuilder,  // clients.select assigned_handler_id
      currentStaffBuilder,   // staff.select full_name (current handler)
    ]);

    await assignStaffToMeeting(MEETING_ID, STAFF_ID, OWNER_CHAT_ID);

    expect(mockNotifyStaffHandoff).not.toHaveBeenCalled();

    const [chatId, message] = mockSendMessageWithTyping.mock.calls[0] as [string, string];
    expect(chatId).toBe(OWNER_CHAT_ID);
    expect(message).toContain("כבר הוקצה");
    expect(message).toContain("מירב ששון"); // reports the existing handler, not the re-tapped staff
  });

  it("staff not found: replies with ❌ העובד לא נמצא, no task chain, no handoff", async () => {
    const meetingBuilder = makeBuilder({ data: { id: MEETING_ID, client_id: CLIENT_ID }, error: null });
    const staffBuilder = makeBuilder({ data: null, error: null }); // staff not found

    setupFromSequence([meetingBuilder, staffBuilder]);

    await assignStaffToMeeting(MEETING_ID, STAFF_ID, OWNER_CHAT_ID);

    expect(mockNotifyStaffHandoff).not.toHaveBeenCalled();

    const [chatId, message] = mockSendMessageWithTyping.mock.calls[0] as [string, string];
    expect(chatId).toBe(OWNER_CHAT_ID);
    expect(message).toContain("❌ העובד לא נמצא.");
  });

  it("meeting not found: replies with ❌ הפגישה לא נמצאה", async () => {
    const meetingBuilder = makeBuilder({ data: null, error: null }); // meeting not found
    setupFromSequence([meetingBuilder]);

    await assignStaffToMeeting(MEETING_ID, STAFF_ID, OWNER_CHAT_ID);

    expect(mockNotifyStaffHandoff).not.toHaveBeenCalled();

    const [chatId, message] = mockSendMessageWithTyping.mock.calls[0] as [string, string];
    expect(chatId).toBe(OWNER_CHAT_ID);
    expect(message).toContain("❌ הפגישה לא נמצאה.");
  });
});

// ---------------------------------------------------------------------------
// createTaskChain idempotency guard
// ---------------------------------------------------------------------------
describe("createTaskChain idempotency guard", () => {
  const MEETING_ID = "meeting-chain-1";
  const CLIENT_ID = "client-chain-1";
  const STAFF_ID = "staff-chain-1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { created: false } and does NOT insert tasks when existing task found", async () => {
    const meetingBuilder = makeBuilder({ data: { id: MEETING_ID, client_id: CLIENT_ID }, error: null });
    const clientBuilder = makeBuilder({ data: { assigned_to: STAFF_ID, assigned_handler_id: null }, error: null });
    const existingTaskBuilder = makeBuilder({ data: { id: "task-exists" }, error: null });

    setupFromSequence([meetingBuilder, clientBuilder, existingTaskBuilder]);

    const result = await createTaskChain(MEETING_ID);

    expect(result).toEqual({ created: false });

    // Verify tasks.insert was NOT called — tasks table from() was only called once (for select)
    const fromCalls = mockFromImpl.mock.calls.map((c: unknown[]) => c[0]);
    const tasksInsertCalled = fromCalls.filter((t: unknown) => t === "tasks").length;
    // Should be exactly 1 (for the select idempotency check), not 2
    expect(tasksInsertCalled).toBe(1);
  });

  it("clean path: inserts tasks and returns { created: true }", async () => {
    const meetingBuilder = makeBuilder({ data: { id: MEETING_ID, client_id: CLIENT_ID }, error: null });
    const clientBuilder = makeBuilder({ data: { assigned_to: STAFF_ID, assigned_handler_id: null }, error: null });
    const existingTaskBuilder = makeBuilder({ data: null, error: null }); // no existing task
    const tasksInsertBuilder = makeBuilder({ data: null, error: null });
    const clientUpdateBuilder = makeBuilder({ data: null, error: null });
    const notificationBuilder = makeBuilder({ data: null, error: null });

    setupFromSequence([
      meetingBuilder,
      clientBuilder,
      existingTaskBuilder,
      tasksInsertBuilder,
      clientUpdateBuilder,
      notificationBuilder,
    ]);

    const result = await createTaskChain(MEETING_ID);

    expect(result).toEqual({ created: true });

    // Verify tasks.insert was called
    const tasksInsertFn = tasksInsertBuilder["insert"] as ReturnType<typeof vi.fn>;
    expect(tasksInsertFn).toHaveBeenCalledOnce();
    const insertedTasks = tasksInsertFn.mock.calls[0][0] as Array<{ type: string; meeting_id: string; assigned_to: string }>;
    expect(Array.isArray(insertedTasks)).toBe(true);
    expect(insertedTasks.length).toBeGreaterThan(0);
    expect(insertedTasks[0].meeting_id).toBe(MEETING_ID);
    expect(insertedTasks[0].assigned_to).toBe(STAFF_ID);
  });

  it("uses assigned_handler_id over assigned_to when both present", async () => {
    const HANDLER_ID = "handler-overrides";
    const meetingBuilder = makeBuilder({ data: { id: MEETING_ID, client_id: CLIENT_ID }, error: null });
    const clientBuilder = makeBuilder({
      data: { assigned_to: STAFF_ID, assigned_handler_id: HANDLER_ID },
      error: null,
    });
    const existingTaskBuilder = makeBuilder({ data: null, error: null });
    const tasksInsertBuilder = makeBuilder({ data: null, error: null });
    const clientUpdateBuilder = makeBuilder({ data: null, error: null });
    const notificationBuilder = makeBuilder({ data: null, error: null });

    setupFromSequence([
      meetingBuilder,
      clientBuilder,
      existingTaskBuilder,
      tasksInsertBuilder,
      clientUpdateBuilder,
      notificationBuilder,
    ]);

    await createTaskChain(MEETING_ID);

    const tasksInsertFn = tasksInsertBuilder["insert"] as ReturnType<typeof vi.fn>;
    const insertedTasks = tasksInsertFn.mock.calls[0][0] as Array<{ assigned_to: string }>;
    expect(insertedTasks[0].assigned_to).toBe(HANDLER_ID);
  });
});
