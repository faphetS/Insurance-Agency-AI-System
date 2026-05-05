import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getAuthenticatedClient } from "./calendar.auth.js";
import { getRecentEvents } from "./calendar.service.js";
import { sendMessage } from "../whatsapp/whatsapp.service.js";
import type { calendar_v3 } from "googleapis";

const TZ = "Asia/Jerusalem";

interface MatchResult {
  client: { id: string; full_name: string; email: string | null; pipeline_stage: string | null };
  tier: 1 | 2 | 3;
  pendingMeeting?: { id: string; conversation_id: string | null };
}

async function matchEventToClient(event: calendar_v3.Schema$Event): Promise<MatchResult | null> {
  const attendees = (event.attendees ?? []).filter((a) => !a.self);

  // Tier 1: email match
  const attendeeEmails = attendees.filter((a) => a.email).map((a) => a.email!.toLowerCase());
  if (attendeeEmails.length > 0) {
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("id, full_name, email, pipeline_stage")
      .in("email", attendeeEmails)
      .limit(1)
      .maybeSingle();
    if (client) return { client, tier: 1 };
  }

  // Tier 2: name match (only for clients in meeting_scheduling stage)
  const attendeeNames = attendees.filter((a) => a.displayName).map((a) => a.displayName!);
  for (const name of attendeeNames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: nameMatches } = await (supabaseAdmin as any)
      .from("clients")
      .select("id, full_name, email, pipeline_stage")
      .ilike("full_name", name)
      .eq("pipeline_stage", "meeting_scheduling");
    if (nameMatches && nameMatches.length === 1) {
      return { client: nameMatches[0], tier: 2 };
    }
  }

  // Tier 3: pending booking time-proximity
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pendingMeetings } = await (supabaseAdmin as any)
    .from("meetings")
    .select("id, conversation_id, created_at, client_id, clients(id, full_name, email, pipeline_stage)")
    .eq("status", "pending_booking")
    .is("calendar_event_id", null);

  if (!pendingMeetings || pendingMeetings.length === 0) return null;

  if (pendingMeetings.length === 1) {
    const m = pendingMeetings[0];
    return { client: m.clients, tier: 3, pendingMeeting: { id: m.id, conversation_id: m.conversation_id } };
  }

  const eventCreated = event.created ? new Date(event.created).getTime() : Date.now();
  const closest = pendingMeetings.reduce((best: (typeof pendingMeetings)[0], m: (typeof pendingMeetings)[0]) => {
    const bestDiff = Math.abs(new Date(best.created_at).getTime() - eventCreated);
    const mDiff = Math.abs(new Date(m.created_at).getTime() - eventCreated);
    return mDiff < bestDiff ? m : best;
  });

  return {
    client: closest.clients,
    tier: 3,
    pendingMeeting: { id: closest.id, conversation_id: closest.conversation_id },
  };
}

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

    const match = await matchEventToClient(event);
    if (!match) {
      logger.info({ eventId: event.id, summary: event.summary }, "booking-sync: no match found across all tiers");
      continue;
    }
    const client = match.client;
    logger.info({ clientId: client.id, tier: match.tier }, "booking-sync: matched client");

    // Backfill email when matched via Tier 2 or 3
    if (match.tier > 1 && !client.email) {
      const firstAttendeeEmail = (event.attendees ?? [])
        .filter((a) => !a.self && a.email)
        .map((a) => a.email!.toLowerCase())[0];
      if (firstAttendeeEmail) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabaseAdmin as any)
          .from("clients")
          .update({ email: firstAttendeeEmail })
          .eq("id", client.id);
        client.email = firstAttendeeEmail;
      }
    }

    // Use pending meeting from Tier 3 directly, or query for this client
    let pendingMeeting = match.pendingMeeting ?? null;
    if (!pendingMeeting) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabaseAdmin as any)
        .from("meetings")
        .select("id, conversation_id")
        .eq("client_id", client.id)
        .eq("status", "pending_booking")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      pendingMeeting = data;
    }

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
