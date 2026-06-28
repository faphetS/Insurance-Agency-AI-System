# SYSTEM_FLOW.md — End-to-End Behavioral Reference

> Canonical description of **how the system behaves**, re-traced from source on **2026-06-29**.
> Complements `CLAUDE.md` (architecture + conventions). BAFI is fully dropped (decision 2026-06-24);
> its reference assets live in `temp-files/` and no BAFI code remains.
> **When code and this doc disagree, the code wins — update this doc.** Items that could not be fully
> confirmed from source are marked **(verify)**.

The system is a Node/Express + self-hosted Postgres backend for an Israeli insurance agency
("שקד" / owner: **Didi**). There is **no web UI** — all human touchpoints are **WhatsApp**
(clients + staff/owner) and **email**. AI runs through **OpenRouter**: `AI_MODEL` default
`google/gemini-2.5-flash`, `AI_FALLBACK_MODEL` `google/gemini-3.1-pro-preview` (one retry on failure,
text + vision); commitment extraction uses `COMMITMENT_AI_MODEL` (default
`google/gemini-3.1-flash-lite`, hard-coded fallback `google/gemini-2.5-flash`).

Two logical "bots" share the codebase but now run on **different WhatsApp gateways**:

- **Conversational bot** — talks to leads/clients (intake, auto-reply, booking, reminders) and routes
  post-meeting summaries to the owner. Runs on the **Clix gateway** (with a GreenAPI fallback path).
- **Operational bot** (rebuilt 2026-06-25 as **three pillars**) — a back-office assistant for Didi:
  missed/declined-call reminders, personal-commitment reminders, and email staff-mentions. Runs on the
  **GreenAPI operational instance (#2)** plus the single Google Workspace Gmail.

**Major changes since the 2026-06-24 trace** (all reflected below): conversational bot moved to Clix;
GreenAPI instance #1 retired; old operational engine (task-chain milestones, SLA monitor, old daily
digest, WhatsApp-unanswered scan, Gmail-milestone scan, cross-check) **removed and replaced** by the
three pillars; booking switched to Calendly + Zoom; intake v2 (new/old fork, 7-button inquiry);
Timeless matching switched from ±30 min to **same Israel calendar day**; Gmail consolidated to one
Workspace account (per-staff `gmail_integrations` removed). The post-meeting **dormant approval path is
gone**.

---

## 1. Gateways & WhatsApp instances

Two WhatsApp transports are in play. A connected line maps to a `whatsapp_instances` DB row
(`purpose` = `conversational` | `operational`, `gateway_customer_id` for Clix, `green_api_*` for
GreenAPI).

- **Clix gateway (the "didi-bot" line)** — the **live conversational line**. Inbound arrives at the same
  webhook in Clix's own shape (`whatsapp.controller.ts` detects it via `isClixShaped` = no `typeWebhook`
  but has `customerId` + `type`) and is normalised by `clixToInternal` (`whatsapp.validator.ts`). Media
  arrives inline as base64. Outbound text/buttons go via `whatsapp.clix-send.ts`
  (`clixSendText` / `clixSendButtons`; buttons are mapped to `{id,text}` with text truncated to 25 chars,
  and there is **no 3-button cap**). Enabled when `CLIX_SEND_URL` + `CLIX_SEND_TOKEN` are set.
- **GreenAPI instance #1 (`GREENAPI_*`, number 7107600944) — RETIRED / expired.** Its env vars are still
  **required** by `env.ts` (dead creds remain in `.env`), but boot no longer registers its webhook
  (`setWebhookSettings` is defined but never called) and all sends that used to go through it have moved
  to Clix. It survives only as the **fallback gateway** if a conversation isn't tagged to a Clix line.
