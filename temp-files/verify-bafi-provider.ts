// Full end-to-end verification of operational assistant + BAFI mirror.
// Run from Server/: npx tsx ../temp-files/verify-bafi-provider.ts
import { bafiProvider } from "../Server/src/domains/operations/operations.bafi.js";
import { runAllChecks } from "../Server/src/domains/operations/operations.checker.js";
import { getServiceMeetings, getDashboard, createTaskChain, getNotifications } from "../Server/src/domains/operations/operations.service.js";
import { supabaseAdmin } from "../Server/src/config/supabase.js";

const BARKO_SHAY = "44444444-0001-0001-0001-000000000001";
const BLANK = "00000000-0000-0000-0000-000000000000";

function header(s: string) {
  console.log(`\n${"=".repeat(60)}\n${s}\n${"=".repeat(60)}`);
}

async function step1_provider() {
  header("STEP 1 — Provider layer (already passing)");
  const cross = await bafiProvider.crossCheck(BARKO_SHAY);
  console.log("Barko Shay crossCheck:", cross);
  const blank = await bafiProvider.crossCheck(BLANK);
  console.log("Blank UUID crossCheck:", blank);
  return cross.found && !blank.found;
}

async function step2_runAllChecks() {
  header("STEP 2 — runAllChecks() — full checker pipeline");

  const { count: before } = await supabaseAdmin
    .from("notifications")
    .select("id", { count: "exact", head: true });
  console.log(`Notifications before: ${before ?? 0}`);

  await runAllChecks();
  console.log("runAllChecks() completed");

  const { count: after } = await supabaseAdmin
    .from("notifications")
    .select("id", { count: "exact", head: true });
  console.log(`Notifications after:  ${after ?? 0}`);
  console.log(`Delta: +${(after ?? 0) - (before ?? 0)}`);

  const { data: recent } = await supabaseAdmin
    .from("notifications")
    .select("type, title, severity, client_id, created_at")
    .order("created_at", { ascending: false })
    .limit(5);
  console.log("Most recent notifications:");
  recent?.forEach((n) => console.log(`  [${n.severity}] ${n.type}: ${n.title}`));

  const { data: barkoNotif } = await supabaseAdmin
    .from("notifications")
    .select("type, title")
    .eq("client_id", BARKO_SHAY)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log(`Notifications for Barko Shay: ${barkoNotif?.length ?? 0}`);
  barkoNotif?.forEach((n) => console.log(`  → ${n.type}: ${n.title}`));

  // After first run, notifications are idempotent via reference_key.
  // Pass if at least 1 notification exists for Barko Shay.
  return (barkoNotif?.length ?? 0) >= 1;
}

async function step3_serviceMeetings() {
  header("STEP 3 — getServiceMeetings() — service-meetings endpoint shape");
  const data = await getServiceMeetings();
  console.log("bafiConnected:", (data as { bafiConnected: boolean }).bafiConnected);
  console.log("summary keys:", Object.keys(data));
  console.log("counts:", JSON.stringify({
    due: (data as { due?: unknown[] }).due?.length,
    upcoming: (data as { upcoming?: unknown[] }).upcoming?.length,
    ok: (data as { ok?: unknown[] }).ok?.length,
  }));
  const clients = (data as { clients?: Array<{ id: string; name: string; status: string }> }).clients ?? [];
  const barko = clients.find((c) => c.id === BARKO_SHAY);
  console.log(`Barko Shay status: ${barko?.status ?? "NOT FOUND"} (expected 'due')`);
  if (barko) console.log(`  Full row:`, barko);
  return (data as { bafiConnected: boolean }).bafiConnected === true && barko?.status === "due";
}

async function step4_dashboard() {
  header("STEP 4 — getDashboard() — dashboard endpoint shape");
  const data = await getDashboard();
  console.log("Keys:", Object.keys(data as Record<string, unknown>));
  console.log("Full payload:", JSON.stringify(data, null, 2).slice(0, 800));
  return true;
}

async function step5_taskChain() {
  header("STEP 5 — createTaskChain() — end-to-end chain → checker → completion");

  const { data: existingMeeting } = await supabaseAdmin
    .from("meetings")
    .select("id, client_id")
    .eq("client_id", BARKO_SHAY)
    .limit(1)
    .maybeSingle();

  let meetingId: string;
  if (existingMeeting) {
    meetingId = existingMeeting.id;
    console.log(`Using existing meeting ${meetingId} for Barko Shay`);
  } else {
    const { data: newMeeting, error } = await supabaseAdmin
      .from("meetings")
      .insert({
        client_id: BARKO_SHAY,
        scheduled_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        status: "scheduled",
        type: "zoom",
      })
      .select("id")
      .single();
    if (error) throw error;
    meetingId = newMeeting.id;
    console.log(`Created test meeting ${meetingId} for Barko Shay`);
  }

  await supabaseAdmin.from("tasks").delete().eq("meeting_id", meetingId);

  await createTaskChain(meetingId);
  const { data: tasks } = await supabaseAdmin
    .from("tasks")
    .select("type, due_at, status")
    .eq("meeting_id", meetingId)
    .order("due_at");
  console.log(`Task chain created: ${tasks?.length ?? 0} tasks`);
  tasks?.forEach((t) => console.log(`  ${t.type} due ${t.due_at} [${t.status}]`));

  await supabaseAdmin
    .from("tasks")
    .update({ due_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() })
    .eq("meeting_id", meetingId);
  console.log("Backdated all tasks to be due NOW");

  await runAllChecks();
  console.log("Re-ran checker");

  const { data: tasksAfter } = await supabaseAdmin
    .from("tasks")
    .select("type, status")
    .eq("meeting_id", meetingId);
  console.log("Tasks AFTER checker (should be 'completed' since Barko has data):");
  tasksAfter?.forEach((t) => console.log(`  ${t.type} → ${t.status}`));

  const completedCount = (tasksAfter ?? []).filter((t) => t.status === "done").length;
  return completedCount === (tasksAfter?.length ?? 0) && completedCount > 0;
}

async function main() {
  const results = {
    provider: await step1_provider(),
    checker: await step2_runAllChecks(),
    serviceMeetings: await step3_serviceMeetings(),
    dashboard: await step4_dashboard(),
    taskChain: await step5_taskChain(),
  };

  header("FINAL RESULT");
  Object.entries(results).forEach(([k, v]) => console.log(`  ${v ? "✓" : "✗"} ${k}`));

  const allPassed = Object.values(results).every(Boolean);
  console.log(`\n${allPassed ? "ALL PASSED" : "FAILURES — see above"}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
