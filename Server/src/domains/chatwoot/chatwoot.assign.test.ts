import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockResolveConversationId } = vi.hoisted(() => ({
  mockResolveConversationId: vi.fn(),
}));

const envMock = {
  CHATWOOT_BASE_URL: "https://cw.test" as string | undefined,
  CHATWOOT_ACCOUNT_ID: "1" as string | undefined,
  CHATWOOT_BOT_TOKEN: "bot-token" as string | undefined,
  CHATWOOT_ADMIN_TOKEN: undefined as string | undefined,
};

vi.mock("../../config/env.js", () => ({ get env() { return envMock; } }));

vi.mock("../../config/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./chatwoot.service.js", () => ({
  resolveConversationId: mockResolveConversationId,
}));

import { assignConversationForInquiry, resetAssignCache } from "./chatwoot.assign.js";
import { logger } from "../../config/logger.js";

const CHAT = "972501112233@c.us";

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

const AGENTS = [
  { id: 10, email: "merav@shaked-ins.com" },
  { id: 11, email: "hodaya@shaked-ins.com" },
  { id: 12, email: "giti@shaked-ins.com" },
  { id: 13, email: "yafa@shaked-ins.com" },
  { id: 14, email: "didi@ddins.net" },
];

const TEAMS = [{ id: 50, name: "מחלקת חיים, בריאות, פנסיה ופיננסים" }];

beforeEach(() => {
  vi.clearAllMocks();
  resetAssignCache();
  envMock.CHATWOOT_BASE_URL = "https://cw.test";
  envMock.CHATWOOT_ACCOUNT_ID = "1";
  envMock.CHATWOOT_BOT_TOKEN = "bot-token";
  envMock.CHATWOOT_ADMIN_TOKEN = undefined;
  mockResolveConversationId.mockResolvedValue(34);
});

afterEach(() => vi.unstubAllGlobals());

