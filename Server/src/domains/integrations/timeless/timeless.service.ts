import crypto from "node:crypto";
import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";
import { ensureHebrew } from "../../ai/ai.service.js";
import { sendMessage, sendButtons } from "../../whatsapp/whatsapp.service.js";
import { toChatId } from "../../whatsapp/whatsapp.util.js";
import { sendOwnerEmail } from "../google/google.gmail.js";
import {
  createWebhook,
  deleteWebhook,
  getDocument,
  getMeeting,
  getRecording,
  getTranscript,
  listWebhooks,
} from "./timeless.client.js";
import type { TimelessMeeting, TimelessTranscript } from "./timeless.types.js";

const WEBHOOK_EVENTS = ["meeting.transcript_ready", "meeting.initial_summary_ready"];

const TZ = "Asia/Jerusalem";

function webhookUrl(): string {
  return `${env.BACKEND_URL}/api/integrations/timeless/webhook`;
}

async function getSystemSetting(key: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (data?.value as string | null) ?? null;
}

async function setSystemSetting(key: string, value: string): Promise<void> {
  await supabaseAdmin
    .from("system_settings")
    .upsert({ key, value }, { onConflict: "key" });
}

export async function ensureWebhookRegistered(): Promise<void> {
  const targetUrl = webhookUrl();

  const existing = await listWebhooks();
  const match = existing.find(
    (wh) =>
      wh.url === targetUrl &&
      wh.enabled &&
      WEBHOOK_EVENTS.every((e) => wh.events.includes(e)),
  );

  if (match) {
    const storedSecret = await getSystemSetting("timeless_webhook_secret");
    if (storedSecret) {
      logger.info({ webhookId: match.id }, "timeless: webhook already registered");
      return;
    }

    // Secret missing — need to re-create so we can capture it
    logger.warn(
      { webhookId: match.id },
      "timeless: webhook exists but secret missing from system_settings — re-creating",
    );
    await deleteWebhook(match.id);
  }

  const created = await createWebhook(targetUrl, WEBHOOK_EVENTS);

  if (!created.secret) {
    throw new AppError(500, "Timeless webhook created but no secret returned", "TIMELESS_NO_SECRET");
  }

  await setSystemSetting("timeless_webhook_id", created.id);
  await setSystemSetting("timeless_webhook_secret", created.secret);

  logger.info({ webhookId: created.id, url: targetUrl }, "timeless: webhook registered");
}

export async function verifySignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): Promise<void> {
  if (!rawBody) throw new AppError(400, "Raw body unavailable for signature verification", "TIMELESS_NO_RAW_BODY");

  if (!signatureHeader) {
    throw new AppError(401, "Missing X-Webhook-Signature header", "TIMELESS_SIG_MISSING");
  }

  const secret = await getSystemSetting("timeless_webhook_secret");
  if (!secret) {
    throw new AppError(503, "Webhook secret not available — run ensureWebhookRegistered first", "TIMELESS_NOT_CONFIGURED");
  }

  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) {
    throw new AppError(401, "Invalid signature format", "TIMELESS_SIG_INVALID");
  }

  const provided = Buffer.from(signatureHeader.slice(prefix.length), "hex");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest();

  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new AppError(401, "Webhook signature mismatch", "TIMELESS_SIG_MISMATCH");
  }
}

function formatTranscript(transcript: TimelessTranscript): string {
  const nameById = new Map(transcript.speakers.map((s) => [s.id, s.name]));
  return transcript.segments
    .map((seg) => {
      const speaker = nameById.get(seg.speaker_id) ?? seg.speaker_id;
      const totalSeconds = Math.floor(seg.start_time);
      const h = Math.floor(totalSeconds / 3600).toString().padStart(2, "0");
      const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
      const s = (totalSeconds % 60).toString().padStart(2, "0");
      return `[${h}:${m}:${s}] ${speaker}: ${seg.text}`;
    })
    .join("\n");
}

interface MeetingCandidate {
  id: string;
  scheduled_at: string;
  type: string;
  client_id: string;
  client_email: string | null;
}

export function isSameIsraelDay(isoA: string, isoB: string): boolean {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  return fmt(isoA) === fmt(isoB);
}

