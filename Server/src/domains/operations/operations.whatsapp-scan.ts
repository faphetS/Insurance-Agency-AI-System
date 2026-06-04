import {
  getChatHistoryWith,
  lastIncomingMessagesWith,
  lastOutgoingMessagesWith,
  type GreenApiCreds,
  type GreenApiHistoryMessage,
} from "../whatsapp/whatsapp.service.js";
import { logger } from "../../config/logger.js";

const PREVIEW_MAP: Record<string, string> = {
  imageMessage: "[image]",
  videoMessage: "[video]",
  documentMessage: "[document]",
  audioMessage: "[audio]",
  stickerMessage: "[sticker]",
  locationMessage: "[location]",
  contactMessage: "[contact]",
};

function buildPreview(msg: GreenApiHistoryMessage): string {
  if (msg.textMessage) return msg.textMessage;
  return PREVIEW_MAP[msg.typeMessage] ?? `[${msg.typeMessage}]`;
}

interface LatestMessage {
  type: "incoming" | "outgoing";
  typeMessage: string;
  preview: string;
  at: string;
}

export interface ScanResult {
  chatId: string;
  messageCount: number;
  latest: LatestMessage | null;
  hoursSinceLatest: number | null;
  thresholdHours: number;
  isUnanswered: boolean;
  reason: string;
}

export async function scanChatForUnanswered(
  creds: GreenApiCreds,
  input: string,
  opts?: { thresholdHours?: number; count?: number },
): Promise<ScanResult> {
  // PH number — no Israeli normalization
  const chatId = input.includes("@") ? input : `${input.replace(/\D/g, "")}@c.us`;
  const thresholdHours = opts?.thresholdHours ?? 4;
  const count = opts?.count ?? 20;

  const history = await getChatHistoryWith(creds, chatId, count);

  if (history.length === 0) {
    const result: ScanResult = {
      chatId,
      messageCount: 0,
      latest: null,
      hoursSinceLatest: null,
      thresholdHours,
      isUnanswered: false,
      reason: "no history",
    };
    logger.info(result, "whatsapp-scan: result");
    return result;
  }

  const latest = history[0];

  if (latest.type === "outgoing") {
    const result: ScanResult = {
      chatId,
      messageCount: history.length,
      latest: {
        type: latest.type,
        typeMessage: latest.typeMessage,
        preview: buildPreview(latest),
        at: new Date(latest.timestamp * 1000).toISOString(),
      },
      hoursSinceLatest: Math.round((Date.now() - latest.timestamp * 1000) / 3_600_000 * 100) / 100,
      thresholdHours,
      isUnanswered: false,
      reason: "last message was a reply",
    };
    logger.info(result, "whatsapp-scan: result");
    return result;
  }

  const ageHours = (Date.now() - latest.timestamp * 1000) / 3_600_000;
  const isUnanswered = ageHours > thresholdHours;

  const result: ScanResult = {
    chatId,
    messageCount: history.length,
    latest: {
      type: latest.type,
      typeMessage: latest.typeMessage,
      preview: buildPreview(latest),
      at: new Date(latest.timestamp * 1000).toISOString(),
    },
    hoursSinceLatest: Math.round(ageHours * 100) / 100,
    thresholdHours,
    isUnanswered,
    reason: isUnanswered ? "inbound, no reply for >threshold" : "inbound, within threshold",
  };
  logger.info(result, "whatsapp-scan: result");
  return result;
}

export interface DayScanThread {
  chatId: string;
  sender: string;
  at: string;
  hoursSince: number;
  preview: string;
}

export interface DayScanResult {
  window: { start: string; end: string; tz: string };
  incomingCount: number;
  outgoingCount: number;
  chatsWithInbound: number;
  unansweredCount: number;
  unanswered: DayScanThread[];
}

function dayWindow(fromHour: number, tz: string, now = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((a, x) => {
      a[x.type] = x.value;
      return a;
    }, {});
  const tzHour = p.hour === "24" ? 0 : Number(p.hour);
  const secsSinceMidnight = tzHour * 3600 + Number(p.minute) * 60 + Number(p.second);
  const boundary = fromHour * 3600;
  let end = new Date(now.getTime() - (secsSinceMidnight - boundary) * 1000);
  if (secsSinceMidnight < boundary) end = new Date(end.getTime() - 24 * 3600 * 1000);
  const start = new Date(end.getTime() - 24 * 3600 * 1000);
  return { start, end };
}

export async function scanDayUnanswered(
  creds: GreenApiCreds,
  opts?: {
    fromHour?: number;
    tz?: string;
    thresholdHours?: number;
    windowMinutes?: number;
  },
): Promise<DayScanResult> {
  const fromHour = opts?.fromHour ?? 8;
  const tz = opts?.tz ?? "Asia/Jerusalem";
  const thresholdHours = opts?.thresholdHours ?? 0;

  let start: Date;
  let end: Date;
  if (opts?.windowMinutes != null) {
    end = new Date();
    start = new Date(Date.now() - opts.windowMinutes * 60_000);
  } else {
    ({ start, end } = dayWindow(fromHour, tz));
  }

  const minutes = Math.ceil((Date.now() - start.getTime()) / 60_000) + 2;
  const [inc, out] = await Promise.all([lastIncomingMessagesWith(creds, minutes), lastOutgoingMessagesWith(creds, minutes)]);

  const startMs = start.getTime();
  const endMs = end.getTime();

  const latestInbound = new Map<string, GreenApiHistoryMessage>();
  for (const msg of inc) {
    if (!msg.chatId.endsWith("@c.us")) continue;
    const ts = msg.timestamp * 1000;
    if (ts < startMs || ts > endMs) continue;
    const prev = latestInbound.get(msg.chatId);
    if (!prev || msg.timestamp > prev.timestamp) latestInbound.set(msg.chatId, msg);
  }

  // Outbound checked up to now so a late reply still counts as answered
  const latestOutbound = new Map<string, number>();
  for (const msg of out) {
    const prev = latestOutbound.get(msg.chatId) ?? 0;
    if (msg.timestamp > prev) latestOutbound.set(msg.chatId, msg.timestamp);
  }

  const unanswered: DayScanThread[] = [];
  for (const [chatId, msg] of latestInbound) {
    const latestOutTs = latestOutbound.get(chatId) ?? 0;
    if (latestOutTs > msg.timestamp) continue;
    const ageHours = (Date.now() - msg.timestamp * 1000) / 3_600_000;
    if (ageHours <= thresholdHours) continue;
    const sender = msg.senderName ?? msg.senderContactName ?? chatId.split("@")[0];
    unanswered.push({
      chatId,
      sender,
      at: new Date(msg.timestamp * 1000).toISOString(),
      hoursSince: Math.round(ageHours * 100) / 100,
      preview: buildPreview(msg),
    });
  }

  unanswered.sort((a, b) => b.hoursSince - a.hoursSince);

  const window = { start: start.toISOString(), end: end.toISOString(), tz };
  const chatsWithInbound = latestInbound.size;
  const unansweredCount = unanswered.length;

  logger.info(
    { window, incomingCount: inc.length, outgoingCount: out.length, chatsWithInbound, unansweredCount },
    "whatsapp-day-scan: result",
  );

  return {
    window,
    incomingCount: inc.length,
    outgoingCount: out.length,
    chatsWithInbound,
    unansweredCount,
    unanswered,
  };
}
