import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports that trigger module eval
// ---------------------------------------------------------------------------

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({
  env: {
    OPENROUTER_API_KEY: "test-key",
    AI_MODEL: "test/model",
    AI_FALLBACK_MODEL: "test/fallback",
    NODE_ENV: "test",
  },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("openai", () => {
  function OpenAIMock(this: Record<string, unknown>) {
    this["chat"] = { completions: { create: mockCreate } };
  }
  return { default: OpenAIMock };
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { validateIdPhoto } from "./ai.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompletion(content: string) {
  return { choices: [{ message: { content } }] };
}

function mockLLMResponse(
  idNumber: string | null,
  options: { hasIdCard?: boolean; hasAppendix?: boolean } = {},
) {
  const { hasIdCard = true, hasAppendix = true } = options;
  mockCreate.mockResolvedValue(
    makeCompletion(JSON.stringify({ hasIdCard, hasAppendix, idNumber })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// validateIdPhoto — idNumber extraction and normalization
// ---------------------------------------------------------------------------

describe("validateIdPhoto — idNumber extraction and normalization", () => {
  it("accepts a valid 9-digit Israeli ת\"ז", async () => {
    mockLLMResponse("123456782");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("123456782");
    expect(result.valid).toBe(true);
  });

  it("left-pads a valid 8-digit ת\"ז to 9 digits", async () => {
    mockLLMResponse("12345674");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("012345674");
  });

  it("strips spaces and dashes the model may insert between groups", async () => {
    mockLLMResponse("12-345 6782");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("123456782");
  });

  it("accepts the number when the model returns it as a JSON number", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion(JSON.stringify({ hasIdCard: true, hasAppendix: true, idNumber: 123456782 })),
    );
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("123456782");
  });

  it("rejects a foreign alphanumeric id → null (photo itself still valid)", async () => {
    mockLLMResponse("A01-2345678");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBeNull();
    expect(result.valid).toBe(true);
  });

  it("rejects a number that fails the ת\"ז check digit → null", async () => {
    mockLLMResponse("123456780");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBeNull();
  });

  it("returns null when model returns null for idNumber", async () => {
    mockLLMResponse(null);
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBeNull();
  });

  it("derives valid:false when hasAppendix is false", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion(JSON.stringify({ hasIdCard: true, hasAppendix: false, idNumber: null })),
    );
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.valid).toBe(false);
    expect(result.idNumber).toBeNull();
  });

  it("returns catch fallback when model returns unparseable JSON", async () => {
    mockCreate.mockResolvedValue(makeCompletion("not json at all"));
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.valid).toBe(false);
    expect(result.hasIdCard).toBe(false);
    expect(result.hasAppendix).toBe(false);
    expect(result.idNumber).toBeNull();
  });

  it("strips markdown code fences from model response before parsing", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion(
        "```json\n" + JSON.stringify({ hasIdCard: true, hasAppendix: true, idNumber: "123456782" }) + "\n```",
      ),
    );
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("123456782");
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateIdPhoto — hasIdCard / hasAppendix → valid derivation
// ---------------------------------------------------------------------------

describe("validateIdPhoto — hasIdCard / hasAppendix → valid derivation", () => {
  it("card-only (hasIdCard:true, hasAppendix:false) → invalid", async () => {
    mockLLMResponse("123456782", { hasAppendix: false });
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.valid).toBe(false);
    expect(result.hasIdCard).toBe(true);
    expect(result.hasAppendix).toBe(false);
  });

  it("appendix-only (hasIdCard:false, hasAppendix:true) → invalid", async () => {
    mockLLMResponse("123456782", { hasIdCard: false });
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.valid).toBe(false);
    expect(result.hasIdCard).toBe(false);
    expect(result.hasAppendix).toBe(true);
  });

  it("both card and appendix present → valid", async () => {
    mockLLMResponse("123456782");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.valid).toBe(true);
    expect(result.hasIdCard).toBe(true);
    expect(result.hasAppendix).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateIdPhoto — fullName extraction
// ---------------------------------------------------------------------------

describe("validateIdPhoto — fullName extraction", () => {
  it("returns the printed full name (collapses whitespace, trims)", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion(
        JSON.stringify({ hasIdCard: true, hasAppendix: true, idNumber: "123456782", fullName: "  יעל   כהן  " }),
      ),
    );
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.fullName).toBe("יעל כהן");
  });

  it("returns null when the model omits fullName", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion(JSON.stringify({ hasIdCard: true, hasAppendix: true, idNumber: "123456782" })),
    );
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.fullName).toBeNull();
  });

  it("returns null when fullName is null", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion(JSON.stringify({ hasIdCard: true, hasAppendix: true, idNumber: "123456782", fullName: null })),
    );
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.fullName).toBeNull();
  });

  it("returns null when fullName is under 2 chars", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion(JSON.stringify({ hasIdCard: true, hasAppendix: true, idNumber: "123456782", fullName: "א" })),
    );
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.fullName).toBeNull();
  });

  it("returns null fullName on malformed JSON (catch fallback)", async () => {
    mockCreate.mockResolvedValue(makeCompletion("not json"));
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.valid).toBe(false);
    expect(result.fullName).toBeNull();
  });
});