async function fetchCandidates(startTime: string): Promise<MeetingCandidate[]> {
  const t = new Date(startTime);
  const low = new Date(t.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const high = new Date(t.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const { data: meetings, error } = await supabaseAdmin
    .from("meetings")
    .select("id, scheduled_at, type, client_id")
    .gte("scheduled_at", low)
    .lte("scheduled_at", high)
    .in("status", ["scheduled", "confirmed", "in_progress"])
    .is("timeless_meeting_id", null);

  if (error) {
    logger.error({ error }, "timeless.fetchCandidates: query failed");
    return [];
  }

  if (!meetings || meetings.length === 0) return [];

  const sameDayMeetings = (meetings as Array<{ scheduled_at: string; client_id: string; id: string; type: string }>).filter((m) =>
    isSameIsraelDay(m.scheduled_at, startTime),
  );

  if (sameDayMeetings.length === 0) return [];

  const clientIds = [...new Set(sameDayMeetings.map((m: any) => m.client_id as string))];

  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("id, email")
    .in("id", clientIds);

  const emailMap = new Map<string, string | null>(
    (clients ?? []).map((c: any) => [c.id as string, (c.email as string | null) ?? null]),
  );

  return sameDayMeetings.map((m: any) => ({
    id: m.id as string,
    scheduled_at: m.scheduled_at as string,
    type: m.type as string,
    client_id: m.client_id as string,
    client_email: emailMap.get(m.client_id as string) ?? null,
  }));
}

async function fetchStaffEmails(): Promise<Set<string>> {
  const { data } = await supabaseAdmin.from("staff").select("email");
  return new Set((data ?? []).map((s: any) => (s.email as string).toLowerCase()));
}

type UnmatchedReason = "no_candidates" | "low_score" | "ambiguous";

async function parkUnmatched(
  meeting: TimelessMeeting,
  reason: UnmatchedReason,
  candidateMeetingIds: string[],
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("timeless_unmatched_meetings")
    .upsert(
      {
        timeless_meeting_id: meeting.id,
        start_time: meeting.start_time,
        participants: meeting.participants,
        host_email: meeting.host?.email ?? null,
        candidate_meeting_ids: candidateMeetingIds,
        reason,
      },
      { onConflict: "timeless_meeting_id", ignoreDuplicates: true },
    );

  if (error) {
    logger.error({ error, meetingId: meeting.id }, "timeless.parkUnmatched: upsert failed");
  } else {
    logger.info({ timelessId: meeting.id, reason }, "timeless: parked unmatched meeting");
  }
}

// F6: detect summary document by title (Hebrew + English terms) with single-doc fallback
export function resolveSummaryDoc(
  documents: TimelessMeeting["documents"],
): { id: string; title: string; created_at: string } | undefined {
  const docs = documents ?? [];
  const SUMMARY_TERMS = ["summary", "recap", "notes", "minutes", "סיכום", "תקציר"];
  const matched = docs
    .filter((d) => SUMMARY_TERMS.some((term) => (d.title ?? "").toLowerCase().includes(term)))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (matched.length > 0) return matched[0];
  if (docs.length === 1) return docs[0];
  return undefined;
}

function formatMeetingDate(iso: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export async function sendSummaryToOwner(meetingId: string, clientId: string): Promise<void> {
  const chatId = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
  if (!env.SUMMARY_RECIPIENT_PHONE || !chatId) {
    logger.warn({ meetingId }, "timeless: no SUMMARY_RECIPIENT_PHONE configured — skipping owner send");
    return;
  }

  // Load meeting data
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("summary_draft, scheduled_at, recording_url")
    .eq("id", meetingId)
    .maybeSingle();

  if (!meeting || !meeting.summary_draft) {
    logger.warn({ meetingId }, "timeless.sendSummaryToOwner: no summary_draft found");
    return;
  }

  // Load client name
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("full_name")
    .eq("id", clientId)
    .maybeSingle();

  const clientName = (client?.full_name as string | null) ?? "לקוח לא ידוע";

  // Guarantee Hebrew
  const hebrew = await ensureHebrew(meeting.summary_draft as string);

  // Atomic claim — only proceed if not already sent
  const { data: claimed } = await supabaseAdmin
    .from("meetings")
    .update({
      summary_final: hebrew,
      summary_status: "sent",
      updated_at: new Date().toISOString(),
    })
    .eq("id", meetingId)
    .neq("summary_status", "sent")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    logger.debug({ meetingId }, "timeless.sendSummaryToOwner: already sent — skipping");
    return;
  }

  // Build Hebrew WhatsApp body
  const scheduledAt = meeting.scheduled_at as string | null;
  const dateStr = scheduledAt ? formatMeetingDate(scheduledAt) : "תאריך לא ידוע";

  let body = [
    "📋 סיכום פגישה",
    "",
    `לקוח: ${clientName}`,
    `תאריך הפגישה: ${dateStr}`,
    "",
    hebrew,
  ].join("\n");

  if (meeting.recording_url) {
    body += `\n\nהקלטה: ${meeting.recording_url as string}`;
  }

  try {
    // Send via the conversational bot (GreenAPI instance #1) — the owner's required wiring.
    await sendMessage(chatId, body);
    logger.info({ meetingId, clientId }, "timeless: owner summary sent");
  } catch (err) {
    logger.error({ err, meetingId }, "timeless.sendSummaryToOwner: send failed — reverting claim");
    // Revert claim so next poll/event can retry
    await supabaseAdmin
      .from("meetings")
      .update({ summary_status: "draft", summary_final: null })
      .eq("id", meetingId);
    throw err;
  }
}

export async function sendStaffPickerToOwner(meetingId: string): Promise<void> {
  const chatId = toChatId(env.SUMMARY_RECIPIENT_PHONE ?? null);
  if (!chatId) {
    logger.warn({ meetingId }, "timeless.sendStaffPickerToOwner: no SUMMARY_RECIPIENT_PHONE configured");
    return;
  }

  const { data: staffList } = await supabaseAdmin
    .from("staff")
    .select("id, full_name")
    .eq("is_active", true)
    .order("full_name", { ascending: true });

  if (!staffList || staffList.length === 0) {
    logger.warn({ meetingId }, "timeless.sendStaffPickerToOwner: no active staff found");
    return;
  }

  // Idempotency claim
  const { data: claimed } = await supabaseAdmin
    .from("meetings")
    .update({ staff_picker_sent_at: new Date().toISOString() })
    .eq("id", meetingId)
    .is("staff_picker_sent_at", null)
    .select("id")
    .maybeSingle();

  if (!claimed) {
    logger.debug({ meetingId }, "timeless.sendStaffPickerToOwner: already sent — skipping");
    return;
  }

  const buttons = (staffList as Array<{ id: string; full_name: string }>).map((s) => ({
    buttonId: `assign_staff:${meetingId}:${s.id}`,
    buttonText: String(s.full_name).slice(0, 25),
  }));

  await sendButtons(chatId, "👤 בחר/י את הגורם המטפל בלקוח:", buttons);
}

export async function sendClientSummaryEmail(meetingId: string, clientId: string): Promise<void> {
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("full_name, email")
    .eq("id", clientId)
    .maybeSingle();

  const email = (client?.email as string | null) ?? null;
  if (!email) {
    logger.info({ meetingId, clientId }, "timeless.sendClientSummaryEmail: client has no email — skipping");
    return;
  }

  // Idempotency claim
  const { data: claimed } = await supabaseAdmin
    .from("meetings")
    .update({ client_summary_emailed_at: new Date().toISOString() })
    .eq("id", meetingId)
    .is("client_summary_emailed_at", null)
    .select("summary_final, summary_draft")
    .maybeSingle();

  if (!claimed) {
    logger.debug({ meetingId }, "timeless.sendClientSummaryEmail: already sent — skipping");
    return;
  }

  const summaryFinal = (claimed as Record<string, unknown>).summary_final as string | null;
  const summaryDraft = (claimed as Record<string, unknown>).summary_draft as string | null;
  const hebrew = (summaryFinal ?? summaryDraft ?? "").trim();

  if (!hebrew) {
    logger.warn({ meetingId }, "timeless.sendClientSummaryEmail: no summary text — reverting claim");
    await supabaseAdmin
      .from("meetings")
      .update({ client_summary_emailed_at: null })
      .eq("id", meetingId);
    return;
  }

  const fullName = (client?.full_name as string | null) ?? "";
  const subject = "סיכום הפגישה שלך";
  const body = [
    `שלום ${fullName},`,
    "",
    "מצורף סיכום הפגישה שלנו:",
    "",
    hebrew,
    "",
    "בברכה,",
    "צוות שקד",
  ].join("\n");

  try {
    await sendOwnerEmail(email, subject, body);
    logger.info({ meetingId, clientId, email }, "timeless.sendClientSummaryEmail: sent");
  } catch (err) {
    logger.error({ err, meetingId }, "timeless.sendClientSummaryEmail: send failed — reverting claim");
    await supabaseAdmin
      .from("meetings")
      .update({ client_summary_emailed_at: null })
      .eq("id", meetingId);
  }
}

async function applyIngest(
  ourMeetingId: string,
  clientId: string,
  timelessMeeting: TimelessMeeting,
): Promise<void> {
  const [transcriptData, recordingData] = await Promise.all([
    getTranscript(timelessMeeting.id).catch(() => null),
    getRecording(timelessMeeting.id).catch(() => null),
  ]);

  const transcript = transcriptData ? formatTranscript(transcriptData) : null;
  const recordingUrl = recordingData?.recording_url ?? null;

  // F6: robust summary-document detection
  let summaryRaw: string | null = null;
  const summaryDoc = resolveSummaryDoc(timelessMeeting.documents);

  if (summaryDoc) {
    const doc = await getDocument(summaryDoc.id, "markdown").catch(() => null);
    summaryRaw = doc?.content ?? null;
  }

  const { error } = await supabaseAdmin
    .from("meetings")
    .update({
      timeless_meeting_id: timelessMeeting.id,
      transcript,
      summary_draft: summaryRaw,
      recording_url: recordingUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ourMeetingId);

  if (error) {
    logger.error({ error, ourMeetingId }, "timeless.applyIngest: update failed");
    throw new AppError(500, "Failed to update meeting with Timeless data", "TIMELESS_INGEST_FAILED");
  }

  if (summaryRaw) {
    await sendSummaryToOwner(ourMeetingId, clientId);

    // Staff-picker (to owner) + client summary email — each isolated so one failure
    // doesn't block the others. Both are independently idempotent.
    await sendStaffPickerToOwner(ourMeetingId).catch((err: unknown) =>
      logger.error({ err, ourMeetingId }, "timeless: staff-picker send failed"),
    );
    await sendClientSummaryEmail(ourMeetingId, clientId).catch((err: unknown) =>
      logger.error({ err, ourMeetingId }, "timeless: client summary email failed"),
    );
  }

  logger.info({ ourMeetingId, timelessId: timelessMeeting.id, hasSummary: !!summaryRaw }, "timeless: meeting ingested");
}

export async function ingestTimelessMeeting(meetingId: string, event?: string): Promise<void> {
  // F1/F3: check for existing matched meeting (with summary back-fill support)
  const { data: existingMatch } = await supabaseAdmin
    .from("meetings")
    .select("id, client_id, summary_draft, summary_status")
    .eq("timeless_meeting_id", meetingId)
    .maybeSingle();

  if (existingMatch) {
    const existingSummary = (existingMatch.summary_draft as string | null | undefined) ?? "";
    if (existingSummary.trim()) {
      // Already fully ingested with a summary — true idempotency
      logger.debug({ meetingId }, "timeless.ingest: already ingested with summary, skipping");
      return;
    }

    // Back-fill: matched but summary_draft is empty — re-fetch and try to capture the summary
    logger.info({ meetingId, event }, "timeless.ingest: back-filling summary for already-matched meeting");
    const timelessMeeting = await getMeeting(meetingId, "documents");
    await applyIngest(existingMatch.id as string, existingMatch.client_id as string, timelessMeeting);
    return;
  }

  const { data: openUnmatched } = await supabaseAdmin
    .from("timeless_unmatched_meetings")
    .select("id")
    .eq("timeless_meeting_id", meetingId)
    .is("resolved_at", null)
    .maybeSingle();

  if (openUnmatched) {
    logger.debug({ meetingId }, "timeless.ingest: open unmatched entry exists, skipping");
    return;
  }

  const timelessMeeting = await getMeeting(meetingId, "documents");

  const candidates = await fetchCandidates(timelessMeeting.start_time);
  const staffEmails = await fetchStaffEmails();

  // F2: null-guard participant emails
  const participantEmails = new Set(
    timelessMeeting.participants
      .filter((p) => p?.email)
      .map((p) => p.email.toLowerCase()),
  );

  const tTime = new Date(timelessMeeting.start_time).getTime();

  type ScoredCandidate = MeetingCandidate & { score: number };

  const scored: ScoredCandidate[] = candidates.map((c) => {
    let score = 0;
    if (c.client_email && participantEmails.has(c.client_email.toLowerCase())) score += 10;
    // F2: null-guard host email
    if (timelessMeeting.host?.email && staffEmails.has(timelessMeeting.host.email.toLowerCase())) score += 5;
    const diffMin = Math.abs(new Date(c.scheduled_at).getTime() - tTime) / 60_000;
    if (diffMin <= 5) score += 5;
    else if (diffMin <= 15) score += 2;
    const src = (timelessMeeting.source ?? "").toLowerCase();
    if (src === "google_meet" && c.type === "google_meet") score += 3;
    if (src === "phone" && c.type === "phone") score += 3;
    if (src === "zoom" && c.type === "zoom") score += 3;
    return { ...c, score };
  });

  // F7: hard email gate — only auto-match candidates whose client_email is in participantEmails
  const emailMatched = scored.filter(
    (c) => c.client_email && participantEmails.has(c.client_email.toLowerCase()),
  );

  if (emailMatched.length === 0) {
    const reason: UnmatchedReason = candidates.length === 0 ? "no_candidates" : "low_score";
    await parkUnmatched(timelessMeeting, reason, scored.slice(0, 3).map((c) => c.id));
    return;
  }

  // Among email-matched candidates, keep existing scoring for ranking
  emailMatched.sort((a, b) => b.score - a.score);
  const top = emailMatched[0];
  const runnerUp = emailMatched[1];

  if (runnerUp && top.score - runnerUp.score < 5) {
    await parkUnmatched(timelessMeeting, "ambiguous", emailMatched.slice(0, 3).map((c) => c.id));
    return;
  }

  await applyIngest(top.id, top.client_id, timelessMeeting);
}

export async function linkUnmatched(unmatchedId: string, ourMeetingId: string): Promise<void> {
  const { data: unmatched, error: fetchErr } = await supabaseAdmin
    .from("timeless_unmatched_meetings")
    .select("timeless_meeting_id")
    .eq("id", unmatchedId)
    .is("resolved_at", null)
    .single();

  if (fetchErr || !unmatched) {
    throw new AppError(404, "Unmatched meeting not found or already resolved", "NOT_FOUND");
  }

  const { data: meeting, error: meetingErr } = await supabaseAdmin
    .from("meetings")
    .select("id, client_id")
    .eq("id", ourMeetingId)
    .single();

  if (meetingErr || !meeting) {
    throw new AppError(404, "Target meeting not found", "NOT_FOUND");
  }

  const timelessMeeting = await getMeeting(unmatched.timeless_meeting_id as string, "documents");

  await applyIngest(ourMeetingId, meeting.client_id as string, timelessMeeting);

  await supabaseAdmin
    .from("timeless_unmatched_meetings")
    .update({
      resolved_at: new Date().toISOString(),
      resolved_to_meeting_id: ourMeetingId,
    })
    .eq("id", unmatchedId);

  logger.info({ unmatchedId, ourMeetingId }, "timeless: unmatched linked manually");
}

export async function getStatus(): Promise<{
  webhookRegistered: boolean;
  webhookId: string | null;
  lastEventAt: string | null;
  lastPollAt: string | null;
}> {
  const [webhookId, lastEventAt, lastPollAt] = await Promise.all([
    getSystemSetting("timeless_webhook_id"),
    getSystemSetting("timeless_last_event_at"),
    getSystemSetting("timeless_last_poll_at"),
  ]);

  return {
    webhookRegistered: !!webhookId,
    webhookId,
    lastEventAt,
    lastPollAt,
  };
}

export async function recordEvent(): Promise<void> {
  await setSystemSetting("timeless_last_event_at", new Date().toISOString());
}

export async function recordPoll(): Promise<void> {
  await setSystemSetting("timeless_last_poll_at", new Date().toISOString());
}
