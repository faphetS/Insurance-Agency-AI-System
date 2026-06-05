import cron from "node-cron";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";
import { TASK_LABELS_HE, formatDueDate } from "./operations.format.js";
import { getDashboard, getEmailMonitoring } from "./operations.service.js";
import { greenApiUnansweredThreads } from "./operations.whatsapp-monitor.js";
import { type DayScanThread } from "./operations.whatsapp-scan.js";

const UNANSWERED_HOURS = 4;

async function getSystemSetting(key: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (data?.value as string | null) ?? null;
}

async function setSystemSetting(key: string, value: string): Promise<void> {
  await supabaseAdmin
    .from("system_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

function jerusalemToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
}

interface StaffEntry {
  fullName: string;
  chatId: string;
  role: string;
}

interface TaskItem {
  clientName: string;
  label: string;
  due: string;
}

interface AgentBucket {
  overdueTasks: TaskItem[];
  unanswered: string[];
  pendingSummaries: string[];
  serviceDue: string[];
  waUnanswered: { name: string; hoursSince: number }[];
}

export async function runDailyDigest(opts?: { force?: boolean }): Promise<void> {
  try {
    // 1. Idempotency guard
    const today = jerusalemToday();
    if (!opts?.force) {
      const lastRun = await getSystemSetting("last_digest_date");
      if (lastRun === today) {
        logger.info("runDailyDigest: already ran today");
        return;
      }
      // Claim the day only for the scheduled (non-forced) run. A manual
      // /trigger-digest must NOT stamp the date, or it would make the real
      // 08:00 cron skip that day.
      await setSystemSetting("last_digest_date", today);
    }

    // 2. Load active staff
    const { data: staffRows, error: staffErr } = await supabaseAdmin
      .from("staff")
      .select("id, full_name, phone, role")
      .eq("is_active", true);

    if (staffErr) {
      logger.error({ err: staffErr }, "runDailyDigest: failed to load staff");
      return;
    }

    const staffMap = new Map<string, StaffEntry>();
    for (const s of staffRows ?? []) {
      const chatId = toChatId(s.phone as string | null);
      if (!chatId) continue;
      staffMap.set(s.id as string, {
        fullName: s.full_name as string,
        chatId,
        role: s.role as string,
      });
    }

    // 3. Load data

    // 3a. Overdue / pending tasks past due_at
    const { data: taskRows } = await supabaseAdmin
      .from("tasks")
      .select("id, client_id, type, due_at, status, assigned_to")
      .in("status", ["pending", "overdue"])
      .lte("due_at", new Date().toISOString());

    // 3b. All clients
    const { data: clientRows } = await supabaseAdmin
      .from("clients")
      .select("id, full_name, status, last_service_date, assigned_handler_id, assigned_to, phone");

    const clientMap = new Map<string, {
      full_name: string;
      status: string;
      last_service_date: string | null;
      assigned_handler_id: string | null;
      assigned_to: string;
      phone: string | null;
    }>();
    for (const c of clientRows ?? []) {
      clientMap.set(c.id as string, {
        full_name: c.full_name as string,
        status: c.status as string,
        last_service_date: c.last_service_date as string | null,
        assigned_handler_id: c.assigned_handler_id as string | null,
        assigned_to: c.assigned_to as string,
        phone: c.phone as string | null,
      });
    }

    const onlyDigits = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

    const clientByPhone = new Map<string, string>();
    for (const [clientId, c] of clientMap) {
      const d = onlyDigits(toChatId(c.phone) ?? c.phone);
      if (d) clientByPhone.set(d, clientId);
    }

    function agentOf(clientId: string): string | null {
      const c = clientMap.get(clientId);
      if (!c) return null;
      return c.assigned_handler_id ?? c.assigned_to ?? null;
    }

    // 3c. Pending summaries (meetings with draft status and non-null summary_draft)
    const { data: summaryRows } = await supabaseAdmin
      .from("meetings")
      .select("id, client_id")
      .eq("summary_status", "draft")
      .not("summary_draft", "is", null);

    // 3d. Unanswered conversations (latest message is inbound, older than threshold)
    const thresholdIso = new Date(Date.now() - UNANSWERED_HOURS * 60 * 60 * 1000).toISOString();

    const { data: convRows } = await supabaseAdmin
      .from("conversations")
      .select("id, client_id, last_message_at")
      .not("client_id", "is", null)
      .lt("last_message_at", thresholdIso);

    const candidateConvIds = (convRows ?? []).map((c: any) => c.id as string);

    const unansweredClientIds: string[] = [];

    if (candidateConvIds.length > 0) {
      const { data: msgRows } = await supabaseAdmin
        .from("messages")
        .select("conversation_id, direction, created_at")
        .in("conversation_id", candidateConvIds)
        .order("created_at", { ascending: false });

      // Reduce to latest message per conversation_id
      const latestByConv = new Map<string, { direction: string }>();
      for (const msg of msgRows ?? []) {
        const convId = msg.conversation_id as string;
        if (!latestByConv.has(convId)) {
          latestByConv.set(convId, { direction: msg.direction as string });
        }
      }

      // Build a quick lookup of conv → client_id
      const convToClient = new Map<string, string>();
      for (const c of convRows ?? []) {
        convToClient.set(c.id as string, c.client_id as string);
      }

      for (const [convId, latest] of latestByConv) {
        if (latest.direction === "inbound") {
          const clientId = convToClient.get(convId);
          if (clientId) unansweredClientIds.push(clientId);
        }
      }
    }

    // 3e. Service-due: active clients whose last_service_date is null or <= 24 months ago
    const twoYearsAgo = new Date();
    twoYearsAgo.setMonth(twoYearsAgo.getMonth() - 24);
    const twoYearsAgoIso = twoYearsAgo.toISOString();

    const serviceDueClients = (clientRows ?? []).filter((c: any) => {
      if ((c.status as string) !== "active") return false;
      const lsd = c.last_service_date as string | null;
      return !lsd || lsd <= twoYearsAgoIso;
    });

    // 3f. GreenAPI line-wide unanswered threads (fetched once, reused for owner + per-agent routing)
    const waThreads: DayScanThread[] = await greenApiUnansweredThreads().catch(() => []);
    const unmatchedThreads: DayScanThread[] = [];

    // 4. Bucket per agent
    const buckets = new Map<string, AgentBucket>();

    function getBucket(staffId: string): AgentBucket {
      let b = buckets.get(staffId);
      if (!b) {
        b = { overdueTasks: [], unanswered: [], pendingSummaries: [], serviceDue: [], waUnanswered: [] };
        buckets.set(staffId, b);
      }
      return b;
    }

    for (const task of taskRows ?? []) {
      const staffId = task.assigned_to as string;
      if (!staffMap.has(staffId)) continue;
      const clientId = task.client_id as string;
      const client = clientMap.get(clientId);
      const bucket = getBucket(staffId);
      bucket.overdueTasks.push({
        clientName: client?.full_name ?? clientId,
        label: TASK_LABELS_HE[task.type as string] ?? (task.type as string),
        due: formatDueDate(task.due_at as string),
      });
    }

    for (const clientId of unansweredClientIds) {
      const staffId = agentOf(clientId);
      if (!staffId || !staffMap.has(staffId)) continue;
      const client = clientMap.get(clientId);
      getBucket(staffId).unanswered.push(client?.full_name ?? clientId);
    }

    for (const meeting of summaryRows ?? []) {
      const clientId = meeting.client_id as string;
      const staffId = agentOf(clientId);
      if (!staffId || !staffMap.has(staffId)) continue;
      const client = clientMap.get(clientId);
      getBucket(staffId).pendingSummaries.push(client?.full_name ?? clientId);
    }

    for (const c of serviceDueClients) {
      const clientId = c.id as string;
      const staffId = agentOf(clientId);
      if (!staffId || !staffMap.has(staffId)) continue;
      getBucket(staffId).serviceDue.push(c.full_name as string);
    }

    for (const t of waThreads) {
      const phone = onlyDigits(t.chatId.split("@")[0]);
      const clientId = clientByPhone.get(phone);
      const staffId = clientId ? agentOf(clientId) : null;
      if (clientId && staffId && staffMap.has(staffId)) {
        getBucket(staffId).waUnanswered.push({
          name: clientMap.get(clientId)?.full_name ?? phone,
          hoursSince: t.hoursSince,
        });
      } else {
        unmatchedThreads.push(t);
      }
    }

    // 5. Send per-agent digests
    const sentChatIds = new Set<string>();

    for (const [staffId, entry] of staffMap) {
      const bucket = buckets.get(staffId);
      const totalItems =
        (bucket?.overdueTasks.length ?? 0) +
        (bucket?.unanswered.length ?? 0) +
        (bucket?.pendingSummaries.length ?? 0) +
        (bucket?.serviceDue.length ?? 0) +
        (bucket?.waUnanswered.length ?? 0);

      if (totalItems === 0) {
        logger.info({ staffId }, "runDailyDigest: no items for agent — skipping");
        continue;
      }

      if (sentChatIds.has(entry.chatId)) {
        logger.info({ staffId }, "runDailyDigest: chatId already used — skipping duplicate agent digest");
        continue;
      }

      const lines: string[] = ["🗒️ סיכום יומי – משימות פתוחות", ""];

      if (bucket && bucket.overdueTasks.length > 0) {
        lines.push(`⏰ משימות באיחור (${bucket.overdueTasks.length}):`);
        for (const t of bucket.overdueTasks) {
          lines.push(`- ${t.clientName}: ${t.label} (יעד: ${t.due})`);
        }
        lines.push("");
      }

      if (bucket && bucket.unanswered.length > 0) {
        lines.push(`💬 פניות ללא מענה (${bucket.unanswered.length}):`);
        for (const name of bucket.unanswered) {
          lines.push(`- ${name}`);
        }
        lines.push("");
      }

      if (bucket && bucket.waUnanswered.length > 0) {
        lines.push(`📱 וואצאפ – לקוחות ללא מענה (${bucket.waUnanswered.length}):`);
        for (const item of bucket.waUnanswered) {
          lines.push(`- ${item.name} (לפני ${Math.round(item.hoursSince)} שע׳)`);
        }
        lines.push("");
      }

      if (bucket && bucket.pendingSummaries.length > 0) {
        lines.push(`📝 סיכומים לאישור (${bucket.pendingSummaries.length}):`);
        for (const name of bucket.pendingSummaries) {
          lines.push(`- ${name}`);
        }
        lines.push("");
      }

      if (bucket && bucket.serviceDue.length > 0) {
        lines.push(`📅 לקוחות לפגישת שירות (${bucket.serviceDue.length}):`);
        for (const name of bucket.serviceDue) {
          lines.push(`- ${name}`);
        }
        lines.push("");
      }

      const body = lines.join("\n").trimEnd();

      try {
        await sendMessageWithTyping(entry.chatId, body);
        sentChatIds.add(entry.chatId);
        logger.info({ staffId, totalItems }, "runDailyDigest: sent agent digest");
      } catch (err) {
        logger.error({ err, staffId }, "runDailyDigest: failed to send agent digest");
      }
    }

    // 6. Owner overview
    let ownerEntry: StaffEntry | null = null;
    let ownerStaffId: string | null = null;

    for (const [sid, entry] of staffMap) {
      if (entry.role === "owner") {
        ownerEntry = entry;
        ownerStaffId = sid;
        break;
      }
    }

    if (!ownerEntry) {
      // Fallback: query directly (handles case where owner has no phone in staffMap)
      const { data: ownerRow } = await supabaseAdmin
        .from("staff")
        .select("id, full_name, phone")
        .eq("role", "owner")
        .eq("is_active", true)
        .maybeSingle();

      if (ownerRow) {
        const chatId = toChatId(ownerRow.phone as string | null);
        if (chatId) {
          ownerEntry = { fullName: ownerRow.full_name as string, chatId, role: "owner" };
          ownerStaffId = ownerRow.id as string;
        }
      }
    }

    if (!ownerEntry || !ownerStaffId) {
      logger.info("runDailyDigest: no owner with a usable phone — skipping owner overview");
      return;
    }

    let dashboard: Awaited<ReturnType<typeof getDashboard>>;
    let emailPending = 0;
    try {
      dashboard = await getDashboard();
    } catch (err) {
      logger.error({ err }, "runDailyDigest: getDashboard failed — using zeros");
      dashboard = {
        overdue_tasks: 0,
        pending_summary_approvals: 0,
        pipeline_stage_distribution: {},
        unread_notifications: 0,
        sla_breaches: 0,
      };
    }

    try {
      const emailResult = await getEmailMonitoring();
      emailPending = emailResult.totalPending ?? 0;
    } catch (err) {
      logger.warn({ err }, "runDailyDigest: getEmailMonitoring failed — using 0");
    }

    // waThreads was already fetched above — reuse to avoid a second GreenAPI scan
    const waUnansweredScan = waThreads.length;

    const totalUnanswered = unansweredClientIds.length;
    const totalServiceDue = serviceDueClients.length;

    // Per-agent breakdown: name → total item count
    const agentBreakdown: { name: string; count: number }[] = [];
    for (const [sid, entry] of staffMap) {
      const bucket = buckets.get(sid);
      const count =
        (bucket?.overdueTasks.length ?? 0) +
        (bucket?.unanswered.length ?? 0) +
        (bucket?.pendingSummaries.length ?? 0) +
        (bucket?.serviceDue.length ?? 0) +
        (bucket?.waUnanswered.length ?? 0);
      agentBreakdown.push({ name: entry.fullName, count });
    }
    agentBreakdown.sort((a, b) => b.count - a.count);

    const ownerLines: string[] = [
      "📊 סיכום יומי – סקירת סוכנות",
      "",
      `משימות באיחור: ${dashboard.overdue_tasks}`,
      `סיכומים ממתינים לאישור: ${dashboard.pending_summary_approvals}`,
      `חריגות SLA: ${dashboard.sla_breaches}`,
      `פניות ללא מענה (בוט): ${totalUnanswered}`,
      `פניות ללא מענה (וואצאפ – סריקה): ${waUnansweredScan}`,
      `אימיילים ממתינים: ${emailPending}`,
      `לקוחות לפגישת שירות: ${totalServiceDue}`,
      "",
      "לפי סוכן:",
      ...agentBreakdown.map((a) => `- ${a.name}: ${a.count} פריטים`),
    ];

    if (unmatchedThreads.length > 0) {
      ownerLines.push("");
      ownerLines.push(`📱 וואצאפ – פניות לא מזוהות (${unmatchedThreads.length}):`);
      for (const t of unmatchedThreads) {
        const phone = t.chatId.split("@")[0];
        ownerLines.push(`- ${phone}: ${t.preview} (לפני ${Math.round(t.hoursSince)} שע׳)`);
      }
    }

    const ownerBody = ownerLines.join("\n");

    try {
      await sendMessageWithTyping(ownerEntry.chatId, ownerBody);
      logger.info({ ownerStaffId }, "runDailyDigest: sent owner overview");
    } catch (err) {
      logger.error({ err, ownerStaffId }, "runDailyDigest: failed to send owner overview");
    }
  } catch (err) {
    logger.error({ err }, "runDailyDigest: unexpected error");
  }
}

export function startDailyDigestCron(): void {
  cron.schedule(
    "0 8 * * *",
    () => {
      runDailyDigest().catch((err: unknown) =>
        logger.error({ err }, "digest: cron run failed"),
      );
    },
    { timezone: "Asia/Jerusalem" },
  );
  logger.info("daily digest cron started");
}
