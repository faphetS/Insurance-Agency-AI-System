import { logger } from "../../config/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import {
  opCreds,
  lastIncomingMessagesWith,
  lastOutgoingMessagesWith,
} from "../whatsapp/whatsapp.service.js";
import { opExcludedChatIds } from "../whatsapp/whatsapp.util.js";
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

  const cutoffTs = Date.now() - 24 * 60 * 60 * 1000;
  const excluded = await getExcludedChatIds();

  const [incoming, outgoing] = await Promise.all([
    lastIncomingMessagesWith(creds, 1440).catch((err: unknown) => {
      logger.warn({ err }, "commitments: lastIncomingMessagesWith failed");
      return [];
    }),
    lastOutgoingMessagesWith(creds, 1440).catch((err: unknown) => {
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
