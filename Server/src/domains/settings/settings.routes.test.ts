import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockEnv, mockLogger, mockService } = vi.hoisted(() => ({
  mockEnv: { NODE_ENV: "test", SETTINGS_PASSWORD: undefined as string | undefined },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockService: {
    getAutoReplyState: vi.fn(),
    saveMessage: vi.fn(),
    deleteMessage: vi.fn(),
    restoreOriginal: vi.fn(),
    useMessage: vi.fn(),
    clearTemporary: vi.fn(),
    parseUntil: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before any project imports so Vitest hoists them
// ---------------------------------------------------------------------------
vi.mock("../../config/env.js", () => ({ env: mockEnv }));
vi.mock("../../config/logger.js", () => ({ logger: mockLogger }));
vi.mock("../operations/unanswered-wa.settings.js", () => mockService);

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------
import settingsRoutes from "./settings.routes.js";
import { AppError, NotFoundError, globalErrorHandler } from "../../lib/errors.js";
import type { AutoReplyStateDto } from "../operations/unanswered-wa.settings.js";

const app = express();
app.use(express.json());
app.use("/api/settings", settingsRoutes);
app.use(globalErrorHandler);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWORD = "correct-horse-battery";
const AUTH = { Authorization: `Bearer ${PASSWORD}` };
const MESSAGE_ID = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d";
const NEW_ID = "9a1c4e7b-2d3f-4a5b-8c6d-7e8f9a0b1c2d";

const STATE: AutoReplyStateDto = {
  active: { text: "הודעה", source: "default", until: null },
  permanent: null,
  temporary: null,
  originalHidden: false,
  originalText: "הודעה",
  messages: [{ id: "default", text: "הודעה", builtIn: true, createdAt: null }],
};

const BASE = "/api/settings/auto-reply";

const ALL_ROUTES: Array<[method: "get" | "post" | "delete", path: string]> = [
  ["get", BASE],
  ["post", `${BASE}/messages`],
  ["delete", `${BASE}/messages/${MESSAGE_ID}`],
  ["post", `${BASE}/use`],
  ["delete", `${BASE}/temporary`],
  ["post", `${BASE}/original/restore`],
];

beforeEach(() => {
  vi.resetAllMocks();
  mockEnv.SETTINGS_PASSWORD = PASSWORD;
  mockService.getAutoReplyState.mockResolvedValue(STATE);
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe("settings routes — auth gate", () => {
  it.each(ALL_ROUTES)("%s %s answers 503 SETTINGS_DISABLED when no password is configured", async (method, path) => {
    mockEnv.SETTINGS_PASSWORD = undefined;

    const res = await request(app)[method](path).set(AUTH);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "error",
      code: "SETTINGS_DISABLED",
      message: "settings page is not configured",
    });
    expect(mockService.getAutoReplyState).not.toHaveBeenCalled();
  });

  it("treats a blank configured password as not configured", async () => {
    mockEnv.SETTINGS_PASSWORD = "";

    const res = await request(app).get(BASE).set({ Authorization: "Bearer " });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SETTINGS_DISABLED");
  });

  it.each(ALL_ROUTES)("%s %s answers 401 without an Authorization header", async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: "error",
      code: "UNAUTHORIZED",
      message: "Missing or invalid authorization header",
    });
  });

  it("answers 401 for a non-Bearer scheme", async () => {
    const res = await request(app).get(BASE).set({ Authorization: `Basic ${PASSWORD}` });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Missing or invalid authorization header");
  });

  it.each([
    ["a wrong password", "wrong-password-xyz"],
    ["a wrong password of the same length", "correct-horse-batterz"],
    ["a prefix of the password", PASSWORD.slice(0, -1)],
    ["the password with extra characters", `${PASSWORD}!`],
  ])("answers 401 Invalid password for %s", async (_label, token) => {
    const res = await request(app).get(BASE).set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: "error", code: "UNAUTHORIZED", message: "Invalid password" });
    expect(mockService.getAutoReplyState).not.toHaveBeenCalled();
  });

  it("answers 401 for a Bearer header carrying no token", async () => {
    const res = await request(app).get(BASE).set({ Authorization: "Bearer " });

    expect(res.status).toBe(401);
    expect(mockService.getAutoReplyState).not.toHaveBeenCalled();
  });

  it("answers 401, not 500, for a same-length non-ASCII token (differing UTF-8 byte length)", async () => {
    const res = await request(app)
      .get(BASE)
      .set({ Authorization: `Bearer ${"é".repeat(PASSWORD.length)}` });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid password");
  });

  it("checks the password before validating the body (bad body without auth is 401, not 400)", async () => {
    const res = await request(app).post(`${BASE}/messages`).send({ text: "" });

    expect(res.status).toBe(401);
  });

  it("never echoes the configured password in a response", async () => {
    const res = await request(app).get(BASE).set({ Authorization: "Bearer nope-nope-nope" });

    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });
});

