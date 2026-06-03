import crypto from "node:crypto";
import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../lib/errors.js";
import { createNotification } from "../../operations/operations.service.js";
import { notifyStaffSummaryReady } from "../../operations/operations.staff-notify.js";
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

async function fetchCandidates(startTime: string): Promise<MeetingCandidate[]> {
  const t = new Date(startTime);
  const low = new Date(t.getTime() - 30 * 60 * 1000).toISOString();
  const high = new Date(t.getTime() + 30 * 60 * 1000).toISOString();

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

  const clientIds = [...new Set(meetings.map((m: any) => m.client_id as string))];

  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("id, email")
    .in("id", clientIds);

  const emailMap = new Map<string, string | null>(
    (clients ?? []).map((c: any) => [c.id as string, (c.email as string | null) ?? null]),
  );

  return meetings.map((m: any) => ({
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

  let summaryDraft: string | null = null;
  const summaryDoc = (timelessMeeting.documents ?? [])
    .filter((d) => (d.title ?? "").toLowerCase().includes("summary"))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  if (summaryDoc) {
    const doc = await getDocument(summaryDoc.id, "markdown").catch(() => null);
    summaryDraft = doc?.content ?? null;
  }

  const { error } = await supabaseAdmin
    .from("meetings")
    .update({
      timeless_meeting_id: timelessMeeting.id,
      transcript,
      summary_draft: summaryDraft,
      recording_url: recordingUrl,
      summary_status: "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("id", ourMeetingId);

  if (error) {
    logger.error({ error, ourMeetingId }, "timeless.applyIngest: update failed");
    throw new AppError(500, "Failed to update meeting with Timeless data", "TIMELESS_INGEST_FAILED");
  }

  await createNotification({
    type: "summary_ready",
    title: "Meeting summary ready for approval",
    message: "A meeting transcript and AI summary have arrived from Timeless.",
    severity: "warning",
    client_id: clientId,
    meeting_id: ourMeetingId,
    reference_key: `summary_ready:${ourMeetingId}`,
  });

  await notifyStaffSummaryReady(ourMeetingId);

  logger.info({ ourMeetingId, timelessId: timelessMeeting.id }, "timeless: meeting ingested");
}

export async function ingestTimelessMeeting(meetingId: string): Promise<void> {
  const { data: existingMatch } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("timeless_meeting_id", meetingId)
    .maybeSingle();

  if (existingMatch) {
    logger.debug({ meetingId }, "timeless.ingest: already ingested, skipping");
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
  const participantEmails = new Set(
    timelessMeeting.participants.map((p) => p.email.toLowerCase()),
  );
  const tTime = new Date(timelessMeeting.start_time).getTime();

  type ScoredCandidate = MeetingCandidate & { score: number };

  const scored: ScoredCandidate[] = candidates.map((c) => {
    let score = 0;
    if (c.client_email && participantEmails.has(c.client_email.toLowerCase())) score += 10;
    if (timelessMeeting.host && staffEmails.has(timelessMeeting.host.email.toLowerCase())) score += 5;
    const diffMin = Math.abs(new Date(c.scheduled_at).getTime() - tTime) / 60_000;
    if (diffMin <= 5) score += 5;
    else if (diffMin <= 15) score += 2;
    const src = (timelessMeeting.source ?? "").toLowerCase();
    if (src === "google_meet" && c.type === "google_meet") score += 3;
    if (src === "phone" && c.type === "phone") score += 3;
    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const runnerUp = scored[1];

  if (!top || top.score < 10) {
    const reason: UnmatchedReason = candidates.length === 0 ? "no_candidates" : "low_score";
    await parkUnmatched(timelessMeeting, reason, scored.slice(0, 3).map((c) => c.id));
    return;
  }

  if (runnerUp && top.score - runnerUp.score < 5) {
    await parkUnmatched(timelessMeeting, "ambiguous", scored.slice(0, 3).map((c) => c.id));
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
