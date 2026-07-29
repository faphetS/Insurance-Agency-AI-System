import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { MetaTemplateSpec } from "../whatsapp/meta/meta.transport.js";

const templateParamsSchema = z
  .object({
    name: z.string(),
    language: z.string(),
    processed_params: z
      .object({
        body: z.record(z.string()).optional(),
        header: z
          .object({
            media_url: z.string().optional(),
            media_type: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function normalizeMediaType(type: string | undefined): "image" | "document" | "video" {
  return type === "document" || type === "video" ? type : "image";
}

// Pure — never throws. Returns null on any unparseable shape.
export function buildTemplateSpec(templateParams: unknown): MetaTemplateSpec | null {
  const parsed = templateParamsSchema.safeParse(templateParams);
  if (!parsed.success) return null;

  const { name, language, processed_params } = parsed.data;

  const bodyRecord = processed_params?.body;
  const bodyParams = bodyRecord
    ? Object.entries(bodyRecord)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, value]) => value)
    : undefined;

  const header = processed_params?.header;
  const headerMedia = header?.media_url
    ? { type: normalizeMediaType(header.media_type), link: header.media_url }
    : undefined;

  return {
    name,
    language,
    ...(bodyParams && bodyParams.length > 0 ? { bodyParams } : {}),
    ...(headerMedia ? { headerMedia } : {}),
  };
}

interface GraphTemplatesResponse {
  data?: unknown[];
}

// Best-effort — never throws. Returns null when config is missing or the request fails.
export async function fetchApprovedTemplates(): Promise<unknown[] | null> {
  const wabaId = env.META_WABA_ID;
  const token = env.META_ACCESS_TOKEN;
  if (!wabaId || !token) {
    logger.warn("chatwoot templates: META_WABA_ID or META_ACCESS_TOKEN not set — skipping sync");
    return null;
  }

  const version = env.META_GRAPH_API_VERSION ?? "v24.0";
  const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      logger.warn({ status: res.status }, "chatwoot templates: fetch approved templates failed");
      return null;
    }
    const data = (await res.json().catch(() => null)) as GraphTemplatesResponse | null;
    if (!Array.isArray(data?.data)) return null;
    return data.data.filter((t) => (t as { status?: string })?.status === "APPROVED");
  } catch (err) {
    logger.warn({ err }, "chatwoot templates: fetch approved templates threw — continuing");
    return null;
  }
}

// Best-effort — never throws. Replaces the inbox's whole additional_attributes jsonb,
// so message_templates and agent_reply_time_window are always sent together.
export async function syncTemplatesToChatwoot(): Promise<boolean> {
  const templates = await fetchApprovedTemplates();
  if (!templates) return false;

  const base = env.CHATWOOT_BASE_URL;
  const account = env.CHATWOOT_ACCOUNT_ID;
  const inbox = env.CHATWOOT_INBOX_ID;
  const token = env.CHATWOOT_ADMIN_TOKEN ?? env.CHATWOOT_BOT_TOKEN;
  if (!base || !account || !inbox || !token) {
    logger.warn("chatwoot templates: Chatwoot inbox config incomplete — skipping sync");
    return false;
  }

  const url = `${base}/api/v1/accounts/${account}/inboxes/${inbox}`;

  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { api_access_token: token, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: {
          additional_attributes: {
            message_templates: templates,
            agent_reply_time_window: 24,
          },
        },
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "chatwoot templates: inbox PATCH failed");
      return false;
    }
    logger.info({ count: templates.length }, "chatwoot templates: synced approved templates to inbox");
    return true;
  } catch (err) {
    logger.warn({ err }, "chatwoot templates: inbox PATCH threw — continuing");
    return false;
  }
}

export function startTemplateSyncLoop(): void {
  if (!env.META_WABA_ID || !env.META_ACCESS_TOKEN || !env.CHATWOOT_BASE_URL) {
    logger.debug("chatwoot templates: sync loop not started — config incomplete");
    return;
  }

  setTimeout(() => {
    syncTemplatesToChatwoot().catch((err: unknown) =>
      logger.warn({ err }, "chatwoot templates: initial sync failed"),
    );
  }, 60_000);

  setInterval(() => {
    syncTemplatesToChatwoot().catch((err: unknown) =>
      logger.warn({ err }, "chatwoot templates: scheduled sync failed"),
    );
  }, 3 * 60 * 60 * 1000);
}
