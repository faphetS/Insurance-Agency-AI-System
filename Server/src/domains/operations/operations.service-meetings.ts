import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";

export interface ServiceMeetingClient {
  id: string;
  name: string;
  lastServiceDate: string | null;
  monthsSinceService: number | null;
  status: "due" | "upcoming" | "ok";
  latestMeetingSummaryStatus: string | null;
}

export interface ServiceMeetingsSummary {
  clients: ServiceMeetingClient[];
  dueCount: number;
  upcomingCount: number;
  milestoneConnected: boolean;
  lastMilestoneSync: null;
}

export async function getServiceMeetingsSummary(): Promise<ServiceMeetingsSummary> {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, full_name, last_service_date")
    .eq("status", "active");

  if (error) {
    logger.error({ error }, "getServiceMeetingsSummary: query failed");
    return { clients: [], dueCount: 0, upcomingCount: 0, milestoneConnected: true, lastMilestoneSync: null };
  }

  const clientIds = (data ?? []).map((r: any) => r.id as string);

  // Fetch the latest meeting per client in a single query
  const summaryStatusMap = new Map<string, string | null>();
  if (clientIds.length > 0) {
    const { data: meetings } = await supabaseAdmin
      .from("meetings")
      .select("client_id, summary_status, scheduled_at")
      .in("client_id", clientIds)
      .order("scheduled_at", { ascending: false });

    for (const m of meetings ?? []) {
      const cid = m.client_id as string;
      if (!summaryStatusMap.has(cid)) {
        summaryStatusMap.set(cid, (m.summary_status as string | null) ?? null);
      }
    }
  }

  const now = new Date();
  let dueCount = 0;
  let upcomingCount = 0;

  const clients: ServiceMeetingClient[] = (data ?? []).map((row: any) => {
    const lastServiceDate = row.last_service_date as string | null;

    let monthsSinceService: number | null = null;
    let status: ServiceMeetingClient["status"];

    if (lastServiceDate === null) {
      status = "due";
    } else {
      const last = new Date(lastServiceDate);
      const diffMs = now.getTime() - last.getTime();
      monthsSinceService = diffMs / (1000 * 60 * 60 * 24 * 30.44);

      if (monthsSinceService > 24) {
        status = "due";
      } else if (monthsSinceService >= 21) {
        status = "upcoming";
      } else {
        status = "ok";
      }
    }

    if (status === "due") dueCount++;
    if (status === "upcoming") upcomingCount++;

    return {
      id: row.id as string,
      name: row.full_name as string,
      lastServiceDate,
      monthsSinceService: monthsSinceService !== null ? Math.round(monthsSinceService) : null,
      status,
      latestMeetingSummaryStatus: summaryStatusMap.get(row.id as string) ?? null,
    };
  });

  return { clients, dueCount, upcomingCount, milestoneConnected: true, lastMilestoneSync: null };
}
