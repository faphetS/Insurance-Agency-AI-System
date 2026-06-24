# SYSTEM_FLOW.md — End-to-End Behavioral Reference

> Canonical description of **how the system behaves**, traced from source on **2026-06-24**.
> Complements `CLAUDE.md` (architecture + conventions) and `bafi-reference.md` (dropped BAFI mirror).
> **When code and this doc disagree, the code wins — update this doc.**

The system is a Node/Express + self-hosted Postgres backend for an Israeli insurance agency
("שקד" / owner: **Didi**). There is **no web UI** — all human touchpoints are **WhatsApp**
(clients + staff) and **email**. AI runs through **OpenRouter** (default `google/gemini-3.1-pro-preview`,
fallback `google/gemini-2.5-flash`). Two logical "bots" share infrastructure:

- **Conversational bot** — talks to leads/clients (intake, auto-reply, booking, reminders, summaries).
- **Operational bot** — back-office watchdog (task chains, monitors, daily digest, alerts).

**The active flow = everything in this document EXCEPT the section explicitly marked _DORMANT_ (§4.4).**
The dormant path is kept only so the code is understood; it does not run in the current configuration
(the owner `SUMMARY_RECIPIENT_PHONE` is set, which routes the live path in §4.2–§4.3).

> **Latest feature (§10, shipped 2026-06-24):** completed leads are mirrored to a Google Sheet, and
> ID/POA documents are uploaded to Google Drive. For new leads this **replaces filesystem document
> storage** — see §10, which supersedes the filesystem notes in §3.1 and §7.

---

## 1. Bots & GreenAPI instances

GreenAPI is the WhatsApp gateway. An "instance" = one WhatsApp number connected to GreenAPI
(idInstance + token + base URL, all in `Server/.env`).

