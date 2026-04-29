import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { calendar_v3 } from "googleapis";

export async function getRecentEvents(
  authClient: OAuth2Client,
  calendarId: string,
  since: Date,
): Promise<calendar_v3.Schema$Event[]> {
  const calendar = google.calendar({ version: "v3", auth: authClient });

  const res = await calendar.events.list({
    calendarId,
    updatedMin: since.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  return res.data.items ?? [];
}
