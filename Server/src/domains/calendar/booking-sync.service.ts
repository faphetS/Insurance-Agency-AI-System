import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getAuthenticatedClient } from "./calendar.auth.js";
import { getRecentEvents } from "./calendar.service.js";
import { sendMessage } from "../whatsapp/whatsapp.service.js";

const TZ = "Asia/Jerusalem";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-IL", {
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
    logger.debug("booking-sync: Google Calendar not authorized yet — skipping");
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

    // Extract attendee emails (exclude the calendar owner)
    const attendeeEmails = (event.attendees ?? [])
      .filter((a) => !a.self && a.email)
      .map((a) => a.email!.toLowerCase());

    if (attendeeEmails.length === 0) continue;

    // Match to a client by email
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("id, full_name, email, pipeline_stage")
      .in("email", attendeeEmails)
      .limit(1)
      .single();

    if (!client) {
      logger.info(
        { eventId: event.id, attendees: attendeeEmails, summary: event.summary },
        "booking-sync: no matching client — manual review needed",
      );
      continue;
    }

    // Find pending meeting for this client, or create one
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: pendingMeeting } = await (supabaseAdmin as any)
      .from("meetings")
      .select("id, conversation_id")
      .eq("client_id", client.id)
      .eq("status", "pending_booking")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const meetingUpdate = {
      scheduled_at: event.start.dateTime,
      calendar_event_id: event.id,
      status: "scheduled",
      type: "google_meet",
      updated_at: new Date().toISOString(),
    };

    if (pendingMeeting) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from("meetings")
        .update(meetingUpdate)
        .eq("id", pendingMeeting.id);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from("meetings")
        .insert({ ...meetingUpdate, client_id: client.id });
    }

    // Update client pipeline
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from("clients")
      .update({ pipeline_stage: "meeting_scheduled" })
      .eq("id", client.id);

    // Send WhatsApp confirmation
    const conversationId = pendingMeeting?.conversation_id;
    if (conversationId) {
      const { data: conv } = await supabaseAdmin
        .from("conversations")
        .select("whatsapp_chat_id")
        .eq("id", conversationId)
        .single();

      if (conv?.whatsapp_chat_id) {
        const formattedDate = formatDateTime(event.start.dateTime);
        const confirmMsg = `Your consultation has been confirmed for ${formattedDate}. We'll send you a reminder before the meeting.`;

        try {
          const { idMessage } = await sendMessage(conv.whatsapp_chat_id, confirmMsg);
          await supabaseAdmin.from("messages").insert({
            conversation_id: conversationId,
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
