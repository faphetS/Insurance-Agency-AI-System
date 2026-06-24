export type CommitmentDirection = "outgoing" | "incoming";
export type CommitmentKind = "timed" | "date_only" | "floating";
export type CommitmentStatus = "pending" | "sent" | "cancelled";

export interface Commitment {
  id: string;
  chat_id: string;
  contact_name: string;
  direction: CommitmentDirection;
  source_message_id: string;
  source_text: string;
  commitment_text: string;
  counterparty: string;
  due_date: string | null;
  due_time: string | null;
  kind: CommitmentKind;
  fire_at: string;
  status: CommitmentStatus;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DetectedCommitment {
  direction: CommitmentDirection;
  who: string;
  what: string;
  date: string | null;
  time: string | null;
}

export interface TranscriptLine {
  ts: number;
  fromDidi: boolean;
  text: string;
}

export interface ChatTranscript {
  chatId: string;
  contactName: string;
  lines: TranscriptLine[];
  latestTs: number;
}
