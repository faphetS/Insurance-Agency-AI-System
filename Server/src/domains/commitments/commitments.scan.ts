import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import {
  opCreds,
  lastIncomingMessagesWith,
  lastOutgoingMessagesWith,
} from "../whatsapp/whatsapp.service.js";
import { opExcludedChatIds } from "../whatsapp/whatsapp.util.js";
import { isOpWeekday, isIsraelSunday } from "../operations/op-hours.js";
import type { ChatTranscript, TranscriptLine } from "./commitments.types.js";

async function getExcludedChatIds(): Promise<Set<string>> {
  const excluded = new Set<string>();
  const { data: selfRow } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "commitment_self_chat_id")
    .maybeSingle();
  if (selfRow?.value) excluded.add(selfRow.value as string);

  const { data: botRow } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "commitment_bot_chat_id")
    .maybeSingle();
  if (botRow?.value) excluded.add(botRow.value as string);

  for (const chatId of opExcludedChatIds()) excluded.add(chatId);

  return excluded;
}

export async function scanRecentChats(): Promise<ChatTranscript[]> {
  const creds = opCreds();
  if (!creds) {
    logger.info("commitments: scan creds unset — skipping");
    return [];
  }

  // The morning digest no longer runs on Friday (gated by isWithinOpWindow), so Friday's
  // scan never fires and Thursday's daytime chats would otherwise be lost. Widen Sunday's
  // lookback to 72h so Sunday's scan picks up Thursday's chats instead; the per-message
  // Fri/Sat filter below still drops client weekend messages from the widened window.
  const lookbackHours = isIsraelSunday(new Date()) ? 72 : 24;
  const cutoffTs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const excluded = await getExcludedChatIds();

  const [incoming, outgoing] = await Promise.all([
    lastIncomingMessagesWith(creds, lookbackHours * 60).catch((err: unknown) => {
      logger.warn({ err }, "commitments: lastIncomingMessagesWith failed");
      return [];
    }),
    lastOutgoingMessagesWith(creds, lookbackHours * 60).catch((err: unknown) => {
      logger.warn({ err }, "commitments: lastOutgoingMessagesWith failed");
      return [];
    }),
  ]);

  const allMessages = [...incoming, ...outgoing];

  const byChatId = new Map<string, { lines: TranscriptLine[]; contactName: string; latestTs: number }>();

  for (const msg of allMessages) {
    if (!msg.chatId.endsWith("@c.us")) continue;
    if (excluded.has(msg.chatId)) continue;
    if (!msg.textMessage) continue;
    if (msg.timestamp * 1000 <= cutoffTs) continue;
    // Didi's own weekend replies stay in the transcript (context so the LLM sees handled
    // requests); client weekend messages stay invisible.
    if (msg.type !== "outgoing" && !isOpWeekday(new Date(msg.timestamp * 1000))) continue;

    let entry = byChatId.get(msg.chatId);
    if (!entry) {
      entry = {
        lines: [],
        contactName: msg.senderName ?? msg.senderContactName ?? msg.chatId.replace("@c.us", ""),
        latestTs: 0,
      };
      byChatId.set(msg.chatId, entry);
    }

    entry.lines.push({
      ts: msg.timestamp,
      fromDidi: msg.type === "outgoing",
      text: msg.textMessage,
    });

    if (msg.timestamp > entry.latestTs) {
      entry.latestTs = msg.timestamp;
      if (msg.type === "incoming" && (msg.senderName ?? msg.senderContactName)) {
        entry.contactName = msg.senderName ?? msg.senderContactName ?? entry.contactName;
      }
    }
  }

  const transcripts: ChatTranscript[] = [];
  for (const [chatId, entry] of byChatId) {
    entry.lines.sort((a, b) => a.ts - b.ts);
    transcripts.push({
      chatId,
      contactName: entry.contactName,
      lines: entry.lines,
      latestTs: entry.latestTs,
    });
  }

  return transcripts;
}
