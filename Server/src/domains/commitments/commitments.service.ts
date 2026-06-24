import cron from "node-cron";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { scanCreds, type GreenApiCreds } from "../whatsapp/whatsapp.service.js";
import { scanRecentChats } from "./commitments.scan.js";
import { detectCommitments } from "./commitments.detector.js";
import { fireMorningBatch, fireTimedReminders } from "./commitments.reminders.js";

interface WaSettingsResponse {
  wid?: string;
  phone?: string;
}

function instance1Creds(): GreenApiCreds {
  return {
    idInstance: env.GREENAPI_ID_INSTANCE,
    token: env.GREENAPI_API_TOKEN,
    baseUrl: env.GREENAPI_BASE_URL,
  };
}

async function fetchInstancePhone(creds: GreenApiCreds): Promise<string | null> {
  try {
    const url = `${creds.baseUrl}/waInstance${creds.idInstance}/getWaSettings/${creds.token}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as WaSettingsResponse;
    // wid is typically "972XXXXXXXXX@c.us" — normalise to @c.us form
    const raw = data.wid ?? data.phone ?? null;
    if (!raw) return null;
    const digits = raw.replace("@c.us", "").replace(/\D/g, "");
    return digits ? `${digits}@c.us` : null;
  } catch {
    return null;
  }
}

export async function ensureChatIds(): Promise<void> {
  const creds = scanCreds();

  if (creds) {
    const { data: selfRow } = await supabaseAdmin
      .from("system_settings")
      .select("value")
      .eq("key", "commitment_self_chat_id")
      .maybeSingle();

    if (!selfRow?.value) {
      const phone = await fetchInstancePhone(creds);
      if (phone) {
        await supabaseAdmin
          .from("system_settings")
          .upsert(
            { key: "commitment_self_chat_id", value: phone, updated_at: new Date().toISOString() },
            { onConflict: "key" },
          );
        logger.info({ chatId: phone }, "commitments: resolved self-chat ID from instance #2 getWaSettings");
      } else {
        logger.warn("commitments: could not resolve self-chat ID — getWaSettings returned no wid");
      }
    }
  }

  const { data: botRow } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "commitment_bot_chat_id")
    .maybeSingle();

  if (!botRow?.value) {
    try {
      const mainCreds = instance1Creds();
      const phone = await fetchInstancePhone(mainCreds);
      if (phone) {
        await supabaseAdmin
          .from("system_settings")
          .upsert(
            { key: "commitment_bot_chat_id", value: phone, updated_at: new Date().toISOString() },
            { onConflict: "key" },
          );
        logger.info({ chatId: phone }, "commitments: resolved bot-chat ID from instance #1 getWaSettings");
      }
    } catch (err) {
      logger.warn({ err }, "commitments: could not resolve bot-chat ID from instance #1");
    }
  }
}

export async function runMorningCommitments(): Promise<void> {
  if (!scanCreds()) {
    logger.info("commitments: scan creds unset — skipping morning run");
    return;
  }

  try {
    await ensureChatIds();
  } catch (err) {
    logger.warn({ err }, "commitments: ensureChatIds failed — continuing");
  }

  try {
    const transcripts = await scanRecentChats();
    logger.info({ count: transcripts.length }, "commitments: scanned chats");
    await detectCommitments(transcripts);
  } catch (err) {
    logger.error({ err }, "commitments: scan/detect phase failed");
  }

  try {
    await fireMorningBatch();
  } catch (err) {
    logger.error({ err }, "commitments: fireMorningBatch failed");
  }
}

export function startCommitmentCrons(): void {
  cron.schedule(
    "0 8 * * *",
    () => {
      runMorningCommitments().catch((err: unknown) =>
        logger.error({ err }, "commitments: morning run failed"),
      );
    },
    { timezone: "Asia/Jerusalem" },
  );

  setInterval(() => {
    fireTimedReminders().catch((err: unknown) =>
      logger.error({ err }, "commitments: fireTimedReminders failed"),
    );
  }, 15 * 60 * 1000);

  logger.info("commitment crons started");
}
