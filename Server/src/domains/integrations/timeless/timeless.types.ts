export interface TimelessParticipant {
  email: string;
  name?: string;
}

export interface TimelessHost {
  email: string;
  name?: string;
}

export interface TimelessDocument {
  id: string;
  type: string;
  created_at: string;
  title?: string;
}

export interface TimelessMeeting {
  id: string;
  title?: string;
  start_time: string;
  end_time?: string;
  status: string;
  source?: string;
  host: TimelessHost;
  participants: TimelessParticipant[];
  documents?: TimelessDocument[];
  recording_url?: string;
}

export interface TimelessTranscriptSegment {
  speaker: string;
  text: string;
  start_time?: number;
}

export interface TimelessTranscript {
  meeting_id: string;
  segments: TimelessTranscriptSegment[];
}

export interface TimelessRecording {
  url: string;
  expires_at?: string;
}

export interface TimelessDocumentContent {
  id: string;
  type: string;
  content: string;
}

export interface TimelessWebhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret?: string;
}

export interface TimelessWebhookPayload {
  event: string;
  meeting_id: string;
  [key: string]: unknown;
}

export interface TimelessListMeetingsParams {
  start_date?: string;
  end_date?: string;
  status?: string;
  expand?: string;
  cursor?: string;
  limit?: number;
}

export interface TimelessListMeetingsResponse {
  meetings: TimelessMeeting[];
  next_cursor?: string;
}