describe("assignConversationForInquiry — routing + assignment POST", () => {
  it("vehicle → POST assignee_id for merav", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, AGENTS))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", mockFetch);

    await assignConversationForInquiry(CHAT, "vehicle");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [agentsUrl, agentsInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(agentsUrl).toBe("https://cw.test/api/v1/accounts/1/agents");
    expect((agentsInit.headers as Record<string, string>)["api_access_token"]).toBe("bot-token");

    const [postUrl, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe("https://cw.test/api/v1/accounts/1/conversations/34/assignments");
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body as string)).toEqual({ assignee_id: 10 });
  });

  it.each(["life_health_pension", "finance"])(
    "%s → POST team_id for the life/health/pension/finance team",
    async (id) => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, TEAMS))
        .mockResolvedValueOnce(jsonResponse(200, {}));
      vi.stubGlobal("fetch", mockFetch);

      await assignConversationForInquiry(CHAT, id);

      const [teamsUrl] = mockFetch.mock.calls[0] as [string];
      expect(teamsUrl).toBe("https://cw.test/api/v1/accounts/1/teams");

      const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(JSON.parse(postInit.body as string)).toEqual({ team_id: 50 });
    },
  );

  it.each(["callback", "meeting"])("%s → routes to didi@ddins.net's agent id", async (id) => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, AGENTS))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", mockFetch);

    await assignConversationForInquiry(CHAT, id);

    const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(postInit.body as string)).toEqual({ assignee_id: 14 });
  });

  it("unknown button id → no fetch at all", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await assignConversationForInquiry(CHAT, "other");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockResolveConversationId).not.toHaveBeenCalled();
    expect(vi.mocked(logger.debug)).toHaveBeenCalled();
  });

  it("missing conversation row → no POST, no throw", async () => {
    mockResolveConversationId.mockResolvedValue(null);
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(assignConversationForInquiry(CHAT, "vehicle")).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("Chatwoot 500 on assignment POST → warns, no throw", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, AGENTS))
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    vi.stubGlobal("fetch", mockFetch);

    await expect(assignConversationForInquiry(CHAT, "vehicle")).resolves.toBeUndefined();

    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("directory cache: two calls → agents endpoint fetched once", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, AGENTS))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", mockFetch);

    await assignConversationForInquiry(CHAT, "vehicle");
    await assignConversationForInquiry(CHAT, "home");

    const agentsFetches = mockFetch.mock.calls.filter(
      ([url]) => url === "https://cw.test/api/v1/accounts/1/agents",
    );
    expect(agentsFetches).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("cache miss for a known email → refetch once → still missing → skip, no throw", async () => {
    const agentsWithoutMerav = AGENTS.filter((a) => a.email !== "merav@shaked-ins.com");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, agentsWithoutMerav))
      .mockResolvedValueOnce(jsonResponse(200, agentsWithoutMerav));
    vi.stubGlobal("fetch", mockFetch);

    await expect(assignConversationForInquiry(CHAT, "vehicle")).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("missing env config → no-op, no throw", async () => {
    envMock.CHATWOOT_BASE_URL = undefined;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(assignConversationForInquiry(CHAT, "vehicle")).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockResolveConversationId).not.toHaveBeenCalled();
  });

  it("uses CHATWOOT_ADMIN_TOKEN over CHATWOOT_BOT_TOKEN when set", async () => {
    envMock.CHATWOOT_ADMIN_TOKEN = "admin-token";
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, AGENTS))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", mockFetch);

    await assignConversationForInquiry(CHAT, "vehicle");

    const [, agentsInit] = [mockFetch.mock.calls[0]![0], mockFetch.mock.calls[0]![1]] as [
      string,
      RequestInit,
    ];
    expect((agentsInit.headers as Record<string, string>)["api_access_token"]).toBe("admin-token");
  });

  it("fetch throw on directory call → warns, no throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(assignConversationForInquiry(CHAT, "vehicle")).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("CHATWOOT_ADMIN_TOKEN='' (present but blank) → falls through to CHATWOOT_BOT_TOKEN", async () => {
    envMock.CHATWOOT_ADMIN_TOKEN = "";
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, AGENTS))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", mockFetch);

    await assignConversationForInquiry(CHAT, "vehicle");

    const [, agentsInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((agentsInit.headers as Record<string, string>)["api_access_token"]).toBe("bot-token");
  });

  it("directory entries with padded/uppercased emails still match the lowercase route", async () => {
    const messyAgents = [{ id: 10, email: "  Merav@Shaked-Ins.com " }];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, messyAgents))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", mockFetch);

    await assignConversationForInquiry(CHAT, "vehicle");

    const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(postInit.body as string)).toEqual({ assignee_id: 10 });
  });

  it("team name with trailing space in the API response still matches", async () => {
    const messyTeams = [{ id: 50, name: "מחלקת חיים, בריאות, פנסיה ופיננסים  " }];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, messyTeams))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", mockFetch);

    await assignConversationForInquiry(CHAT, "finance");

    const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(postInit.body as string)).toEqual({ team_id: 50 });
  });

  describe("assignment POST 404 (conversation deleted in Chatwoot)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("re-resolves without cache and retries once → succeeds", async () => {
      mockResolveConversationId.mockResolvedValueOnce(34).mockResolvedValueOnce(99);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, AGENTS)) // agents directory
        .mockResolvedValueOnce(jsonResponse(404, { error: "not found" })) // first assignment POST
        .mockResolvedValueOnce(jsonResponse(200, {})); // retried assignment POST
      vi.stubGlobal("fetch", mockFetch);

      const promise = assignConversationForInquiry(CHAT, "vehicle");
      await vi.advanceTimersByTimeAsync(5000);
      await promise;

      expect(mockResolveConversationId).toHaveBeenCalledTimes(2);
      expect(mockResolveConversationId).toHaveBeenNthCalledWith(2, CHAT, true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const [postUrl] = mockFetch.mock.calls[2] as [string];
      expect(postUrl).toBe("https://cw.test/api/v1/accounts/1/conversations/99/assignments");
      expect(vi.mocked(logger.info)).toHaveBeenCalled();
    });

    it("re-resolve returns null → warns, no retry POST, no throw", async () => {
      mockResolveConversationId.mockResolvedValueOnce(34).mockResolvedValueOnce(null);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, AGENTS))
        .mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
      vi.stubGlobal("fetch", mockFetch);

      const promise = assignConversationForInquiry(CHAT, "vehicle");
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    });

    it("retry also 404s → warns, no throw", async () => {
      mockResolveConversationId.mockResolvedValueOnce(34).mockResolvedValueOnce(99);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, AGENTS))
        .mockResolvedValueOnce(jsonResponse(404, { error: "not found" }))
        .mockResolvedValueOnce(jsonResponse(404, { error: "still not found" }));
      vi.stubGlobal("fetch", mockFetch);

      const promise = assignConversationForInquiry(CHAT, "vehicle");
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    });
  });
});
