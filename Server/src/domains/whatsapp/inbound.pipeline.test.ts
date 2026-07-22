import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockHandleIntake,
  mockIsStaffChat,
  mockFromImpl,
} = vi.hoisted(() => ({
  mockHandleIntake: vi.fn().mockResolvedValue({ consumed: false }),
  mockIsStaffChat: vi.fn().mockResolvedValue(null),
  mockFromImpl: vi.fn(),
}));

const envMock = {
  SUMMARY_RECIPIENT_PHONE: "639219909210",
  NODE_ENV: "test",
  REPLY_ALLOWLIST: [] as string[],
};

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/supabase.js", () => ({
  supabaseAdmin: { from: mockFromImpl },
}));

vi.mock("../ai/intake.orchestrator.js", () => ({
  handleIntake: mockHandleIntake,
}));

vi.mock("./whatsapp.util.js", async () => {
  const actual = await vi.importActual<typeof import("./whatsapp.util.js")>("./whatsapp.util.js");
  return {
    toChatId: actual.toChatId,
    isStaffChat: mockIsStaffChat,
  };
});

import { processInboundCustomerMessage } from "./inbound.pipeline.js";
import type { MessagePayload } from "./whatsapp.validator.js";

function makeBuilder(result: unknown) {
  const b: Record<string, unknown> = {};
  const chainMethods = [
    "select", "eq", "neq", "is", "not", "in", "gte", "lte", "lt", "gt",
    "order", "limit", "insert", "upsert", "update", "delete",
  ];
  for (const m of chainMethods) {
    b[m] = vi.fn().mockReturnValue(b);
  }
  const terminal = vi.fn().mockResolvedValue(result);
  b["maybeSingle"] = terminal;
  b["single"] = terminal;
  b["then"] = (resolve: (v: unknown) => void) =>
    Promise.resolve(result).then(resolve);
  return b;
}

function setupFrom(builders: ReturnType<typeof makeBuilder>[]) {
  let i = 0;
  mockFromImpl.mockImplementation(() => {
    const b = builders[i] ?? builders[builders.length - 1]!;
    i++;
    return b;
  });
}

const OWNER_CHAT_ID = "639219909210@c.us";
const LEAD_CHAT_ID = "972500000000@c.us";

const textPayload = (text: string): MessagePayload => ({ kind: "text", text });

function inbound(
  chatId: string,
  payload: MessagePayload,
  channel: "greenapi" | "meta" = "greenapi",
) {
  return {
    chatId,
    senderName: "Test User",
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    payload,
    channel,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsStaffChat.mockResolvedValue(null);
  mockHandleIntake.mockResolvedValue({ consumed: false });
});

// ---------------------------------------------------------------------------
// Owner number — normal lead/intake flow (no more operational-only guard)
// ---------------------------------------------------------------------------

