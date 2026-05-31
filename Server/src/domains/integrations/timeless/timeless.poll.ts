import cron from "node-cron";
import { supabaseAdmin } from "../../../config/supabase.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { listMeetings } from "./timeless.client.js";
import { ingestTimelessMeeting, recordPoll } from "./timeless.service.js";

async function runPoll(): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  let cursor: string | undefined;
  const timelessIds: string[] = [];

  do {
    const page = await listMeetings({
      start_date: yesterday,
      status: "completed",
      expand: "documents",
      cursor,
      limit: 50,
    });

    for (const m of page.data) {
      timelessIds.push(m.id);
    }

    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  if (timelessIds.length === 0) {
    await recordPoll();
    return;
  }

  const { data: alreadyIngested } = await supabaseAdmin
    .from("meetings")
    .select("timeless_meeting_id")
    .in("timeless_meeting_id", timelessIds)
    .not("timeless_meeting_id", "is", null);

  const ingestedSet = new Set(
    (alreadyIngested ?? []).map((r) => r.timeless_meeting_id as string),
  );

  const toIngest = timelessIds.filter((id) => !ingestedSet.has(id));

  logger.info(
    { total: timelessIds.length, toIngest: toIngest.length },
    "timeless.poll: running",
  );

  for (const id of toIngest) {
    await ingestTimelessMeeting(id).catch((err: unknown) =>
      logger.error({ err, timelessId: id }, "timeless.poll: ingest failed for meeting"),
    );
  }

  await recordPoll();
  logger.info({ ingested: toIngest.length }, "timeless.poll: complete");
}

export function startTimelessPollCron(): void {
  const backendUrl = env.BACKEND_URL ?? "";
  const isPublic =
    backendUrl.startsWith("https://") &&
    !/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(backendUrl);

  if (!isPublic) {
    logger.info("timeless: skipping poll cron — BACKEND_URL is not a public HTTPS URL");
    return;
  }

  if (!env.TIMELESS_API_KEY) {
    logger.info("timeless: skipping poll cron — no TIMELESS_API_KEY configured");
    return;
  }

  cron.schedule("0 * * * *", () => {
    runPoll().catch((err: unknown) =>
      logger.error({ err }, "timeless.poll: cron run failed"),
    );
  });

  logger.info("timeless: hourly poll cron started");
}
