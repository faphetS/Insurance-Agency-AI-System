import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getAuthenticatedClient } from "./calendar.auth.js";
import { getRecentEvents } from "./calendar.service.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";
import type { calendar_v3 } from "googleapis";

const TZ = "Asia/Jerusalem";

// Booking thank-you (v4.1). The old text promised a reminder — the 24h/1h
// reminder loops stay OFF, so the promise is gone with them.
const buildThankYou = (formattedDate: string): string =>
  `תודה! הפגישה נקבעה בהצלחה לתאריך ${formattedDate}. נתראה בפגישה.`;

interface MatchedClient {
  id: string;
  full_name: string;
  email: string | null;
  pipeline_stage: string | null;
}

/**
 * Email-only matching (v4.1): the intake bot stores clients.email lowercased
 * before handing out the booking link, so attendee-email equality is the
 * single matching signal. The old name / pending-booking fallbacks were
 * removed — nothing has created pending_booking rows since intake v4.
 */
async function matchEventToClient(
  event: calendar_v3.Schema$Event,
): Promise<MatchedClient | null> {
  const attendeeEmails = (event.attendees ?? [])
    .filter((a) => !a.self && a.email)
    .map((a) => a.email!.toLowerCase());
  if (attendeeEmails.length === 0) return null;

  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("id, full_name, email, pipeline_stage")
    .in("email", attendeeEmails)
    .in("status", ["new", "active"])
    .limit(1)
    .maybeSingle();
  return (client as MatchedClient | null) ?? null;
}

function extractZoomLink(event: calendar_v3.Schema$Event): string | null {
  const ZOOM_RE = /https?:\/\/[a-z0-9.-]*zoom\.us\/[^\s"'<>]+/i;

  const locationMatch = event.location?.match(ZOOM_RE);
  if (locationMatch) return locationMatch[0];

  for (const ep of event.conferenceData?.entryPoints ?? []) {
    const epMatch = ep.uri?.match(ZOOM_RE);
    if (epMatch) return epMatch[0];
  }

  const descMatch = event.description?.match(ZOOM_RE);
  if (descMatch) return descMatch[0];

  return null;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export async function syncNewBookings(): Promise<void> {
  let authClient;
  try {
    authClient = await getAuthenticatedClient();
  } catch {
    logger.info("booking-sync: Google Calendar not authorized yet — skipping");
    return;
  }

  // Load last sync time
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: syncSetting } = await (supabaseAdmin as any)
    .from("system_settings")
    .select("value")
    .eq("key", "google_calendar_last_sync")
    .single();

  const since = syncSetting?.value
    ? new Date(syncSetting.value)
    : new Date(Date.now() - 60 * 60 * 1000); // default: 1 hour ago

  const events = await getRecentEvents(authClient, env.GOOGLE_CALENDAR_ID, since);
  logger.info({ count: events.length }, "booking-sync: fetched calendar events");

  for (const event of events) {
    if (!event.id || !event.start?.dateTime) continue;

    // Skip if already tracked
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (supabaseAdmin as any)
      .from("meetings")
      .select("id")
      .eq("calendar_event_id", event.id)
      .maybeSingle();

    if (existing) continue;

    const client = await matchEventToClient(event);
    if (!client) {
      logger.info({ eventId: event.id, summary: event.summary }, "booking-sync: no client with matching attendee email");
      continue;
    }
    logger.info({ clientId: client.id }, "booking-sync: matched client by email");

    const zoomLink = extractZoomLink(event);

    const { data: conv } = await supabaseAdmin
      .from("conversations")
      .select("id, whatsapp_chat_id")
      .eq("client_id", client.id)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const now = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: insertErr } = await (supabaseAdmin as any)
      .from("meetings")
      .insert({
        client_id: client.id,
        conversation_id: conv?.id ?? null,
        scheduled_at: event.start.dateTime,
        calendar_event_id: event.id,
        status: "scheduled",
        type: zoomLink ? "zoom" : "google_meet",
        created_at: now,
        updated_at: now,
      });
    if (insertErr) {
      // Also swallows the meetings_calendar_event_id_uidx race — the losing
      // run skips the event entirely, so the thank-you can't double-send.
      logger.error({ err: insertErr, clientId: client.id, eventId: event.id }, "booking-sync: failed to insert meeting");
      continue;
    }

    // Update client pipeline
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from("clients")
      .update({ pipeline_stage: "meeting_scheduled" })
      .eq("id", client.id);

    // Send the WhatsApp thank-you (best-effort — the meeting row is already in)
    if (conv?.whatsapp_chat_id) {
      let confirmMsg = buildThankYou(formatDateTime(event.start.dateTime));
      if (zoomLink) confirmMsg += `\n\nקישור לפגישת זום: ${zoomLink}`;

      try {
        const { idMessage } = await sendMessageWithTyping(conv.whatsapp_chat_id, confirmMsg);
        await supabaseAdmin.from("messages").insert({
          conversation_id: conv.id,
          direction: "outbound",
          sent_by: "bot",
          body: confirmMsg,
          status: "sent",
          whatsapp_message_id: idMessage,
        });
      } catch (err) {
        logger.error({ err, clientId: client.id }, "booking-sync: failed to send confirmation");
      }
    }

    logger.info(
      { clientId: client.id, eventId: event.id, scheduledAt: event.start.dateTime },
      "booking-sync: meeting confirmed",
    );
  }

  // Update last sync time
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from("system_settings")
    .upsert(
      { key: "google_calendar_last_sync", value: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
}