// ---------------------------------------------------------------------------
// GET /auto-reply
// ---------------------------------------------------------------------------

describe("GET /api/settings/auto-reply", () => {
  it("returns the current state", async () => {
    const res = await request(app).get(BASE).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", state: STATE });
    expect(mockService.getAutoReplyState).toHaveBeenCalledWith(expect.any(Date));
  });

  it("maps an unexpected failure to a generic 500 without leaking the cause", async () => {
    mockService.getAutoReplyState.mockRejectedValue(new Error("connect ECONNREFUSED secret-host"));

    const res = await request(app).get(BASE).set(AUTH);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      status: "error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });
});

// ---------------------------------------------------------------------------
// POST /auto-reply/messages
// ---------------------------------------------------------------------------

describe("POST /api/settings/auto-reply/messages", () => {
  it("saves the trimmed text and returns the id with the fresh state", async () => {
    mockService.saveMessage.mockResolvedValue(NEW_ID);

    const res = await request(app).post(`${BASE}/messages`).set(AUTH).send({ text: "  שלום עולם  " });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", id: NEW_ID, state: STATE });
    expect(mockService.saveMessage).toHaveBeenCalledWith("שלום עולם");
    expect(mockLogger.info).toHaveBeenCalledWith(
      { id: NEW_ID, text: "שלום עולם" },
      "settings: auto-reply message saved",
    );
  });

  it("accepts exactly 1000 characters", async () => {
    mockService.saveMessage.mockResolvedValue(NEW_ID);

    const res = await request(app).post(`${BASE}/messages`).set(AUTH).send({ text: "א".repeat(1000) });

    expect(res.status).toBe(200);
    expect(mockService.saveMessage).toHaveBeenCalledWith("א".repeat(1000));
  });

  it.each<[label: string, body: unknown]>([
    ["an empty text", { text: "" }],
    ["a whitespace-only text", { text: "   \n\t " }],
    ["a 1001-character text", { text: "א".repeat(1001) }],
    ["a non-string text", { text: 123 }],
    ["a missing text", {}],
  ])("answers 400 VALIDATION_ERROR for %s", async (_label, body) => {
    const res = await request(app).post(`${BASE}/messages`).set(AUTH).send(body as object);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
    expect(mockService.saveMessage).not.toHaveBeenCalled();
  });

  it("answers 400 VALIDATION_ERROR when there is no body at all", async () => {
    const res = await request(app).post(`${BASE}/messages`).set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("maps MESSAGE_LIMIT_REACHED from the service to 400", async () => {
    mockService.saveMessage.mockRejectedValue(
      new AppError(400, "saved message limit reached (50)", "MESSAGE_LIMIT_REACHED"),
    );

    const res = await request(app).post(`${BASE}/messages`).set(AUTH).send({ text: "עוד אחת" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      status: "error",
      code: "MESSAGE_LIMIT_REACHED",
      message: "saved message limit reached (50)",
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /auto-reply/messages/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/settings/auto-reply/messages/:id", () => {
  it("deletes the message and returns the fresh state", async () => {
    mockService.deleteMessage.mockResolvedValue(undefined);

    const res = await request(app).delete(`${BASE}/messages/${MESSAGE_ID}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", state: STATE });
    expect(mockService.deleteMessage).toHaveBeenCalledWith(MESSAGE_ID);
    expect(mockLogger.info).toHaveBeenCalledWith({ id: MESSAGE_ID }, "settings: auto-reply message deleted");
  });

  it.each(["not-a-uuid", "DEFAULT", "1234"])("answers 400 VALIDATION_ERROR for the id %j", async (id) => {
    const res = await request(app).delete(`${BASE}/messages/${id}`).set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(mockService.deleteMessage).not.toHaveBeenCalled();
  });

  it("hides the built-in original: 'default' reaches the service and the fresh state is returned", async () => {
    mockService.deleteMessage.mockResolvedValue(undefined);
    const hiddenState: AutoReplyStateDto = { ...STATE, originalHidden: true, messages: [] };
    mockService.getAutoReplyState.mockResolvedValue(hiddenState);

    const res = await request(app).delete(`${BASE}/messages/default`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", state: hiddenState });
    expect(mockService.deleteMessage).toHaveBeenCalledTimes(1);
    expect(mockService.deleteMessage).toHaveBeenCalledWith("default");
    expect(mockService.deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockService.getAutoReplyState.mock.invocationCallOrder[0]!,
    );
    expect(mockLogger.info).toHaveBeenCalledWith({ id: "default" }, "settings: auto-reply message deleted");
  });

  it("maps NOT_FOUND from the service to 404", async () => {
    mockService.deleteMessage.mockRejectedValue(new NotFoundError("Saved message"));

    const res = await request(app).delete(`${BASE}/messages/${MESSAGE_ID}`).set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: "error", code: "NOT_FOUND", message: "Saved message not found" });
  });
});

// ---------------------------------------------------------------------------
// POST /auto-reply/use
// ---------------------------------------------------------------------------

describe("POST /api/settings/auto-reply/use", () => {
  it("permanent: calls useMessage(id, 'permanent') and returns the fresh state", async () => {
    mockService.useMessage.mockResolvedValue(undefined);

    const res = await request(app).post(`${BASE}/use`).set(AUTH).send({ messageId: MESSAGE_ID, mode: "permanent" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", state: STATE });
    expect(mockService.useMessage).toHaveBeenCalledTimes(1);
    expect(mockService.useMessage).toHaveBeenCalledWith(MESSAGE_ID, "permanent");
    expect(mockService.parseUntil).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { messageId: MESSAGE_ID, mode: "permanent" },
      "settings: auto-reply message set as permanent",
    );
  });

  it("permanent: accepts the built-in 'default' id", async () => {
    mockService.useMessage.mockResolvedValue(undefined);

    const res = await request(app).post(`${BASE}/use`).set(AUTH).send({ messageId: "default", mode: "permanent" });

    expect(res.status).toBe(200);
    expect(mockService.useMessage).toHaveBeenCalledWith("default", "permanent");
  });

  it("temporary: passes the Date returned by parseUntil to useMessage", async () => {
    const until = new Date("2026-10-18T06:00:00.000Z");
    mockService.parseUntil.mockReturnValue(until);
    mockService.useMessage.mockResolvedValue(undefined);

    const res = await request(app)
      .post(`${BASE}/use`)
      .set(AUTH)
      .send({ messageId: MESSAGE_ID, mode: "temporary", until: "2026-10-18T09:00" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", state: STATE });
    expect(mockService.parseUntil).toHaveBeenCalledWith("2026-10-18T09:00", expect.any(Date));
    expect(mockService.useMessage).toHaveBeenCalledWith(MESSAGE_ID, "temporary", until);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { messageId: MESSAGE_ID, mode: "temporary", until: "2026-10-18T06:00:00.000Z" },
      "settings: auto-reply message set as temporary",
    );
  });

  it.each<[label: string, body: unknown]>([
    ["an empty body", {}],
    ["a missing mode", { messageId: MESSAGE_ID }],
    ["an unknown mode", { messageId: MESSAGE_ID, mode: "forever" }],
    ["a non-uuid messageId", { messageId: "nope", mode: "permanent" }],
    ["a missing messageId", { mode: "permanent" }],
    ["a temporary without until", { messageId: MESSAGE_ID, mode: "temporary" }],
    ["until with a space instead of T", { messageId: MESSAGE_ID, mode: "temporary", until: "2026-10-18 09:00" }],
    ["until with seconds", { messageId: MESSAGE_ID, mode: "temporary", until: "2026-10-18T09:00:00" }],
    ["a date-only until", { messageId: MESSAGE_ID, mode: "temporary", until: "2026-10-18" }],
    ["a free-text until", { messageId: MESSAGE_ID, mode: "temporary", until: "tomorrow" }],
    ["a numeric until", { messageId: MESSAGE_ID, mode: "temporary", until: 20261018 }],
  ])("answers 400 VALIDATION_ERROR for %s", async (_label, body) => {
    const res = await request(app).post(`${BASE}/use`).set(AUTH).send(body as object);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
    expect(mockService.useMessage).not.toHaveBeenCalled();
    expect(mockService.parseUntil).not.toHaveBeenCalled();
  });

  it.each([
    ["UNTIL_IN_PAST", "until must be in the future"],
    ["UNTIL_TOO_FAR", "until must be within one year"],
    ["INVALID_UNTIL", "invalid until date/time"],
  ])("maps %s thrown by parseUntil to 400 and never calls useMessage", async (code, message) => {
    mockService.parseUntil.mockImplementation(() => {
      throw new AppError(400, message, code);
    });

    const res = await request(app)
      .post(`${BASE}/use`)
      .set(AUTH)
      .send({ messageId: MESSAGE_ID, mode: "temporary", until: "2026-10-18T09:00" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: "error", code, message });
    expect(mockService.useMessage).not.toHaveBeenCalled();
  });

  it("maps NOT_FOUND thrown by useMessage to 404", async () => {
    mockService.useMessage.mockRejectedValue(new NotFoundError("Saved message"));

    const res = await request(app).post(`${BASE}/use`).set(AUTH).send({ messageId: MESSAGE_ID, mode: "permanent" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: "error", code: "NOT_FOUND", message: "Saved message not found" });
  });
});

// ---------------------------------------------------------------------------
// DELETE /auto-reply/temporary
// ---------------------------------------------------------------------------

describe("DELETE /api/settings/auto-reply/temporary", () => {
  it("clears the temporary message and returns the fresh state", async () => {
    mockService.clearTemporary.mockResolvedValue(undefined);

    const res = await request(app).delete(`${BASE}/temporary`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", state: STATE });
    expect(mockService.clearTemporary).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith("settings: temporary auto-reply cleared");
  });
});

// ---------------------------------------------------------------------------
// POST /auto-reply/original/restore
// ---------------------------------------------------------------------------

describe("POST /api/settings/auto-reply/original/restore", () => {
  it("restores the original message (no body needed) and returns the fresh state", async () => {
    mockService.restoreOriginal.mockResolvedValue(undefined);

    const res = await request(app).post(`${BASE}/original/restore`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", state: STATE });
    expect(mockService.restoreOriginal).toHaveBeenCalledTimes(1);
    expect(mockService.restoreOriginal).toHaveBeenCalledWith();
    expect(mockService.restoreOriginal.mock.invocationCallOrder[0]).toBeLessThan(
      mockService.getAutoReplyState.mock.invocationCallOrder[0]!,
    );
    expect(mockLogger.info).toHaveBeenCalledWith("settings: original auto-reply message restored");
  });

  it("does not call any other mutation", async () => {
    mockService.restoreOriginal.mockResolvedValue(undefined);

    await request(app).post(`${BASE}/original/restore`).set(AUTH);

    expect(mockService.deleteMessage).not.toHaveBeenCalled();
    expect(mockService.saveMessage).not.toHaveBeenCalled();
    expect(mockService.useMessage).not.toHaveBeenCalled();
    expect(mockService.clearTemporary).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking the cause", async () => {
    mockService.restoreOriginal.mockRejectedValue(new Error("connect ECONNREFUSED secret-host"));

    const res = await request(app).post(`${BASE}/original/restore`).set(AUTH);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      status: "error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });
});

// ---------------------------------------------------------------------------
// Logging hygiene
// ---------------------------------------------------------------------------

describe("settings routes — logging", () => {
  it("never logs the password while handling an authenticated mutation", async () => {
    mockService.saveMessage.mockResolvedValue(NEW_ID);

    await request(app).post(`${BASE}/messages`).set(AUTH).send({ text: "שלום" });

    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(PASSWORD);
  });
});
