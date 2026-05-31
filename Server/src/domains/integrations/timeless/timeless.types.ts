export interface TimelessParticipant {
  email: string;
  name?: string;
  title?: string | null;
  company?: string | null;
}

export interface TimelessHost {
  id?: string;
  email: string;
  name?: string;
}

export interface TimelessDocument {
  id: string;
  title: string;
  created_at: string;
}

export interface TimelessMeeting {
  id: string;
  title?: string;
  start_time: string;
  end_time?: string;
  status: string;
  source?: string;
  host: TimelessHost | null;
  participants: TimelessParticipant[];
  documents?: TimelessDocument[];
  duration?: number | null;
  created_at?: string;
}

export interface TimelessTranscriptSegment {
  speaker_id: string;
  start_time: number;
  end_time?: number;
  text: string;
}

export interface TimelessTranscript {
  meeting_id: string;
  language?: string;
  speakers: { id: string; name: string }[];
  segments: TimelessTranscriptSegment[];
}

export interface TimelessRecording {
  meeting_id: string;
  recording_url: string | null;
}

export interface TimelessDocumentContent {
  id: string;
  title: string;
  format: string;
  content: string;
  created_at: string;
}

export interface TimelessWebhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret?: string;
}

export interface TimelessWebhookPayload {
  id: string;
  [key: string]: unknown;
}

export interface TimelessListMeetingsParams {
  id?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  expand?: string;
  cursor?: string;
  limit?: number;
}

export interface TimelessListMeetingsResponse {
  data: TimelessMeeting[];
  next_cursor?: string | null;
  has_more?: boolean;
}