- **Instance #1 (`GREENAPI_*`)** — the single client-facing line. Its webhook receives all inbound
  messages, AND it is the line that sends **everything**: client replies *and* all staff/owner
  notifications (`sendStaffMessage`/`sendStaffButtons` resolve to instance #1). Safe to reuse for
  staff because staff numbers are blocklisted from intake (`isStaffChat`).
- **Instance #2 (`GREENAPI_SCAN_*`)** — optional, **scan-only / pull-based**, used solely by the
  WhatsApp lead-scanning feature to read *other* department numbers' chat journals. Never sends, has
  no webhook. If unset, that feature returns zeros and nothing else breaks.
- **CLIX gateway** — an alternative inbound format; each line maps to a `whatsapp_instances` DB row
  with `purpose` = `conversational` | `operational`. Operational inbound is stored-and-skipped.

Helpers: `toChatId()` normalizes Israeli numbers to `<972…>@c.us`; `isStaffChat()` matches a chat
against active staff phones; `extractButtonId()` reads interactive-button taps.
(`whatsapp.util.ts`, `whatsapp.service.ts`)

---

## 2. Inbound webhook dispatcher — `whatsapp/whatsapp.controller.ts`

Single front door (`POST /api/whatsapp/webhook`). Always returns 200 fast; real work runs in
`setImmediate`. Decision order:

1. **Token check** (header `Bearer` or `?token=`). Mismatch → 200 + ignore.
2. **CLIX normalisation** (if not GreenAPI shape) → resolves `whatsapp_instances`, sets `isOperational`.
3. `outgoingAPIMessageReceived` (bot's own API send) → ignore.
4. `outgoingMessageReceived` (human typed from the phone):
   - Owner self-chat staff-picker tap → `assignStaffToMeeting`.
   - Bot-sent message → skip.
   - Otherwise → **pause bot 1h** for that chat (don't talk over a human).
5. Group chats (`@g.us`) → ignore.
6. **Owner number** (`SUMMARY_RECIPIENT_PHONE`) → operational-only: only `assign_staff:` taps act;
   everything else ignored (never enters intake).
7. **Staff intercept** (`isStaffChat`) → summary approve/edit handler (`sum_approve:` / `sum_edit:` /
   plain-text edit session). Never intake.
8. Else **client**: upsert conversation, store inbound message (dedup by `whatsapp_message_id`),
   link/create client row. If `isOperational` → store-and-skip. Else dispatch async:
   - `wantsHuman()` → escalation.
   - `client_confirm:` tap → `handleClientConfirm`.
   - else `handleIntake()`; if not consumed → `handleIncomingMessage()` (auto-reply).

---

## 3. Conversational bot

### 3.1 Intake state machine — `ai/intake.orchestrator.ts`, prompts in `ai/intake.prompts.ts`

Strict slot order: `welcome → full_name → email → inquiry_type → id_photo → poa → done`.
All prompts in Hebrew. Gated by `bot_settings.enabled` and per-conversation pause.

- **full_name / email** — fast path (email regex) then LLM validator (`classifyIntakeResponse`);
  invalid/off-topic → re-prompt, not stored.
- **inquiry_type** — interactive buttons (life/health/vehicle) + text fallback for the other 7
  (`property, liability, business, pension, travel, mortgage, general`). Free text LLM-mapped.
- **id_photo** — single vision pass `validateIdPhoto()`: confirms it's a readable ID **and** extracts
  the 9-digit Israeli ID number (`id_number`). Stored to filesystem + `documents` row.
- **poa** — optional; client sends a doc or replies "דלג"/skip.
- **finalize** — `classifyComplexity()` (health/life/pension or POA → `complex`; complex raises a
  `complex_case` notification), flips `pipeline_stage='meeting_scheduling'`, inserts a
  `pending_booking` meeting row, sends the **Google Calendar booking link**, **pauses the bot**.

### 3.2 Free-form auto-reply — `ai/ai.orchestrator.ts`
After intake (or non-intake messages), replies via OpenRouter using last 20 messages as history.
Gated by `bot_settings.enabled` + `auto_reply` + pause.

### 3.3 Human escalation — `whatsapp/whatsapp.escalation.ts`
Trigger regex (נציג / human / agent …). Replies "a rep will contact you," **pauses 2h**, WhatsApps
**assigned staff + owner**, raises urgent notification (idempotent per conversation/day).

### 3.4 Pause / cooldown system
- Manual human send (webhook or `POST /api/whatsapp/send`) → **1h**.
- Escalation → **2h**.
- Intake completion → indefinite (`bot_paused=true`).
- All pauses auto-expire via `bot_paused_until` and auto-resume. Global kill switch: `bot_settings`.

### 3.5 Booking → confirmation → reminders — `calendar/booking-sync.service.ts`, `calendar/reminder.service.ts`
Bot sends the link; client books on Google Calendar; then:
1. **booking-sync** (every 3 min) matches event→client in 3 tiers (email / unique name in
   `meeting_scheduling` / time-proximity to a `pending_booking`), sets meeting `scheduled`, backfills
   email, flips `pipeline_stage='meeting_scheduled'`, sends Hebrew **confirmation**.
2. **24h** then **1h** reminders, with quiet-hours clamping (07:00–21:00 Asia/Jerusalem), DST-correct.

---

## 4. Post-meeting flow (Timeless) — `integrations/timeless/*`, `operations/operations.service.ts`

Timeless.day records meetings + produces a summary. Delivered via **webhook**
(`meeting.transcript_ready` / `initial_summary_ready`, HMAC-verified) and **hourly poll** (backstop).

### 4.1 Ingest + matching — `timeless.service.ts` `ingestTimelessMeeting()` / `applyIngest()`
- Idempotent (skips if already ingested with a summary; back-fills if summary missing).
- Matches Timeless meeting → our meeting within ±30 min, behind a **hard email gate** (client email
  must be a participant) + scoring (host-is-staff, time proximity, source type).
- No match / ambiguous (top−runnerup < 5) → **parked** in `timeless_unmatched_meetings`.
  **Nothing is sent for unmatched meetings** until linked manually (`linkUnmatched`, `GET /unmatched`).
  ⟵ main silent failure point of the post-meeting flow.
- On match: pulls transcript + recording + summary doc (detected by title keywords), `ensureHebrew()`.

### 4.2 LIVE path (owner number configured) — order in `applyIngest`
1. `sendSummaryToOwner` — owner WhatsApp gets the Hebrew summary, **no buttons**; flips
   `summary_status='sent'` (this is what bypasses the dormant path below).
2. `sendStaffPickerToOwner` — owner WhatsApp gets a **second bubble**: buttons listing all active
   staff (`assign_staff:<meetingId>:<staffId>`). Uses `sendButtons` (no 3-button cap).
3. `sendClientSummaryEmail` — **client gets the summary by EMAIL** (only if email on file), via the
   owner's Gmail integration. **No human review gate before this email** — client receives the raw
   AI summary (Hebrew-normalized).

### 4.3 Owner taps a staff button → `assignStaffToMeeting`
- **First-tap-wins** atomic claim of `assigned_handler_id` (dup taps just reply "already assigned").
- `createTaskChain()` — creates the 5 milestone tasks, sets `pipeline_stage='forms'` and
  `last_service_date` (starts the biennial clock).
- `notifyStaffHandoff()` — chosen staff gets the full client file: name, phone, ID#, inquiry type,
  complexity flag, summary, **signed 7-day links** to ID/POA docs, task list.

### 4.4 DORMANT alternative path — NOT part of the active flow
> ⚠️ This path does **not** run while the owner summary number is configured. It is documented only so
> the code is understood. The active post-meeting flow is §4.2–§4.3.

(Triggers only if `SUMMARY_RECIPIENT_PHONE` is unset or the owner-send fails.)
`summary_status` stays `'draft'` → `checkSummaryApprovals` (every 10 min) →
`notifyStaffSummaryReady` sends the **assigned staff** ✅approve/✏️edit buttons → on approve,
`sendSummaryToClient` sends the **client a WhatsApp summary + confirm button** →
`handleClientConfirm` creates the task chain. (In the live owner path this never runs.)

---

## 5. Operational bot — `operations/*`

Scheduled jobs + reactive checkers; all sends via instance #1; all events write idempotent
`notifications` rows (dedup by `reference_key`) that feed the dashboard.

### 5.1 Task-chain milestone engine — `checkDueAndOverdueTasks` (daily)
Task chain (`operations.types.ts` `TASK_CHAIN_DEFINITION`):

| Task | Due | Checks | On complete → pipeline |
|---|---|---|---|
| `forms_check`   | +7d  | forms sent to insurer        | `forms` |
| `receipt_check` | +14d | insurer acknowledged receipt | `receipt` |
| `policy_check`  | +30d | policy issued / fund opened  | `policy` |
| `deposit_check` | +60d | first premium/deposit        | `deposit` |
| `cross_check`   | +90d | reconcile vs summary         | `completed` |

For each due task it **scans the assigned agent's Gmail** (`operations.email-milestones.ts` →
`gmail.milestones.ts` → `classifyEmailMilestone`, Israeli insurance/pension Hebrew terms, confidence
tiers: ID#/policy# = definitive, name+email = strong, name = weak):
- **Found** → `completeTask` (advances pipeline).
- **Not found** (non-cross_check) → nag agent once on WhatsApp; if overdue > 3 days → mark `overdue`
  + urgent notification + red WhatsApp alert (`sendOverdueAlert`).
- **cross_check** → automatic, never nags; if not all four milestones complete →
  `buildCrossCheckAssessment` produces a Hebrew **AI advisory** comparing summary vs reality, sent to
  the agent (`operations.cross-check.ts`).

### 5.2 Daily digest — `operations.digest.ts` (cron `0 8 * * *` Asia/Jerusalem)
- **Per agent**: overdue tasks, unanswered bot conversations, unanswered WhatsApp threads, actionable
  insurer emails, pending summaries, service-due clients — scoped to that agent.
- **Owner overview**: agency-wide totals + per-agent item counts. Idempotent per day via
  `system_settings.last_digest_date`.

### 5.3 SLA breach monitor — `checkSlaBreaches` (every 30 min)
Reads `v_client_pipeline` where `sla_breached`; alerts the assigned agent.

### 5.4 Biennial service meetings — `checkServiceMeetingEligibility` (daily)
Active clients with `last_service_date` null or > 24 months → **messages the CLIENT directly**
(retention outreach to book a service meeting) via `sendServiceDueToClient`.

### 5.5 WhatsApp unanswered scan — `operations.whatsapp-monitor.ts` + `whatsapp-scan.ts` (every 20 min)
Reads scan-line journals for inbound threads with no reply past threshold; refreshes
`whatsapp_instances.last_unanswered_count`; feeds the digest. Stub when `WHATSAPP_PROVIDER=stub` or
scan creds unset.

### 5.6 Notifications, dashboard, pipeline
`createNotification` (idempotent), `getDashboard` (overdue tasks, pending summaries, pipeline
distribution, unread notifications, SLA breaches), `advancePipelineStage` on each task completion.

---

## 6. Scheduled jobs — cadence summary (`server.ts`)

All gated to **public production only** (dev boots never touch the live line):

| Job | Cadence |
|---|---|
| Calendar booking sync | every 3 min (first +30s) |
| Appointment reminders (24h/1h) | every 10 min |
| Summary-approval check (dormant path) | every 10 min |
| SLA breach check | every 30 min |
| WhatsApp unanswered scan | every 20 min |
| Milestone due/overdue task check | every 24h |
| Service-meeting eligibility | every 24h |
| Daily digest | cron `0 8 * * *` (Jerusalem) |
| Timeless meeting poll | cron `0 * * * *` (hourly) |

---

## 7. Data model & where everything is saved (`db/schema.sql` + filesystem)

Tables: `staff`, `clients`, `meetings`, `tasks`, `documents`, `audit_logs`, `conversations`,
`messages`, `bot_settings`, `system_settings`, `notifications`, `gmail_integrations`,
`whatsapp_instances`, `timeless_unmatched_meetings` + view `v_client_pipeline`.

- `clients`: `pipeline_stage`, `complexity`, `id_number`, `policy_number`, `assigned_to` /
  `assigned_handler_id` (handler preferred), `last_service_date`, intake columns.
- `meetings`: `status` (pending_booking→scheduled→…), `summary_draft`/`summary_final`/`summary_status`
  (`draft`→`approved`→`sent`, default `draft`), `client_confirmed`, `timeless_meeting_id`,
  `staff_summary_notified_at`, `staff_picker_sent_at`, `client_summary_emailed_at`, reminder flags.
- `tasks`: `type`, `due_at`, `status` (pending/completed/overdue), `reminder_sent`, `assigned_to`,
  `meeting_id`.
- `gmail_integrations`: per-staff OAuth (`staff_id` UNIQUE, `email`, `refresh_token`, …).

### Storage backends
- **Postgres** (self-hosted on the VPS) — all structured data, via the `supabaseAdmin` shim / `pool`.
- **Filesystem** (`STORAGE_DIR`, default `./storage`) — uploaded documents (ID photos, POA). The DB
  stores only the **path**; the bytes live on disk. Served via signed `/files/*splat` (HMAC
  `JWT_SECRET`, 7-day TTL for handoff links). `lib/storage.ts`.
- **External (not in our DB)** — Google Calendar (events, read), Gmail (mailboxes, read; OAuth tokens
  in `gmail_integrations`), Timeless.day (recordings/transcripts/summary docs — fetched, the summary
  copied into `meetings`), GreenAPI (message transport only).

### Writes by flow stage (the "where is X saved" map)
- **Inbound message** → `messages` (direction, sent_by, body, `whatsapp_message_id` unique-dedup,
  status). **Conversation** upsert → `conversations` (by `whatsapp_chat_id`; `last_message_at`,
  `whatsapp_instance_id`). **Client** create/link → `clients`. **Pauses** → `conversations.bot_paused`
  / `bot_paused_until`. Settings read → `bot_settings` (id=1).
- **Intake answers** → `clients` (`intake_state`, `intake_current_slot`, `full_name`, `email`,
  `inquiry_type`, `id_number`, `id_validated`, `complexity`, `pipeline_stage`, `intake_completed_at`).
- **ID photo / POA file** → filesystem `clients/<clientId>/<kind>_<ts>.<ext>` **+** `documents` row
  (path, type, mime). **Finalize** → `clients` (completed, `pipeline_stage='meeting_scheduling'`) **+**
  `meetings` insert (`status='pending_booking'`) **+** `conversations.bot_paused=true`; complex →
  `notifications`. **Bot replies** → `messages` (outbound, `sent_by='bot'`).
- **Escalation** → `conversations` (pause 2h) + `messages` + `notifications` (`whatsapp_unanswered`).
- **Booking sync** → `system_settings.google_calendar_last_sync`; `meetings` (`calendar_event_id`,
  `scheduled_at`, `status='scheduled'`); `clients` (email backfill, `pipeline_stage='meeting_scheduled'`);
  `messages` (confirmation). **Reminders** → `meetings.reminder_24h_sent`/`reminder_1h_sent` + `messages`.
- **Timeless** → `meetings` (`timeless_meeting_id`, `transcript`, `summary_draft`, `recording_url`,
  `summary_final`, `summary_status`, and `staff_summary_notified_at` / `staff_picker_sent_at` /
  `client_summary_emailed_at` idempotency claims); `timeless_unmatched_meetings` (parked);
  `notifications` (`summary_ready`); `system_settings` (`timeless_webhook_id`/`_secret`,
  `_last_event_at`, `_last_poll_at`). The client summary **email** goes out via the Gmail API (body not stored).
- **Staff assignment + task chain** → `clients` (`assigned_handler_id`, `pipeline_stage='forms'`,
  `last_service_date`); `tasks` (5 milestone rows); `notifications` (`task_chain`).
- **Operational** → `tasks` (status `completed`/`overdue`, `reminder_sent`); `clients`
  (`pipeline_stage`, `policy_number` learned from email hits); `notifications` (idempotent by
  `reference_key`); `system_settings.last_digest_date`; `whatsapp_instances` (`last_unanswered_count`,
  `last_synced_at`, `last_error`); `gmail_integrations` (token refresh, `last_synced_at`).

---

## 8. Config / providers (`config/env.ts`)

- Instance #1 `GREENAPI_*` required; scan instance `GREENAPI_SCAN_*` optional.
- `AI_MODEL` default `google/gemini-3.1-pro-preview`; `OPENROUTER_API_KEY` required.
- Google **Calendar** OAuth (`GOOGLE_*`) and Gmail OAuth (`GOOGLE_OAUTH_*`) are separate.
- `TIMELESS_API_KEY`, `SUMMARY_RECIPIENT_PHONE` (owner summary line).
- Provider toggles: `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER` (`stub`/`live`); BAFI `BAFI_PROVIDER=stub`.
- `.env` lives on the VPS (not carried by the deploy workflow). Auth = static `ADMIN_API_TOKEN`.

---

## 9. Known issues / things to watch (as of 2026-06-24)

- **No human review gate** before the client's summary **email** in the live owner path (§4.2).
- **Unmatched Timeless meetings** are silent (§4.1) — depend on the client-email-as-participant gate.
- **OpenRouter key is on a free-tier account** — confirm credits exist for paid models (default is a
  paid model; fallback is `gemini-2.5-flash`).
- **`SUMMARY_RECIPIENT_PHONE` is a +63 (Philippines) test number**, not Didi's real number — the
  owner-summary/staff-picker flow points at a test phone.
- **Historical `path-to-regexp` `/*` crash** seen in PM2 error log (`dist/.../files.routes.js`) from a
  prior boot — source uses correct `/*splat`; current process boots clean. Watch for recurrence.
- **Email milestone scanning is partial** — real Israeli milestone data largely flows via the pension
  clearinghouse + insurer portals, not agent inboxes (verify scope with Didi).
- **BAFI is DROPPED** (decision 2026-06-24) — the agency will not pursue any BAFI integration. All
  BAFI reference docs/assets **and** the obsolete `supabase/migrations/*bafi*.sql` now live in
  `temp-files/` (gitignored). Do **not** build BAFI features. (The old `operations-bafi.integration.test.ts`
  was a mis-named email-milestone test — renamed to `operations-email-milestones.integration.test.ts`.)
- Some staff/owner strings are English interim stand-ins pending Hebrew conversion before go-live.
- **PII:** new ID/POA scans live in Google Drive as **anyone-with-link** (deliberate choice); the links
  sit in the CRM sheet + staff handoff (§10).
- **Stale test:** `intake.integration.test.ts` still asserts the OLD filesystem document behaviour
  (predates §10's Drive switch). Skipped in CI (needs DB env) so it isn't red, but should be updated.
- **Pending:** Gmail single-inbox repoint (email scanning still per-staff) — the last remaining item
  from the single-Google-account consolidation.

---

## 10. Lead mirror → Google Sheets + Drive (shipped 2026-06-24, commit `01873e2`)

**Single-account Google OAuth** (`GOOGLE_WS_*`, separate from the Calendar `GOOGLE_*` client): one
agency Google account, scopes `spreadsheets` + `drive.file` + `gmail.readonly` + `gmail.send` (no
calendar). Connected; refresh token in `system_settings.google_ws_refresh_token`. Routes
`/api/integrations/google/{authorize,callback,status}`; shared client helper `getAuthenticatedClient()`
in `integrations/google/google.auth.ts`.

**During intake (changes §3.1):**
- **ID photo** (only after OCR passes) and **POA** (if provided) are uploaded to Drive folder
  `1iwvNhMS…` as `<full name> - ID` / `<full name> - POA`, set **anyone-with-link** reader. The Drive
  `webViewLink` is stored in `clients.id_photo_url` / `poa_doc_url` **and** `documents.file_url`. This
  **replaces filesystem storage for new intake docs** (legacy filesystem rows still served via signed
  `/files`). On Drive/fetch failure the bot re-prompts a resend (no data loss).

**On completion (`finalize()`):** `mirrorLeadToSheet(clientId)` appends one row (best-effort — can
**never** block intake) to the **`לידים חדשים`** tab of "דידי CRM" (`11Twq…`). Columns **A→H**: phone,
full_name, email, inquiry_type (Hebrew via `INQUIRY_TYPE_HE`), ID-photo Drive URL, POA Drive URL,
id_number, blank relevance. **Idempotent** via `clients.mirrored_to_sheet_at` (claim-or-skip).

**Modules:** `integrations/google/{google.drive,google.sheets,leads-mirror.service}.ts`;
`storage.fetchRemoteFile` (download→Buffer); `staff-handoff.resolveDocLink` passes Drive URLs through.

**Config:** `LEADS_SPREADSHEET_ID`, `LEADS_SHEET_TAB`, `LEADS_DRIVE_FOLDER_ID`, `LEADS_MIRROR_ENABLED`
— all have **defaults in `env.ts`** (not in `.env`). The New-leads tab title has a **trailing space**,
resolved at runtime by trim-match against sheet metadata + cached in `system_settings.leads_sheet_tab_resolved`.

**Verified** end-to-end against the real Drive + Sheets + Postgres (Drive upload into folder +
anyone-link + webViewLink, sheet row A→H with Hebrew label, idempotency, graceful failure), test data
cleaned up. **Not yet driven live:** a real WhatsApp lead through the full webhook→intake→finalize
pipeline (the external-write layer was exercised directly; the WhatsApp wiring was code-reviewed).