describe("processInboundCustomerMessage — owner number", () => {
  it("inbound text from the owner's own number goes through the normal client/intake flow", async () => {
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      makeBuilder({ data: { id: "msg1" }, error: null }),
      makeBuilder({ data: { id: "conv1", client_id: "client-owner" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(OWNER_CHAT_ID, textPayload("שלום")));

    expect(mockHandleIntake).toHaveBeenCalledWith(
      "conv1",
      "client-owner",
      OWNER_CHAT_ID,
      { kind: "text", text: "שלום" },
    );
  });
});

// ---------------------------------------------------------------------------
// Staff intercept
// ---------------------------------------------------------------------------

describe("processInboundCustomerMessage — staff intercept", () => {
  it("staff chat → skipped before any conversation write", async () => {
    mockIsStaffChat.mockResolvedValueOnce({ staffId: "staff-9", fullName: "Alice" });

    await processInboundCustomerMessage(inbound("972501111111@c.us", textPayload("hi")));

    expect(mockFromImpl).not.toHaveBeenCalled();
    expect(mockHandleIntake).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Channel stamping
// ---------------------------------------------------------------------------

describe("processInboundCustomerMessage — channel stamping", () => {
  function runWithChannel(channel: "greenapi" | "meta") {
    const convUpsert = makeBuilder({ data: { id: "conv1" }, error: null });
    const msgInsert = makeBuilder({ data: { id: "msg1" }, error: null });
    const convSelect = makeBuilder({ data: { id: "conv1", client_id: "client1" }, error: null });
    setupFrom([convUpsert, msgInsert, convSelect]);
    return { convUpsert, run: () => processInboundCustomerMessage(inbound(LEAD_CHAT_ID, textPayload("hi"), channel)) };
  }

  it("greenapi inbound stamps channel='greenapi' on the conversation upsert", async () => {
    const { convUpsert, run } = runWithChannel("greenapi");
    await run();

    const upsertArg = (convUpsert["upsert"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertArg).toMatchObject({ whatsapp_chat_id: LEAD_CHAT_ID, channel: "greenapi" });
    expect(mockHandleIntake).toHaveBeenCalled();
  });

  it("meta inbound stamps channel='meta' on the conversation upsert", async () => {
    const { convUpsert, run } = runWithChannel("meta");
    await run();

    const upsertArg = (convUpsert["upsert"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertArg).toMatchObject({ channel: "meta" });
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe("processInboundCustomerMessage — duplicate webhook dedup", () => {
  it("23505 on the message insert → skip silently, no intake", async () => {
    const convUpsert = makeBuilder({ data: { id: "conv1" }, error: null });
    const msgInsert = makeBuilder({ data: null, error: { code: "23505", message: "duplicate" } });
    setupFrom([convUpsert, msgInsert]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, textPayload("hi")));

    expect(mockHandleIntake).not.toHaveBeenCalled();
    // Only conversation upsert + message insert — the client-link chain never runs.
    expect(mockFromImpl).toHaveBeenCalledTimes(2);
  });

  it("non-dedup insert error → logged, no intake", async () => {
    const convUpsert = makeBuilder({ data: { id: "conv1" }, error: null });
    const msgInsert = makeBuilder({ data: null, error: { code: "XX000", message: "boom" } });
    setupFrom([convUpsert, msgInsert]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, textPayload("hi")));

    expect(mockHandleIntake).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reply allowlist gate
// ---------------------------------------------------------------------------

describe("processInboundCustomerMessage — reply allowlist", () => {
  const ALLOWED_PHONE = "972501111111";
  const BLOCKED_PHONE = "972502222222";
  const ALLOWED_CHAT_ID = `${ALLOWED_PHONE}@c.us`;
  const BLOCKED_CHAT_ID = `${BLOCKED_PHONE}@c.us`;

  beforeEach(() => {
    envMock.REPLY_ALLOWLIST = [ALLOWED_PHONE];
  });

  afterEach(() => {
    envMock.REPLY_ALLOWLIST = [];
  });

  it("allowlisted sender dispatches intake", async () => {
    setupFrom([
      makeBuilder({ data: { id: "conv-allow" }, error: null }),
      makeBuilder({ data: { id: "msg-allow" }, error: null }),
      makeBuilder({ data: { id: "conv-allow", client_id: "client-allow" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(ALLOWED_CHAT_ID, textPayload("hello")));

    expect(mockHandleIntake).toHaveBeenCalled();
  });

  it("non-allowlisted sender is stored but gets no reply", async () => {
    setupFrom([
      makeBuilder({ data: { id: "conv-block" }, error: null }),
      makeBuilder({ data: { id: "msg-block" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(BLOCKED_CHAT_ID, textPayload("hello")));

    expect(mockHandleIntake).not.toHaveBeenCalled();
  });

  it("empty allowlist (default) does not block any sender", async () => {
    envMock.REPLY_ALLOWLIST = [];
    setupFrom([
      makeBuilder({ data: { id: "conv-open" }, error: null }),
      makeBuilder({ data: { id: "msg-open" }, error: null }),
      makeBuilder({ data: { id: "conv-open", client_id: "client-open" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(BLOCKED_CHAT_ID, textPayload("hello")));

    expect(mockHandleIntake).toHaveBeenCalled();
  });

  it("allowlist matching strips non-digit chars from both sides", async () => {
    envMock.REPLY_ALLOWLIST = ["+972-50-1111111"];
    setupFrom([
      makeBuilder({ data: { id: "conv-fmt" }, error: null }),
      makeBuilder({ data: { id: "msg-fmt" }, error: null }),
      makeBuilder({ data: { id: "conv-fmt", client_id: "client-fmt" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(ALLOWED_CHAT_ID, textPayload("hello")));

    expect(mockHandleIntake).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Client link / create
// ---------------------------------------------------------------------------

describe("processInboundCustomerMessage — client link/create", () => {
  it("existing linked client → intake called with the linked client id", async () => {
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      makeBuilder({ data: { id: "msg1" }, error: null }),
      makeBuilder({ data: { id: "conv1", client_id: "client-linked" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, textPayload("hi")));

    expect(mockHandleIntake).toHaveBeenCalledWith(
      "conv1",
      "client-linked",
      LEAD_CHAT_ID,
      { kind: "text", text: "hi" },
    );
  });

  it("no client yet → creates one, links it and dispatches intake with it", async () => {
    const clientInsert = makeBuilder({ data: { id: "client-new" }, error: null });
    const convLink = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),           // conversation upsert
      makeBuilder({ data: { id: "msg1" }, error: null }),            // message insert
      makeBuilder({ data: { id: "conv1", client_id: null }, error: null }), // conv select
      makeBuilder({ data: null, error: null }),                       // client by phone
      makeBuilder({ data: { id: "staff1" }, error: null }),          // active staff fallback
      clientInsert,                                                   // client insert
      convLink,                                                       // conversation link update
    ]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, textPayload("hi")));

    const insertArg = (clientInsert["insert"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertArg).toMatchObject({
      phone: "972500000000",
      status: "new",
      pipeline_stage: "new_lead",
      source_channel: "wa",
      assigned_to: "staff1",
    });
    expect((convLink["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({ client_id: "client-new" });
    expect(mockHandleIntake).toHaveBeenCalledWith("conv1", "client-new", LEAD_CHAT_ID, expect.anything());
  });

  it("no active staff → no client created, intake skipped", async () => {
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      makeBuilder({ data: { id: "msg1" }, error: null }),
      makeBuilder({ data: { id: "conv1", client_id: null }, error: null }),
      makeBuilder({ data: null, error: null }), // client by phone
      makeBuilder({ data: null, error: null }), // no staff
    ]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, textPayload("hi")));

    expect(mockHandleIntake).not.toHaveBeenCalled();
  });
});
