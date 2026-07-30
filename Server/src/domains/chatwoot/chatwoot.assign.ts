import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { resolveConversationId } from "./chatwoot.service.js";

interface ChatwootConfig {
  apiBase: string;
  token: string;
}

type Route =
  | { kind: "agent"; email: string }
  | { kind: "team"; name: string };

const LIFE_HEALTH_PENSION_TEAM = "מחלקת חיים, בריאות, פנסיה ופיננסים";

const ROUTES: Record<string, Route> = {
  vehicle: { kind: "agent", email: "merav@shaked-ins.com" },
  home: { kind: "agent", email: "hodaya@shaked-ins.com" },
  business: { kind: "agent", email: "giti@shaked-ins.com" },
  travel: { kind: "agent", email: "yafa@shaked-ins.com" },
  life_health_pension: { kind: "team", name: LIFE_HEALTH_PENSION_TEAM },
  finance: { kind: "team", name: LIFE_HEALTH_PENSION_TEAM },
  callback: { kind: "agent", email: "didi@ddins.net" },
  meeting: { kind: "agent", email: "didi@ddins.net" },
};

let agentsCache: Map<string, number> | null = null;
let teamsCache: Map<string, number> | null = null;

export function resetAssignCache(): void {
  agentsCache = null;
  teamsCache = null;
}

function config(): ChatwootConfig | null {
  const base = env.CHATWOOT_BASE_URL;
  const account = env.CHATWOOT_ACCOUNT_ID;
  const token = env.CHATWOOT_ADMIN_TOKEN || env.CHATWOOT_BOT_TOKEN;
  if (!base || !account || !token) return null;
  return { apiBase: `${base}/api/v1/accounts/${account}`, token };
}

async function fetchDirectory(
  cfg: ChatwootConfig,
  path: string,
  keyOf: (item: Record<string, unknown>) => string | null,
): Promise<Map<string, number> | null> {
  try {
    const res = await fetch(`${cfg.apiBase}${path}`, { headers: { api_access_token: cfg.token } });
    if (!res.ok) {
      logger.warn({ status: res.status, path }, "chatwoot assign: directory fetch failed");
      return null;
    }
    const data: unknown = await res.json().catch(() => null);
    if (!Array.isArray(data)) return null;

    const map = new Map<string, number>();
    for (const item of data) {
      const rec = item as Record<string, unknown>;
      const id = Number(rec["id"]);
      const key = keyOf(rec);
      if (Number.isFinite(id) && id > 0 && key) map.set(key, id);
    }
    return map;
  } catch (err) {
    logger.warn({ err, path }, "chatwoot assign: directory fetch threw — continuing");
    return null;
  }
}

async function getAgentsMap(cfg: ChatwootConfig, force = false): Promise<Map<string, number> | null> {
  if (agentsCache && !force) return agentsCache;
  const map = await fetchDirectory(cfg, "/agents", (r) =>
    typeof r["email"] === "string" ? r["email"].trim().toLowerCase() : null,
  );
  if (map) agentsCache = map;
  return map;
}

async function getTeamsMap(cfg: ChatwootConfig, force = false): Promise<Map<string, number> | null> {
  if (teamsCache && !force) return teamsCache;
  const map = await fetchDirectory(cfg, "/teams", (r) =>
    typeof r["name"] === "string" ? r["name"].trim() : null,
  );
  if (map) teamsCache = map;
  return map;
}

async function resolveAssignmentBody(
  cfg: ChatwootConfig,
  route: Route,
): Promise<Record<string, number> | null> {
  if (route.kind === "agent") {
    const email = route.email.trim().toLowerCase();
    let map = await getAgentsMap(cfg);
    let id = map?.get(email);
    if (id === undefined) {
      map = await getAgentsMap(cfg, true);
      id = map?.get(email);
    }
    if (id === undefined) {
      logger.warn({ email: route.email }, "chatwoot assign: agent not found in directory — skipping");
      return null;
    }
    return { assignee_id: id };
  }

  const name = route.name.trim();
  let map = await getTeamsMap(cfg);
  let id = map?.get(name);
  if (id === undefined) {
    map = await getTeamsMap(cfg, true);
    id = map?.get(name);
  }
  if (id === undefined) {
    logger.warn({ name: route.name }, "chatwoot assign: team not found in directory — skipping");
    return null;
  }
  return { team_id: id };
}

function postAssignment(
  cfg: ChatwootConfig,
  conversationId: number,
  body: Record<string, number>,
): Promise<Response> {
  return fetch(`${cfg.apiBase}/conversations/${conversationId}/assignments`, {
    method: "POST",
    headers: { api_access_token: cfg.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Best-effort — never throws. Fires on every button tap; in practice the latest tap wins
// (taps are seconds apart), but POST ordering is not strictly guaranteed under concurrency.
export async function assignConversationForInquiry(chatId: string, buttonId: string): Promise<void> {
  try {
    const route = ROUTES[buttonId];
    if (!route) {
      logger.debug({ chatId, buttonId }, "chatwoot assign: no route for button — skipping");
      return;
    }

    const cfg = config();
    if (!cfg) {
      logger.debug("chatwoot assign: Chatwoot not configured — skipping");
      return;
    }

    const conversationId = await resolveConversationId(chatId);
    if (!conversationId) {
      logger.warn({ chatId, buttonId }, "chatwoot assign: no conversation id — skipping");
      return;
    }

    const body = await resolveAssignmentBody(cfg, route);
    if (!body) return;

    let finalConversationId = conversationId;
    let res = await postAssignment(cfg, finalConversationId, body);

    if (res.status === 404) {
      // Conversation deleted in Chatwoot — the mirror path rebuilds a new one on its own
      // message; give it a moment, then re-resolve without the warm cache and retry once.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const freshId = await resolveConversationId(chatId, true);
      if (!freshId) {
        logger.warn(
          { chatId, buttonId, conversationId },
          "chatwoot assign: conversation gone and could not be re-resolved — giving up",
        );
        return;
      }
      finalConversationId = freshId;
      res = await postAssignment(cfg, finalConversationId, body);
      if (res.status === 404) {
        logger.warn(
          { chatId, buttonId, conversationId: finalConversationId },
          "chatwoot assign: conversation still not found after retry — giving up",
        );
        return;
      }
    }

    if (res.ok) {
      logger.info(
        { chatId, buttonId, conversationId: finalConversationId, ...body },
        `chatwoot assign — routed ${buttonId} to ${route.kind === "agent" ? route.email : route.name}`,
      );
    } else {
      logger.warn(
        { chatId, buttonId, status: res.status },
        "chatwoot assign: assignment POST failed",
      );
    }
  } catch (err) {
    logger.warn({ err, chatId, buttonId }, "chatwoot assign: unexpected failure — continuing");
  }
}