- **GreenAPI operational instance (#2)** — two env families coexist:
  - `GREENAPI_OP_*` (`opCreds()`, id `7103519997` / number `639219909210`) — the **operational
    line**. Receives **call webhooks**, and **sends to its own self-chat** (send-to-self) for the call
    reminder, commitment reminders, and the merged morning digest.
  - `GREENAPI_SCAN_*` (`scanCreds()` / `opsCreds()`) — pull-based journal reads
    (`lastIncoming/OutgoingMessagesWith`). The commitment scanner reads the op line's 24h journals through
    these. **(verify)** whether `GREENAPI_OP_*` and `GREENAPI_SCAN_*` point at the same physical line in
    `.env`; the code treats them as separate cred sets.

**Per-chat outbound routing — `resolveGatewayForChat(chatId)` (`whatsapp.service.ts`):** returns `"clix"`
only when the chat's conversation row has a `whatsapp_instance_id` whose instance has a non-null
`gateway_customer_id` **and** Clix send creds exist; otherwise `"greenapi"` (safe fallback on any error).
`sendMessage` / `sendMessageWithTyping` / `sendInteractiveButtonsWithTyping` all consult this, so the
client-facing conversational bot uses Clix for Clix-tagged conversations and GreenAPI otherwise. Clix
sends get a synthesised `idMessage` (`clix-out:<ts>:<rand>`) so the unique `whatsapp_message_id` index
never collides.

Helpers: `toChatId()` normalises Israeli numbers to `<972…>@c.us`; `isStaffChat()` matches a chat against
active staff phones; `extractButtonId()` reads GreenAPI interactive-button taps.
(`whatsapp.util.ts`, `whatsapp.service.ts`, `whatsapp.clix-send.ts`)

---

## 2. Inbound webhook dispatcher — `whatsapp/whatsapp.controller.ts`

Single front door (`POST /api/whatsapp/webhook`, body limit 20 MB for this route so Clix base64 media
fits). Always returns 200 fast; real work runs in `setImmediate`. Decision order:

1. **Operational-call short-circuit.** If `instanceData.idInstance === GREENAPI_OP_ID_INSTANCE` and
   `typeWebhook` is `incomingCall`/`outgoingCall` → `recordCallEvent(body)` (writes `call_events`) and
   persist the op line's own `wid` to `system_settings.op_self_chat_id`. Ack 200, stop.
2. **Token check.** Accepts `Authorization: Bearer <GREENAPI_WEBHOOK_TOKEN>`, `?token=<GREENAPI_WEBHOOK_TOKEN>`,
   or `?token=<CLIX_WEBHOOK_TOKEN>`. Mismatch → **401** if the body is Clix-shaped (Clix reads it, no retry
   storm), otherwise **200 + ignore** (GreenAPI retry suppression).
3. **Clix normalisation** (if Clix-shaped):
   - A Clix `type:"outgoing"` event = a human replying from the bot account (Clix does **not** echo the
     bot's own API sends) → **pause that chat's bot for 1h** (human takeover). Plus a test-only branch: if
     the bot line *is* the owner number (`SUMMARY_RECIPIENT_PHONE`), an outgoing self-chat message carrying
     a staff name triggers `tryAssignByStaffName` (inert in prod, where bot ≠ owner).
   - Otherwise `clixToInternal` produces the internal payload; media base64 is logged but **not persisted**
     and carried forward as `clixMedia`. The line's `whatsapp_instances` row is resolved by
     `gateway_customer_id`; unknown/inactive line → ignore; `purpose === 'operational'` sets
     `isOperational` (store-and-skip later).
4. `outgoingAPIMessageReceived` (GreenAPI: bot's own API send) → ignore.
5. `outgoingMessageReceived` (GreenAPI: human typed from the phone):
   - Owner self-chat staff-picker tap (`assign_staff:<meetingId>:<staffId>`) → `assignStaffToMeeting`.
   - Message our bot sent (matched by `whatsapp_message_id` + `sent_by='bot'`) → skip.
   - Otherwise (non-group) → **pause bot 1h** for that chat.
6. Only `incomingMessageReceived` proceeds. Group chats (`@g.us`) → ignore.
7. **Owner number** (`SUMMARY_RECIPIENT_PHONE`) → operational-only: only `assign_staff:` taps act
   (`assignStaffToMeeting`); everything else ignored (never enters intake).
8. **Staff intercept** (`isStaffChat`) → **log and skip** (the old approve/edit summary handler has been
   retired — staff inbound does nothing here).
9. Else **client**: upsert `conversations` (by `whatsapp_chat_id`, tag `whatsapp_instance_id` for Clix),
   insert inbound `messages` (dedup by unique `whatsapp_message_id`), link/create the `clients` row. Then:
   - If `isOperational` → **store-and-skip** (no client creation dispatch, no bot).
   - `REPLY_ALLOWLIST` (if set) → non-allowlisted senders are stored but get no reply.
   - Dispatch async: `wantsHuman()` → escalation; else `handleIntake()` (auto-reply is **not** currently
     chained after intake here — see §3.2 **(verify)**).

---

## 3. Conversational bot

### 3.1 Intake state machine — `ai/intake.orchestrator.ts`, prompts in `ai/intake.prompts.ts`

**Slot order (`SLOT_ORDER`):**
`welcome → client_type → team_routing → full_name → email → inquiry_type → id_photo → poa → done`.
All prompts in Hebrew. Gated by `bot_settings.enabled` (singleton id=1) and the per-conversation pause
(auto-resumes when `bot_paused_until` lapses). New `clients` rows default `intake_current_slot='welcome'`.

- **welcome** — no message of its own; `handleWelcome` immediately advances to `client_type`. (The
  `welcome.text1/text2` strings in `intake.prompts.ts` are **dead** — never sent.)
- **client_type** — first thing the lead sees: `"שלום, תודה שפנית אלינו 🙏"` with two buttons
  **New client** / **Old client**. Any reply matching `/old/i` → `client_type='old'`, else `'new'`.
- **team_routing** — sends `"פנית לצוות שלנו — כיצד נוכל לעזור לך?"` with 4 buttons (Team Y / Team Z /
  Contact Didi / Stay). **The selection is not stored or acted on** — `handleTeamRouting` only branches on
  `client_type`: **old → jump straight to `done`** (skip data collection); new → continue to `full_name`.
  **(verify the intent of the team_routing buttons — they are currently cosmetic.)**
- **full_name / email** — text only. Email has a regex fast-path; otherwise both go through the LLM
  validator `classifyIntakeResponse` (invalid/off-topic → re-prompt, not stored).
- **inquiry_type** — interactive buttons, **fixed 7-button set** (button-only; free text must match a
  button id or label or it re-prompts):
  `vehicle` "ביטוח רכב", `home` "ביטוח דירה", `business` "ביטוח עסקים",
  `life_health_pension` "ביטוח חיים/בריאות/פנסיה", `travel` 'ביטוח נסיעות לחו"ל', `finance` "פיננסים",
  `other` "אחר". (Legacy free-text classification keys still exist only for old client rows.)
- **id_photo** — image only. One combined vision pass `validateIdPhoto()` confirms a readable ID **and**
  extracts the 9-digit Israeli ID number (`id_number`); foreign IDs are handled by the same OCR. On
  success the bytes (Clix base64 or fetched URL) are uploaded to **Google Drive** (see §10) and a
  `documents` row + `clients.id_photo_url`/`id_number`/`id_validated=true` are written. OCR/upload failure
  → re-prompt a resend (no data loss).
- **poa** — optional. Reply "דלג"/skip/לא/אין → advance; an image/document → uploaded to Drive + `documents`
  row + `clients.poa_doc_url`.
- **finalize (`done`)** — `classifyComplexity()` (skipped for old clients → `simple`) sets
  `clients.complexity`; flips `intake_state='completed'`, `pipeline_stage='meeting_scheduling'`; inserts a
  `meetings` row (`type='google_meet'`, `status='pending_booking'`) so booking-sync can match later; sends
  the **Calendly booking link** (`GOOGLE_CALENDAR_BOOKING_URL`); **pauses the bot** (`bot_paused=true`).
  Old vs new clients get slightly different done copy (`done_existing` vs `done`).

**Sheet mirror during intake:** `mirrorLeadToSheet(clientId)` is called on every slot advance and at
finalize (see §10) — best-effort, never blocks intake.

### 3.2 Free-form auto-reply — `ai/ai.orchestrator.ts`
Replies via OpenRouter using recent history, gated by `bot_settings.enabled` + `auto_reply` + pause.
**(verify):** the current `whatsapp.controller.ts` async dispatch calls `handleIntake()` but does **not**
appear to fall through to `handleIncomingMessage()`/auto-reply after intake completes the way the old doc
described — confirm whether free-form auto-reply is still wired into the inbound path.

### 3.3 Human escalation — `whatsapp/whatsapp.escalation.ts`
Trigger regex (נציג / בן אדם / אנושי / human / agent / representative …). Replies
`"בקשתך התקבלה. נציג יצור איתך קשר בהקדם."`, **pauses 2h**, and WhatsApps the **assigned staff + the
owner** (`role='owner'`) an alert. Sends go through `sendMessageWithTyping` (Clix or GreenAPI per the
chat). No notification row is written (the `notifications` table no longer exists).

### 3.4 Pause / cooldown system
- Manual human send (Clix outgoing, GreenAPI outgoing, or `POST /api/whatsapp/send`) → **1h**.
- Escalation → **2h**.
- Intake completion → indefinite (`bot_paused=true`).
- All timed pauses auto-expire via `bot_paused_until` and auto-resume. Global kill switch: `bot_settings`.

### 3.5 Booking → confirmation → reminders — `calendar/booking-sync.service.ts`, `calendar/reminder.service.ts`
Booking is via the **Calendly link** sent at finalize; the booked **Google Calendar** event carries a
**Zoom** link.
1. **booking-sync** (every 3 min, first run +30s) fetches recent calendar events since
   `system_settings.google_calendar_last_sync` and matches event→client in 3 tiers: (1) attendee **email**;
   (2) **unique name** among clients in `meeting_scheduling`; (3) **time-proximity** to a `pending_booking`
   meeting (closest by event-created time). On match it extracts the **Zoom link** (`extractZoomLink` scans
   location / conferenceData entry points / description), sets the meeting `scheduled`
   (`type = zoom` if a Zoom link was found, else `google_meet`), backfills client email, flips
   `pipeline_stage='meeting_scheduled'`, and sends the Hebrew **confirmation** — including the Zoom link
   line when present.
2. **24h** then **1h** reminders (`checkAndSendReminders`, every 10 min) with quiet-hours clamping
   (07:00–21:00 Asia/Jerusalem, DST-correct via `israelWallTimeInstant`/`clampedSendTime`); flags
   `reminder_24h_sent` / `reminder_1h_sent`.

---

## 4. Post-meeting flow (Timeless) — `integrations/timeless/*`, `meetings/meeting-handoff.service.ts`

Timeless.day records meetings + produces a summary. Delivered via **webhook**
(`meeting.transcript_ready` / `meeting.initial_summary_ready`, subscribed in `ensureWebhookRegistered`,
HMAC-verified) and an **hourly poll** backstop (`"0 * * * *"`, `timeless.poll.ts`). The webhook controller
verifies the signature, acks 200 immediately, records the event, and forwards `payload.id` to
`ingestTimelessMeeting` (no per-event branching; a missing id is skipped, the poll backstops it).

### 4.1 Ingest + matching — `timeless.service.ts`
- Idempotent: skips if already ingested **with a non-empty `summary_draft`**; back-fills if the match
  exists but the summary is still empty; skips if an open `timeless_unmatched_meetings` row exists.
- **Candidate window = same Israel calendar day** (helper `isSameIsraelDay`). It pre-filters meetings
  within ±24h of the Timeless start time, then keeps only those on the **same Jerusalem date**, that are
  `scheduled`/`confirmed`/`in_progress` and not yet linked to a Timeless meeting.
- **Hard email gate + scoring.** Each candidate is scored: client email is a participant **+10**; host is
  staff **+5**; start within 5 min **+5** / 15 min **+2**; **source-type bonus +3** for
  google_meet↔google_meet, phone↔phone, **zoom↔zoom**. Only candidates whose **client email is a
  participant** survive the gate. No survivor → **park** in `timeless_unmatched_meetings`
  (`no_candidates`/`low_score`); ambiguous (top − runner-up `< 5`) → park `ambiguous`. **Nothing is sent
  for parked meetings** until linked manually (`POST /unmatched/:id/link`). ⟵ main silent-failure point.
- On match: pulls transcript + recording + the summary document (`resolveSummaryDoc`, title keywords incl.
  סיכום/תקציר, single-doc fallback), stores them, `ensureHebrew()` on the summary.

### 4.2 Delivery order — `applyIngest` (only when a summary exists)
1. `sendSummaryToOwner` — the **owner WhatsApp** (`SUMMARY_RECIPIENT_PHONE`) gets the Hebrew summary via
   **Clix `clixSendText`**, no buttons. Atomic claim flips `summary_status='sent'`.
2. **5 s gap** (`OWNER_BUBBLE_GAP_MS`) to avoid spam flags.
3. `sendStaffPickerToOwner` — owner gets a **second bubble**: a button per active staff
   (`assign_staff:<meetingId>:<staffId>`) via **Clix `clixSendButtons`** (handles > 3 buttons). Idempotent
   via `staff_picker_sent_at`.
4. `sendClientSummaryEmail` — the **client gets the summary by EMAIL** (only if an email is on file) via
   the single Google Workspace Gmail (`sendOwnerEmail`). Subject `"סיכום הפגישה שלך"`, signed off
   "צוות שקד". Idempotent via `client_summary_emailed_at`. **No human review gate before this email.**

### 4.3 Owner taps a staff button → `meetings/meeting-handoff.service.ts` `assignStaffToMeeting`
- **First-tap-wins** atomic claim of `clients.assigned_handler_id` (dup taps reply `"✅ כבר הוקצה ל…"`).
- Sets `clients.last_service_date = today` if unset (**starts the biennial service clock**).
- `notifyStaffHandoff` — the chosen staff gets a **minimal one-bubble** Clix handoff:
  `"👤 דידי הקצה אותך לטיפול בלקוח {name}"` followed by `"📝 סיכום הפגישה"` + the summary. (No client file /
  doc links / task list — that detail is gone with the task chain.)
- **5 s gap** (`HANDOFF_ACK_GAP_MS`), then the owner gets an ack `"✅ הוקצה ל{name}"`.
- `tryAssignByStaffName` is a **test-only** self-chat helper (resolves staff by name against the
  most-recent picker-sent meeting); inert in production where the owner is a separate phone.

> **No task-chain, no dormant approve/edit path.** The old `summary_status='draft'` → staff
> approve/edit → client WhatsApp-confirm flow has been removed. `summary_status` only goes
> `draft → sent` now (the `approved` value is unused), and the `client_confirmed` column is vestigial.

---

## 5. Operational bot — three pillars (`operations/*`, `commitments/*`)

All operational sends use the **GreenAPI operational line** (`opCreds()` → `sendMessageWith`), targeting
the line's **own self-chat** (`system_settings.op_self_chat_id`, captured from a call webhook's `wid`;
commitments resolve `commitment_self_chat_id` via `getWaSettings`). The email pillar sends via Gmail.

### 5.1 Pillar 1 — Missed/declined-call reminder — `operations/call-events.service.ts`, `call-reminder.service.ts`
- **Ingest.** Op-line call webhooks → `recordCallEvent` upserts one row per call into `call_events`,
  keyed by `id_message` (`ON CONFLICT (id_message) DO UPDATE` so the offer + outcome collapse into one
  row). Status mapping: `offer→ringing`, `pickUp→accepted`, `hangUp→declined` (**we** rejected),
  `declined→missed` (caller's call went unanswered). `direction` from `incomingCall`/`outgoingCall`.
- **Build (`buildCallReminderSection`).** Looks back 24h for **incoming** calls that are `missed`/`declined`,
  one row per phone (`getUnresolvedMissedSince`): **latest-wins / answered-callback-cancels** — a later
  `accepted` call to the same (digit-normalised) number suppresses the entry. Output:
  `"היי, תזכורת על שיחות שלא נענו אתמול:"` + `- <phone> בשעה <HH:mm>` lines.
- **Send.** `sendDailyCallReminder` exists as a standalone sender (manual route), but in production this
  section is **merged into the 08:00 morning digest** (§5.4). `call_events` are pruned older than 48h after
  each send.

### 5.2 Pillar 2 — Personal commitment reminders — `commitments/*`
- **Scan (`scanRecentChats`).** Reads the op line's last-24h **incoming + outgoing** journals
  (`lastIncoming/OutgoingMessagesWith`, 1440 min), buckets per 1:1 chat (skips groups and the
  excluded self/bot chat ids), produces dated transcripts labelled `Didi:` vs the contact.
- **Detect (`detectCommitments`).** LLM (`COMMITMENT_AI_MODEL`, fallback `gemini-2.5-flash`, JSON mode)
  extracts **only Didi's own future plans** he proposes or agrees to (meet/call/send/come/get-back, or
  agreeing to a time) — **never** chores others tell Didi to do, and never past/vague items. Output `what`
  is written in **Hebrew**; relative dates resolved against the conversation's Jerusalem date. Each is
  inserted into `commitments` with a derived `kind` and `fire_at`; dedup key
  `source_message_id = "<chatId>:<djb2(what)>"` (partial-unique, raw SQL `ON CONFLICT … DO NOTHING`).
- **`fire_at` rules (`commitments.fireat.ts`).** `timed` (date + time) → **1 h before**, clamped to
  07:00–21:00 Jerusalem; `date_only` (date, no time) → **08:00 on the due date**; `floating` (neither) →
  **next day 08:00** (message date + 1 day).
- **Fire.**
  - **Timed:** `fireTimedReminders` runs every **15 min** (`setInterval` in `startCommitmentCrons`). It
    cancels `timed` rows that are stale by > 2 h, then sends due rows grouped by minute as
    `"⏰ תזכורת:"` + `• <text> בשעה <HH:mm> — <contact>`, and flips them to `sent`.
  - **Date-only / floating:** `buildMorningCommitmentSection` (status `pending`, kind in
    `date_only`/`floating`, `fire_at <= now`) is composed by the LLM into a Hebrew bullet list
    (`"בוקר טוב! התזכורות להיום:"`, fallback template on LLM failure) and **merged into the 08:00 digest**;
    the included ids are then marked `sent`.
- All commitment reminders go to Didi's **op self-chat**.

### 5.3 Pillar 3 — Email staff-mentions — `operations/email-mentions.service.ts`
- **Scan (`scanAndStoreSentMentions`).** Lists Didi's **sent** Gmail of the last day
  (`in:sent newer_than:1d`), skips e-sign/process-completion templates (subject matches
  `חתימה מרחוק|סיום תהליך`), and for each active **agent** staff checks whether the **To/CC** contains the
  staff local-part (so both `@shaked-ins.com` and `@ddins.net` match; body matching was removed to avoid
  quoted-header false positives). Matches are inserted into `email_staff_mentions`, dedup
  `(gmail_message_id, staff_id)`.
- **Notify (`notifyStaffMentions`).** Groups pending rows per staff and composes a Hebrew reminder
  (subject `"תזכורת ממשרד שקד"`; body lists the email subjects). **Delivery is gated by
  `STAFF_EMAIL_NOTIFY_MODE`** (default **`log`** = dry-run to pm2 logs, **no send**; `send` = actually
  email each staff via `sendOwnerEmail`). Rows flip to `status='sent'` either way (idempotent).
- `runStaffEmailNotify` (scan + notify) runs at **08:00** alongside the digest cron.

### 5.4 The merged 08:00 digest — `operations/morning-digest.service.ts`
`sendMorningDigest` (cron `0 8 * * *`, Asia/Jerusalem) re-scans commitments (`refreshCommitments`), builds
the **commitment morning section** and the **call-reminder section**, joins them (commitments first, blank
line, then calls) into **one** Hebrew self-message to the op line, marks the included commitments `sent`,
and prunes old `call_events`. If both sections are empty it sends nothing. The same cron tick also fires
`runStaffEmailNotify` (Pillar 3).

### 5.5 Manual triggers — `operations/operations.controller.ts` + `operations.routes.ts`
Admin-only (`authenticate` + `authorize("admin")`) POST endpoints under `/api/operations` mirror the
scheduled jobs: `/call-reminder/run`, `/commitments/run`, `/morning-digest/run`, `/email-mentions/run`.

### 5.6 Biennial service meetings — `calendar/service-meeting.service.ts`
`checkServiceMeetingEligibility` (daily) finds **active** clients with `last_service_date` null or older
than 24 months and **messages the client directly** (Hebrew retention outreach to book a service meeting)
via `sendServiceDueToClient` → `sendMessageWithTyping` (Clix/GreenAPI per chat). This is the only piece of
the old operational layer that was rebuilt.

> **Removed (confirmed absent from the codebase):** the task-chain milestone engine
> (`TASK_CHAIN_DEFINITION`, `checkDueAndOverdueTasks`, `completeTask`, `advancePipelineStage`), the SLA
> breach monitor (`checkSlaBreaches`), the old daily digest, the WhatsApp-unanswered scan, the
> Gmail-milestone scan, and the cross-check advisory. There is **no `tasks` table, no `notifications`
> table, and no `v_client_pipeline` view** anymore.

---

## 6. Scheduled jobs — cadence summary (`server.ts`)

All schedulers are gated to **public production only** (`isPublicWebhook`: HTTPS `BACKEND_URL`, not
localhost) so dev boots never touch live lines or prod data. Timeless cron additionally requires
`TIMELESS_API_KEY`.

| Job | Trigger | Cadence | Source |
|---|---|---|---|
| Calendar booking sync | `setTimeout` + `setInterval` | first +30 s, then every 3 min | `booking-sync.service.ts` |
| Appointment reminders (24h/1h) | `setInterval` | every 10 min | `reminder.service.ts` |
| Service-meeting eligibility (biennial) | `setInterval` | every 24 h | `service-meeting.service.ts` |
| Commitment timed reminders | `setInterval` (`startCommitmentCrons`) | every 15 min | `commitments.reminders.ts` |
| Morning digest (commitments + calls) **and** email staff-mentions | `cron` | `0 8 * * *` Asia/Jerusalem | `morning-digest.service.ts` + `email-mentions.service.ts` |
| Timeless meeting poll (backstop) | `cron` | `0 * * * *` (hourly) | `timeless.poll.ts` |

Note: the **call reminder** is not independently scheduled — it ships inside the 08:00 digest. There is
**no** SLA / unanswered-scan / milestone-task cron anymore.

---

## 7. Data model & where everything is saved (`db/schema.sql` + filesystem/Drive)

**Tables (14):** `staff`, `clients`, `meetings`, `documents`, `audit_logs`, `conversations`, `messages`,
`bot_settings`, `system_settings`, `whatsapp_instances`, `timeless_unmatched_meetings`, `commitments`,
`call_events`, `email_staff_mentions`. **No `tasks`, `notifications`, `gmail_integrations`, or
`v_client_pipeline`.**

- `clients`: `pipeline_stage`, `complexity`, `id_number`, `policy_number`, `client_type` (`new`/`old`),
  `assigned_to` / `assigned_handler_id` (handler preferred), `last_service_date`, intake columns
  (`intake_state`, `intake_current_slot` incl. `client_type`/`team_routing`, `id_photo_url`, `poa_doc_url`,
  `id_validated`, `intake_completed_at`), and `mirrored_to_sheet_at` (column exists but is **not currently
  read/written by the lead-mirror code** — sheet idempotency is phone-based, see §10).
  `inquiry_type` CHECK includes the new fixed set (`home`, `life_health_pension`, `finance`, `other`) plus
  legacy keys for old rows.
- `meetings`: `type` (`zoom`/`phone`/`in_person`/`google_meet`), `status`
  (`pending_booking → scheduled → confirmed → done → cancelled`), `summary_draft`/`summary_final`,
  `summary_status` (`draft`→`sent`; `approved` unused), `client_confirmed` (vestigial),
  `timeless_meeting_id` (unique), idempotency claims `staff_summary_notified_at` /`staff_picker_sent_at` /
  `client_summary_emailed_at`, reminder flags, `calendar_event_id`, `conversation_id`.
- `commitments`: `chat_id`, `direction`, `source_message_id` (synthetic, partial-unique), `commitment_text`
  (Hebrew), `counterparty`, `due_date`/`due_time`, `kind` (`timed`/`date_only`/`floating`), `fire_at`,
  `status` (`pending`/`sent`/`cancelled`), `sent_at`.
- `call_events`: `id_message` (unique), `direction`, `counterpart_phone`, `status`
  (`ringing`/`accepted`/`declined`/`missed`), `is_video`, `called_at`.
- `email_staff_mentions`: `gmail_message_id`, `staff_id`, `staff_email` (canonical delivery target),
  `detected_via` (`to_cc`/`body`), `subject`/`recipients`/`snippet`, `status` (`pending`/`sent`/`cancelled`),
  unique `(gmail_message_id, staff_id)`.
- `whatsapp_instances`: `gateway_customer_id` (Clix, unique), `green_api_*`, `purpose`
  (`conversational`/`operational`), `is_connected` (generated).
- `system_settings`: key/value store — keys include `google_calendar_last_sync`, `op_self_chat_id`,
  `commitment_self_chat_id`/`commitment_bot_chat_id`, `google_ws_refresh_token`,
  `timeless_webhook_id`/`timeless_webhook_secret`/`timeless_last_event_at`/`timeless_last_poll_at`,
  `leads_sheet_tab_resolved:<tab>`.

### Storage backends
- **Postgres** (self-hosted on the VPS) — all structured data, via the `supabaseAdmin` shim / raw `pool`.
- **Google Drive** — **new** intake ID/POA documents (§10). The Drive `webViewLink` is stored in
  `clients.id_photo_url`/`poa_doc_url` and `documents.file_url`.
- **Filesystem** (`STORAGE_DIR`, default `./storage`) — legacy uploaded documents only; served via signed
  `/files/*splat` (HMAC `JWT_SECRET`). `lib/storage.ts` (`fetchRemoteFile` downloads remote bytes for the
  Drive upload path).
- **External (not in our DB)** — Google Calendar (events, read), Gmail (one Workspace mailbox; OAuth
  refresh token in `system_settings`), Google Sheets (lead mirror), Timeless.day (recordings/transcripts/
  summary docs — fetched, summary copied into `meetings`), Clix + GreenAPI (message/call transport only).

### Writes by flow stage (the "where is X saved" map)
- **Inbound message** → `messages` (direction, sent_by, body, `whatsapp_message_id` unique-dedup, status).
  **Conversation** upsert → `conversations` (by `whatsapp_chat_id`; `last_message_at`,
  `whatsapp_instance_id` for Clix). **Client** create/link → `clients`. **Pauses** →
  `conversations.bot_paused` / `bot_paused_until`. Settings read → `bot_settings` (id=1).
- **Intake answers** → `clients` (`intake_state`, `intake_current_slot`, `client_type`, `full_name`,
  `email`, `inquiry_type`, `id_number`, `id_validated`, `complexity`, `pipeline_stage`,
  `intake_completed_at`). On each advance + finalize → **Google Sheet** row (new clients only, §10).
- **ID photo / POA file** → **Google Drive** (anyone-with-link) **+** `documents` row
  (`file_url`=webViewLink) **+** `clients.id_photo_url`/`poa_doc_url` (and `id_number` for the ID).
  **Finalize** → `clients` (completed, `pipeline_stage='meeting_scheduling'`, `complexity`) **+** `meetings`
  insert (`type='google_meet'`, `status='pending_booking'`) **+** `conversations.bot_paused=true`. **Bot
  replies** → `messages` (`sent_by='bot'`).
- **Escalation** → `conversations` (pause 2h) + `messages` (no notification row).
- **Booking sync** → `system_settings.google_calendar_last_sync`; `meetings` (`calendar_event_id`,
  `scheduled_at`, `status='scheduled'`, `type=zoom|google_meet`); `clients` (email backfill,
  `pipeline_stage='meeting_scheduled'`); `messages` (confirmation incl. Zoom link). **Reminders** →
  `meetings.reminder_24h_sent`/`reminder_1h_sent` + `messages`.
- **Timeless** → `meetings` (`timeless_meeting_id`, `transcript`, `summary_draft`, `recording_url`,
  `summary_final`, `summary_status`, and `staff_picker_sent_at` / `client_summary_emailed_at` idempotency
  claims); `timeless_unmatched_meetings` (parked); `system_settings` (`timeless_*`). The client summary
  **email** goes via Gmail (body not stored).
- **Staff assignment** → `clients` (`assigned_handler_id`, `last_service_date`). No task rows.
- **Operational** → `call_events` (call webhooks, pruned > 48h); `commitments` (insert pending → `sent`/
  `cancelled`); `email_staff_mentions` (insert pending → `sent`); `system_settings`
  (`op_self_chat_id`, `commitment_self_chat_id`).

---

## 8. Config / providers (`config/env.ts`)

- **WhatsApp:** GreenAPI instance #1 `GREENAPI_*` **required but unused** (retired line). Scan/op creds
  `GREENAPI_SCAN_*` and `GREENAPI_OP_*` optional (features stay dormant if unset). Clix:
  `CLIX_WEBHOOK_TOKEN` required (inbound); `CLIX_SEND_URL` + `CLIX_SEND_TOKEN` optional (outbound — must
  both be set to enable Clix sends).
- **AI:** `OPENROUTER_API_KEY` required; `AI_MODEL` default `google/gemini-2.5-flash`; `AI_FALLBACK_MODEL`
  `google/gemini-3.1-pro-preview`; `COMMITMENT_AI_MODEL` `google/gemini-3.1-flash-lite`.
- **Google:** **Calendar** OAuth `GOOGLE_*` (separate client) for booking sync. **Workspace** OAuth
  `GOOGLE_WS_CLIENT_ID`/`GOOGLE_WS_CLIENT_SECRET` (single account) for Sheets + Drive + Gmail. The old
  per-staff `GOOGLE_OAUTH_*` Gmail vars are **gone**.
- **Timeless:** `TIMELESS_API_KEY`; `SUMMARY_RECIPIENT_PHONE` (owner summary line, also gates the
  operational-only owner number in the webhook).
- **Leads mirror:** `LEADS_SPREADSHEET_ID`, `LEADS_SHEET_TAB`, `LEADS_SHEET_TAB_NEW`,
  `LEADS_DRIVE_FOLDER_ID`, `LEADS_MIRROR_ENABLED` — all have defaults in `env.ts`.
- **Provider toggles:** `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER` (`stub`/`live`); `STAFF_EMAIL_NOTIFY_MODE`
  (`log` default / `send`). (No `BAFI_PROVIDER` — BAFI is dropped.)
- `.env` lives on the VPS (not carried by the deploy workflow). Admin/ops endpoints use the static
  `ADMIN_API_TOKEN`.

---

## 9. Known issues / things to watch (as of 2026-06-29)

- **Client summary email has no human review gate** (§4.2) — the client receives the AI summary
  (Hebrew-normalised) directly.
- **Unmatched Timeless meetings are silent** (§4.1) — depend on the client-email-as-participant hard gate;
  recover via `GET /unmatched` + `POST /unmatched/:id/link`.
- **`sendOwnerEmail` From address.** The code sets **no `From:` header** — Gmail sends from the
  authorised Workspace mailbox (`userId:"me"` = `didi@ddins.net`, which holds the `google_ws_refresh_token`).
  That account's **primary send-as is `shaked-ins.com`**, so the From shown to recipients resolves to
  **`"דידי פרידלנדר" <didi@shaked-ins.com>`** — confirmed by a real test send (2026-06-28).
- **GreenAPI instance #1 is retired but still required by `env.ts`** — its dead creds must stay in `.env`
  or boot fails. The conversational bot falls back to it only for non-Clix-tagged conversations; in
  practice that line is offline, so a fallback send would error.
- **`STAFF_EMAIL_NOTIFY_MODE` defaults to `log`** — Pillar 3 is **dry-run** until flipped to `send`. Rows
  still flip to `sent`, so flipping the mode later won't re-notify already-scanned mail.
- **`SUMMARY_RECIPIENT_PHONE` may be a test number** — verify it points at Didi's real WhatsApp before
  go-live; the owner-summary/staff-picker flow targets it.
- **`team_routing` buttons are cosmetic (verify intent)** — the choice (Team Y/Z/Contact Didi/Stay) is
  shown but never stored or acted on; routing is driven only by the new/old `client_type`.
- **Auto-reply wiring (verify)** — confirm whether free-form `ai.orchestrator` auto-reply still runs after
  intake on the current inbound path (§3.2).
- **Old-client sheet routing does not exist** — the lead mirror is new-clients-only (§10); there is no
  `לקוח קיים` tab write despite the historical mention.
- **PII:** intake ID/POA documents live in Google Drive as **anyone-with-link** (deliberate); the links
  sit in the CRM sheet + staff handoff (§10).

---

## 10. Lead mirror → Google Sheets + Drive (single Google Workspace account)

**Single-account Google OAuth** (`GOOGLE_WS_*`, separate from the Calendar `GOOGLE_*` client): one agency
Workspace account, scopes `spreadsheets` + `drive.file` + `gmail.readonly` + `gmail.send` (no calendar).
Refresh token in `system_settings.google_ws_refresh_token`. Routes
`GET /api/integrations/google/{authorize,callback,status}` (public OAuth browser flow); shared helper
`getAuthenticatedClient()` in `integrations/google/google.auth.ts`. This account also powers
`sendOwnerEmail` (the client-summary and staff-mention emails) and the Gmail sent-mail scan.

**During intake (the Drive upload path in §3.1):**
- **ID photo** (only after OCR passes) and **POA** (if provided) are uploaded to Drive folder
  `LEADS_DRIVE_FOLDER_ID` as `"<full name> - ID"` / `"<full name> - POA"`, set **anyone-with-link**
  reader. The Drive `webViewLink` is stored in `clients.id_photo_url`/`poa_doc_url` **and**
  `documents.file_url`. On Drive/fetch failure the bot re-prompts a resend (no data loss).

**Lead row mirror — `mirrorLeadToSheet(clientId)`** (called on each slot advance + at finalize,
best-effort, never blocks intake):
- **New clients only.** If `client_type !== 'new'` it returns immediately — **old/existing clients are
  never mirrored**, and there is no existing-client tab in code.
- Appends/updates one row on the **`לידים חדשים`** tab (`LEADS_SHEET_TAB_NEW`) of the CRM spreadsheet
  (`LEADS_SPREADSHEET_ID`). The tab title is resolved against live sheet metadata (trim-match, handling a
  trailing space) and cached in `system_settings.leads_sheet_tab_resolved:<tab>`.
- **Columns A→H:** phone, full_name, email, inquiry_type (Hebrew via `INQUIRY_TYPE_HE`, blank until a real
  button is chosen), ID-photo Drive URL, POA Drive URL, id_number, blank.
- **Idempotency is phone-based:** `upsertLeadRow` finds the row whose column-A phone (digit-normalised)
  matches and updates it in place, else appends. (The `clients.mirrored_to_sheet_at` column is **not**
  used by this code.)

**Modules:** `integrations/google/{google.auth,google.gmail,google.drive,google.sheets,leads-mirror.service}.ts`.
