import { env } from "../../../config/env.js";
import { AppError } from "../../../lib/errors.js";
import type {
  TimelessDocumentContent,
  TimelessListMeetingsParams,
  TimelessListMeetingsResponse,
  TimelessMeeting,
  TimelessRecording,
  TimelessTranscript,
  TimelessWebhook,
} from "./timeless.types.js";

const BASE_URL = "https://api.timeless.day/v1";

function getApiKey(): string {
  if (!env.TIMELESS_API_KEY) {
    throw new AppError(
      503,
      "Timeless integration is not configured. Set TIMELESS_API_KEY.",
      "TIMELESS_NOT_CONFIGURED",
    );
  }
  return env.TIMELESS_API_KEY;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const apiKey = getApiKey();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AppError(
      response.status >= 500 ? 502 : response.status,
      `Timeless API error ${response.status}: ${body}`,
      "TIMELESS_API_ERROR",
    );
  }

  return response.json() as Promise<T>;
}

export async function listMeetings(
  params: TimelessListMeetingsParams,
): Promise<TimelessListMeetingsResponse> {
  const qs = new URLSearchParams();
  if (params.id) qs.set("id", params.id);
  if (params.start_date) qs.set("start_date", params.start_date);
  if (params.end_date) qs.set("end_date", params.end_date);
  if (params.status) qs.set("status", params.status);
  if (params.expand) qs.set("expand", params.expand);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));

  return request<TimelessListMeetingsResponse>(`/meetings?${qs.toString()}`);
}

export async function getMeeting(id: string, expand?: string): Promise<TimelessMeeting> {
  const res = await listMeetings({ id, expand: expand ?? "documents" });
  const m = res.data[0];
  if (!m) {
    throw new AppError(404, `Timeless meeting ${id} not found`, "TIMELESS_MEETING_NOT_FOUND");
  }
  return m;
}

export async function getTranscript(id: string): Promise<TimelessTranscript> {
  return request<TimelessTranscript>(`/meetings/${id}/transcript`);
}

export async function getRecording(id: string): Promise<TimelessRecording> {
  return request<TimelessRecording>(`/meetings/${id}/recording`);
}

export async function getDocument(id: string, format = "markdown"): Promise<TimelessDocumentContent> {
  return request<TimelessDocumentContent>(`/documents/${id}?format=${encodeURIComponent(format)}`);
}

export async function listWebhooks(): Promise<TimelessWebhook[]> {
  const result = await request<{ webhooks: TimelessWebhook[] } | TimelessWebhook[]>("/webhooks");
  return Array.isArray(result) ? result : result.webhooks;
}

export async function createWebhook(
  url: string,
  events: string[],
): Promise<TimelessWebhook> {
  return request<TimelessWebhook>("/webhooks", {
    method: "POST",
    body: JSON.stringify({ url, events }),
  });
}

export async function deleteWebhook(id: string): Promise<void> {
  await request<unknown>(`/webhooks/${id}`, { method: "DELETE" });
}
