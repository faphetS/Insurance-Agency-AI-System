# SYSTEM_FLOW.md — End-to-End Behavioral Reference

> Canonical description of **how the system behaves**, re-traced from source on **2026-07-01**.
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

Two logical "bots" share the codebase but run on **different WhatsApp gateways**:

- **Conversational bot** — talks to leads/clients (intake, auto-reply, booking, reminders) and routes
  post-meeting summaries to the owner. Runs on the **conversational GreenAPI instance** (`GREENAPI_*`).
- **Operational bot** (rebuilt 2026-06-25 as **three pillars**) — a back-office assistant for Didi:
  missed/declined-call reminders, personal-commitment reminders, and email staff-mentions. **Scans** via
  the **GreenAPI operational instance (#2)** (journal reads only) plus the single Google Workspace Gmail.
  Missed/declined calls are ingested via **Zadarma** (SIM/VoIP, `POST /api/zadarma/call-webhook`) — the
  GreenAPI op-line call-webhook path has been removed. All **Didi-facing reminders go through the
  conversational GreenAPI instance** (`notifyOwner`) — a real notification to Didi, not a silent
  self-note — see §5 and §5a.

**Major changes since the 2026-06-24 trace** (all reflected below): GreenAPI instance #1 retired and then
fully replaced — the conversational bot now runs on a freshly provisioned GreenAPI conversational instance;
Clix was **removed entirely** (commit `38c563e`); old operational engine (task-chain milestones, SLA
monitor, old daily digest, WhatsApp-unanswered scan, Gmail-milestone scan, cross-check) **removed and
replaced** by the three pillars; booking switched to Calendly + Zoom; intake v2 (new/old fork, 7-button
inquiry); Timeless matching switched from ±30 min to **same Israel calendar day**; Gmail consolidated to
one Workspace account (per-staff `gmail_integrations` removed). The post-meeting **dormant approval path
is gone**. **2026-06-29: conversational bot migrated Clix→GreenAPI (commit `38c563e`); Clix removed;
interactive buttons uncapped; biennial service-meeting reminder reworked (08:10 cron, null-date fix,
fire-once re-arm via `clients.last_service_reminder_at`, trimmed message, reopens intake on send).
2026-07-01: Zadarma is now the sole missed-call ingest source (`POST /api/zadarma/call-webhook`);
GreenAPI op-line call-event recording removed; intake v3 — `team_routing` slot dropped, `inquiry_type`
now immediately follows `client_type`; old-client branch adds `issue`→`action_choice` slots; human
escalation (`whatsapp.escalation.ts`) deleted; department-routing WhatsApp ping on inquiry-type
selection added.**

---

## 1. Gateways & WhatsApp instances

Two WhatsApp transports are in play. A connected line maps to a `whatsapp_instances` DB row
(`purpose` = `conversational` | `operational`, `green_api_*` for GreenAPI). Clix is fully removed.

- **GreenAPI conversational instance (`GREENAPI_*`)** — the **live conversational line** as of commit
  `38c563e`. All four env vars (`GREENAPI_ID_INSTANCE`, `GREENAPI_API_TOKEN`, `GREENAPI_BASE_URL`,
  `GREENAPI_WEBHOOK_TOKEN`) are **optional** in `env.ts` — when blank, outbound sends no-op with a log
  warning (staged rollout guard). When set, `whatsapp.service.ts` uses `envCreds()` for all sends and
  `setWebhookSettings` can register the inbound webhook URL. Outbound text goes via `sendMessage` /
  `sendMessageWithTyping`; buttons go via `sendInteractiveButtons` / `sendInteractiveButtonsWithTyping`
  → GreenAPI endpoint `sendInteractiveButtonsReply`, body `{chatId, body, footer?, buttons:[{buttonId,
  buttonText}]}`. **No button cap** — GreenAPI delivers >3 reply buttons without issue; the 7-button
  inquiry menu, 2-button action_choice, and N-button staff-picker all send fine. Button taps return
  `interactiveButtonsResponse.selectedId`. Media arrives via GreenAPI `downloadUrl` (fetched server-side
  with `storage.fetchRemoteFile`), not inline base64.
- **GreenAPI operational instance (#2)** — **scan-only** for the operational bot (it does not send
  Didi's reminders; those go via the conversational instance, see §5). Its inbound webhooks are ACK'd
  and immediately dropped (no call recording via this path — see §5a). Two env families coexist:
  - `GREENAPI_OP_*` (`opCreds()`) — the **operational line**. Its 24h message journals are what
    the commitment scanner reads. `opCreds()` being configured is the gate that enables the
    operational features.
  - `GREENAPI_SCAN_*` (`scanCreds()` / `opsCreds()`) — pull-based journal reads
    (`lastIncoming/OutgoingMessagesWith`). The commitment scanner reads the op line's 24h journals
    through these. **(verify)** whether `GREENAPI_OP_*` and `GREENAPI_SCAN_*` point at the same
    physical line in `.env`; the code treats them as separate cred sets.

**Outbound routing:** all conversational sends — intake replies, button menus, appointment confirmations,
reminders, post-meeting summaries, staff-picker, owner acks, and the operational Didi-facing reminders
— go through the single conversational GreenAPI instance via `envCreds()`. There is no per-chat gateway
selection and no `resolveGatewayForChat`. `sendMessage` / `sendMessageWithTyping` /
`sendInteractiveButtonsWithTyping` are all direct GreenAPI calls; if creds are blank they return a
`noop:` idMessage and log a warning.

Helpers: `toChatId()` normalises Israeli numbers to `<972…>@c.us`; `isStaffChat()` matches a chat
against active staff phones; `extractButtonId()` reads GreenAPI interactive-button taps.
(`whatsapp.util.ts`, `whatsapp.service.ts`)

---

## 2. Inbound webhook dispatcher — `whatsapp/whatsapp.controller.ts`

Single front door (`POST /api/whatsapp/webhook`). Always returns 200 fast; real work runs in
`setImmediate`. Decision order:

1. **Operational-instance short-circuit.** If `instanceData.idInstance === GREENAPI_OP_ID_INSTANCE`
   → **ACK 200 and stop immediately** (no call recording, no pipeline). SIM/cellular missed calls are
   captured independently via the Zadarma webhook (§5a). The op-line wid / self-chat-id derivation that
   used to happen here has been removed along with `recordCallEvent`.
2. **Token check.** Accepts `Authorization: Bearer <GREENAPI_WEBHOOK_TOKEN>` or
   `?token=<GREENAPI_WEBHOOK_TOKEN>`. Mismatch → **200 + ignore** (GreenAPI retry suppression).
3. `outgoingAPIMessageReceived` (bot's own API send) → ignore.
4. `outgoingMessageReceived` (human typed from the phone):
   - Owner self-chat staff-picker tap (`assign_staff:<meetingId>:<staffId>`) — in production the owner
     is a separate phone and taps arrive as `incomingMessageReceived`; this branch handles the test-only
     case where the bot's number is the owner number (`SUMMARY_RECIPIENT_PHONE` = bot line) → `assignStaffToMeeting`.
   - Message our bot sent (matched by `whatsapp_message_id` + `sent_by='bot'`) → skip.
   - Otherwise (non-group) → **pause bot 1h** for that chat.
5. Only `incomingMessageReceived` proceeds. Group chats (`@g.us`) → ignore.
6. **Owner number** (`SUMMARY_RECIPIENT_PHONE`) → operational-only: only `assign_staff:` taps act
   (`assignStaffToMeeting`); everything else ignored (never enters intake).
7. **Staff intercept** (`isStaffChat`) → **log and skip** (staff inbound does nothing here).
8. Else **client**: upsert `conversations` (by `whatsapp_chat_id`), insert inbound `messages` (dedup by
   unique `whatsapp_message_id`), link/create the `clients` row. Then:
   - `REPLY_ALLOWLIST` (if set) → non-allowlisted senders are stored but get no reply.
   - Dispatch async: `handleIntake()` (auto-reply is **not** currently chained after intake here — see
     §3.2 **(verify)**). Human escalation has been **removed** — `wantsHuman()` and
     `whatsapp.escalation.ts` are deleted.

**Media payload:** GreenAPI sends images and documents as a `downloadUrl` in `imageMessageData`,
`documentMessageData`, or `fileMessageData`. `extractPayload` (`whatsapp.validator.ts`) reads these and
returns `{ kind: "image"|"document", fileUrl, ... }` — the URL is fetched server-side later (e.g. for
Drive upload). Button taps are extracted from `interactiveButtonsResponse.selectedId` /
`templateButtonReplyMessage.selectedId` / `buttonsResponseMessage.selectedButtonId` (all three shapes
are checked in order against both the Zod-parsed payload and the raw body).

---

## 3. Conversational bot

### 3.1 Intake state machine — `ai/intake.orchestrator.ts`, prompts in `ai/intake.prompts.ts`

**Slot order (`SLOT_ORDER`):**
`welcome → client_type → inquiry_type → full_name → email → id_photo → poa → done`.
Two branch-only slots exist outside `SLOT_ORDER` for the existing-client path: `issue` and `action_choice`.
All prompts in Hebrew. Gated by `bot_settings.enabled` (singleton id=1) and the per-conversation pause
(auto-resumes when `bot_paused_until` lapses). New `clients` rows default `intake_current_slot='welcome'`.

- **welcome** — no message of its own; `handleWelcome` immediately advances to `client_type`. (The
  `welcome.text1/text2` strings in `intake.prompts.ts` are dead — never sent.)
- **client_type** — first thing the lead sees:
  `"היי, הגעתם לשקד סוכנות לביטוח - דידי פרידלנדר. נשמח לעזור לך! כדי שנוכל להפנות אותך לגורם המתאים, אנא בחר/י:"`
  with two buttons: `old_client` "אני לקוח/ה קיים/ת" / `new_client` "אני עדיין לא לקוח/ה".
  Any reply matching `/old/i` or containing `קיים` → `client_type='old'`; otherwise `'new'`. Both paths
  then advance to **inquiry_type**.
  (`team_routing` slot and its 4-button cosmetic menu have been **removed**.)
- **inquiry_type** — interactive buttons, **fixed 7-button set** (button-only; free text must match a
  button id or label or it re-prompts):
  `vehicle` "ביטוח רכב", `home` "ביטוח דירה", `business` "ביטוח עסקים",
  `life_health_pension` "ביטוח חיים/בריאות/פנסיה", `travel` 'ביטוח נסיעות לחו"ל', `finance` "פיננסים",
  `other` "אחר". On selection: (1) **department-routing ping** fires fire-and-forget (see below);
  (2) **path forks by `client_type`**: `old` → advance to `issue`; `new` → advance to `full_name`.
- **issue (old-client branch only)** — free-text description of the problem; stored as
  `clients.issue_description`. Advances to `action_choice`.
- **action_choice (old-client branch only)** — two buttons: `move_to_rep` "מעבר לנציג/ה" →
  sends ack `"העברנו את הפרטים לנציג/ה הרלוונטי/ת — ניצור איתך קשר בהקדם"` then calls
  `finalizeRepresentative` (no booking link, `pipeline_stage='new_lead'`); `schedule_meeting`
  "קביעת פגישה" → advances to `done` (standard booking flow).
- **full_name / email (new-client path)** — text only. Email has a regex fast-path; otherwise both go
  through the LLM validator `classifyIntakeResponse` (invalid/off-topic → re-prompt, not stored).
- **id_photo (new-client path)** — image only. One combined vision pass `validateIdPhoto()` confirms a
  readable ID **and** extracts the 9-digit Israeli ID number (`id_number`); foreign IDs are handled by
  the same OCR. On success the bytes (fetched from the GreenAPI `downloadUrl`) are uploaded to **Google
  Drive** (see §10) and a `documents` row + `clients.id_photo_url`/`id_number`/`id_validated=true` are
  written. OCR/upload failure → re-prompt a resend (no data loss).
- **poa (new-client path)** — optional. Reply "דלג"/skip/לא/אין → advance; an image/document → uploaded
  to Drive + `documents` row + `clients.poa_doc_url`.
- **finalize (`done`)** — `classifyComplexity()` (skipped for old clients → `simple`) sets
  `clients.complexity`; flips `intake_state='completed'`, `pipeline_stage='meeting_scheduling'`; inserts a
  `meetings` row (`type='google_meet'`, `status='pending_booking'`) so booking-sync can match later; sends
  the **Calendly booking link** (`GOOGLE_CALENDAR_BOOKING_URL`); **pauses the bot** (`bot_paused=true`).
  Old vs new clients get slightly different done copy (`done_existing` vs `done`).
  `finalizeRepresentative` (old-client → rep path) sets `pipeline_stage='new_lead'`, no booking link, and
  also pauses the bot and calls `mirrorLeadToSheet`.

**Department-routing ping (`whatsapp/department-routing.ts`):** fires on inquiry-type selection,
fire-and-forget, never blocks intake. Elementary types (`vehicle`/`home`/`business`) ping
`DEPT_ELEMENTARY_PHONE`; life/finance types (`life_health_pension`/`finance`) ping
`DEPT_LIFE_FINANCE_PHONE`. Travel and other → no ping. Message sent via the conversational
`sendMessage`: `"📩 פנייה חדשה מהבוט\nסוג הביטוח: <label>\nטלפון הלקוח: <phone>\nסוג לקוח: מתעניין|לקוח קיים"`.

**Sheet mirror during intake:** `mirrorLeadToSheet(clientId)` is called on every slot advance and at
finalize (see §10) — best-effort, never blocks intake.

### 3.2 Free-form auto-reply — `ai/ai.orchestrator.ts`
Replies via OpenRouter using recent history, gated by `bot_settings.enabled` + `auto_reply` + pause.
**(verify):** the current `whatsapp.controller.ts` async dispatch calls `handleIntake()` but does **not**
appear to fall through to `handleIncomingMessage()`/auto-reply after intake completes the way the old doc
described — confirm whether free-form auto-reply is still wired into the inbound path.

### 3.3 Human escalation — **REMOVED**
`whatsapp/whatsapp.escalation.ts`, `wantsHuman()`, and the human-escalation branch in the webhook
dispatcher have been deleted. The old-client `action_choice → move_to_rep` path in the intake state
machine (§3.1) is the current replacement for routing an existing client to a representative.

### 3.4 Pause / cooldown system
- Manual human send (GreenAPI `outgoingMessageReceived`, or `POST /api/whatsapp/send`) → **1h**.
- Intake completion → indefinite (`bot_paused=true`).
- `finalizeRepresentative` (old-client → rep path) → indefinite (`bot_paused=true`).
- All timed pauses auto-expire via `bot_paused_until` and auto-resume. Global kill switch: `bot_settings`.
  (The 2h escalation pause is **gone** — human escalation was removed, §3.3.)

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
   GreenAPI `sendMessage` (conversational instance), no buttons. Atomic claim flips `summary_status='sent'`.
2. **5 s gap** (`OWNER_BUBBLE_GAP_MS`) to avoid spam flags.
3. `sendStaffPickerToOwner` — owner gets a **second bubble**: a button per active staff
   (`assign_staff:<meetingId>:<staffId>`) via GreenAPI `sendInteractiveButtons` (uncapped — all active
   staff rendered). Idempotent via `staff_picker_sent_at`.
4. `sendClientSummaryEmail` — the **client gets the summary by EMAIL** (only if an email is on file) via
   the single Google Workspace Gmail (`sendOwnerEmail`). Subject `"סיכום הפגישה שלך"`, signed off
   "צוות שקד". Idempotent via `client_summary_emailed_at`. **No human review gate before this email.**

### 4.3 Owner taps a staff button → `meetings/meeting-handoff.service.ts` `assignStaffToMeeting`
- **First-tap-wins** atomic claim of `clients.assigned_handler_id` (dup taps reply `"✅ כבר הוקצה ל…"` via
  GreenAPI `sendMessage`).
- Sets `clients.last_service_date = today` if unset (**starts the biennial service clock**).
- `notifyStaffHandoff` — the chosen staff gets a handoff **by EMAIL** (to `staff.email`) via
  `sendOwnerEmail`, gated by `STAFF_EMAIL_NOTIFY_MODE` (default `log` = dry-run; `send` = live). Body:
  `"👤 דידי הקצה אותך לטיפול בלקוח {name}"` + `"📝 סיכום הפגישה"` + the summary text. (No client file /
  doc links / task list — that detail is gone with the task chain.)
- **5 s gap** (`HANDOFF_ACK_GAP_MS`), then the owner gets a WhatsApp ack `"✅ הוקצה ל{name}"` via
  GreenAPI `sendMessage`.
- `tryAssignByStaffName` is a **test-only** self-chat helper (resolves staff by name against the
  most-recent picker-sent meeting); inert in production where the owner is a separate phone.

> **No task-chain, no dormant approve/edit path.** The old `summary_status='draft'` → staff
> approve/edit → client WhatsApp-confirm flow has been removed. `summary_status` only goes
> `draft → sent` now (the `approved` value is unused), and the `client_confirmed` column is vestigial.

---

## 5. Operational bot — three pillars (`operations/*`, `commitments/*`)

**Send transport:** the Didi-facing reminders (pillars 1 & 2 + the merged digest) **deliver through the
conversational GreenAPI instance** via `notifyOwner(text)` (`operations/owner-notify.ts` →
`sendMessage(toChatId(SUMMARY_RECIPIENT_PHONE), text)`) — a real notification to Didi. It returns `false`
(and sends nothing) if `SUMMARY_RECIPIENT_PHONE` is unset or the conversational GreenAPI creds are blank
(the no-op guard is inside `sendMessage`), and the "mark sent"/prune steps are gated on a `true` result.
**Scanning is still the GreenAPI op line** (`opCreds()` journals only — call webhooks are now handled by
Zadarma, §5a). The `commitment_self_chat_id` / `commitment_bot_chat_id` settings are still populated and
still used to **exclude Didi's own self/bot chat from the commitment scan** (`getExcludedChatIds`) — they
are not used as a send target. (`op_self_chat_id` is no longer actively re-derived since op-line call
webhooks were removed, but the key remains in `system_settings`.) The email pillar (3) still sends via
Gmail.

### 5.1 Pillar 1 — Missed/declined-call reminder — `operations/call-events.service.ts`, `call-reminder.service.ts`
- **Ingest.** Calls are now recorded **exclusively via the Zadarma webhook** (§5a). The old GreenAPI
  op-line call-webhook path (`recordCallEvent` / `mapStatus` for GreenAPI shapes) has been deleted.
  `call-events.service.ts` now only exports `recordZadarmaCallEvent`, `getUnresolvedMissedSince`, and
  `pruneCallsOlderThan`.
- **Build (`buildCallReminderSection`).** Looks back 24h for **incoming** calls with
  `status IN ('missed','declined')` via `getUnresolvedMissedSince`. The query is plain dedup-by-number:
  `SELECT counterpart_phone, MAX(called_at) FROM call_events WHERE ... GROUP BY counterpart_phone ORDER BY called_at ASC` —
  **no answered-callback suppression** (the "latest answered call cancels a missed-call entry" logic was
  removed). Output: `"תזכורת על שיחות שלא נענו אתמול:"` + `- <phone> בשעה <HH:mm>` lines.
- **Send.** `sendDailyCallReminder` exists as a standalone sender (manual route) and delivers to Didi
  via `notifyOwner` (conversational GreenAPI instance), but in production this section is **merged into
  the 08:00 morning digest** (§5.4). `call_events` pruned older than 48h after a successful send.

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
    `"⏰ תזכורת:"` + `• <text> בשעה <HH:mm> — <contact>`, and flips them to `sent` (only after a successful
    send).
  - **Date-only / floating:** `buildMorningCommitmentSection` (status `pending`, kind in
    `date_only`/`floating`, `fire_at <= now`) is composed by the LLM into a Hebrew bullet list
    (`"בוקר טוב! התזכורות להיום:"`, fallback template on LLM failure) and **merged into the 08:00 digest**;
    the included ids are then marked `sent`.
- All commitment reminders go to **Didi via the conversational GreenAPI instance** (`sendSelfMessage`
  wraps `notifyOwner` — despite the legacy name it sends to `SUMMARY_RECIPIENT_PHONE`, not as a
  self-message on the op line).

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
the **commitment morning section** and the **call-reminder section** in parallel, joins them (commitments
first, blank line, then calls) into **one** Hebrew message and sends it **to Didi via `notifyOwner`**
(conversational GreenAPI instance). If both sections are empty it returns early without sending anything.
After the send attempt: commitment ids are marked `sent` **only if the send returned `true`**; then
`pruneCallsOlderThan(48h)` runs **unconditionally** (regardless of send result, but only if there was
something to send — the empty-check above returns before this point). Still gated on `opCreds()` (scan
line must be configured). The same cron tick also fires `runStaffEmailNotify` (Pillar 3).

### 5a. Zadarma call-webhook ingest — `domains/zadarma/`
The sole source of missed-call data. Zadarma (SIM/VoIP telephony) pushes `NOTIFY_END` and `NOTIFY_OUT_END`
events to `POST /api/zadarma/call-webhook`.

- **Endpoint.** Mounted at `router.use("/zadarma", zadarmaRoutes)` in `routes/index.ts`; no auth
  middleware (Zadarma sends no bearer token). Two routes: `GET /api/zadarma/call-webhook` (echo
  handshake — returns `?zd_echo=<token>` as `text/plain`; open, no IP gate); `POST /api/zadarma/call-webhook`
  (call events — IP-gated).
- **IP gate.** The POST path resolves the real client IP from `x-real-ip` (nginx sets this; IPv4-mapped
  `::ffff:` prefix is stripped) or falls back to the last entry of `x-forwarded-for`. Only IPs in
  `185.45.152.40/30` (`.40`–`.43`) are accepted; others get `403`. A `?zd_echo` re-verification on the
  POST path is still echoed before the IP gate (Zadarma sometimes re-verifies on POST).
- **Event mapping (`zadarma.validator.ts`).** Only `NOTIFY_END` (inbound) and `NOTIFY_OUT_END` (outbound)
  are processed; other events return `null` (ignored). Requires `pbx_call_id` (used as `id_message`).
  Phone is taken from `caller_id` (inbound) or `destination`/`called_did` (outbound); normalised via
  `normalizePhone` (strips non-digits, leading `00` → strip, leading `0` → `972` prefix). Blank phone →
  skip. `disposition` mapping: `"answered"` (case/space-insensitive) → `accepted`; anything else → `missed`.
  `called_at` = server **receipt time** (`receivedAt` captured at request entry) — TZ-proof because
  `call_start` carries no timezone info. `id_instance` is the literal string `"zadarma"`.
- **Storage.** `recordZadarmaCallEvent` (`call-events.service.ts`) upserts into `call_events`
  `ON CONFLICT (id_message) DO UPDATE` — same table as always, so the existing `buildCallReminderSection`
  / `getUnresolvedMissedSince` / `pruneCallsOlderThan` all work unchanged.
- **Pending (requires owner action):** Zadarma account KYC completion, buy a number (`055` DID, ~$3/mo),
  attach to PBX, configure GSM call-forwarding on Didi's phone → then real missed-call data flows in.

### 5.5 Manual triggers — `operations/operations.controller.ts` + `operations.routes.ts`
Admin-only (`authenticate` + `authorize("admin")`) POST endpoints under `/api/operations` mirror the
scheduled jobs: `/call-reminder/run`, `/commitments/run`, `/morning-digest/run`, `/email-mentions/run`.

### 5.6 Biennial service meetings — `calendar/service-meeting.service.ts`
`checkServiceMeetingEligibility` (reworked 2026-06-29) runs on a **cron at 08:10 Asia/Jerusalem**
(`server.ts`, staggered after the 08:00 digest — no longer a boot-tied 24h `setInterval`). It finds
**`status='active'`** clients whose **`last_service_date` is non-null and `<= today − 2 years`** (the null
case is now **excluded** — that was a bug that messaged brand-new clients) **and** that have not already
been reminded for this overdue cycle (`last_service_reminder_at IS NULL OR last_service_reminder_at <
last_service_date`) — so a client is reminded **at most once per 2-year-overdue cycle** instead of every
day. It **messages the client directly** via `sendServiceDueToClient` → `sendMessageWithTyping`
(conversational GreenAPI instance).
The message is trimmed to **3 lines with no scheduling CTA and no reply nudge**:

> שלום [שם] 😊
> עברו שנתיים מאז הפגישה האחרונה שלנו — זה הזמן לפגישת שירות תקופתית.
> נשמח לבדוק יחד שהביטוחים שלך עדיין מתאימים לצרכים שלך ולעדכן במידת הצורך.

**On a successful send** it (1) stamps `clients.last_service_reminder_at = today` (the re-arm), and (2)
**reopens intake** — sets the client's `intake_state='collecting'` + `intake_current_slot='welcome'` and
clears the conversation's `bot_paused`/`bot_paused_until`, so the client's next reply re-enters the bot
greeting (New/Old client buttons → "Old client" → booking link). The biennial clock itself is still
started at staff-assignment by stamping `clients.last_service_date = today` (§4.3). This is the only piece
of the old operational layer that was rebuilt.

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
| Service-meeting eligibility (biennial) | `cron` | `10 8 * * *` Asia/Jerusalem | `service-meeting.service.ts` |
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
  `assigned_to` / `assigned_handler_id` (handler preferred), `last_service_date`,
  `last_service_reminder_at` (date, nullable — biennial re-arm; set on a successful service-meeting
  reminder so it fires at most once per overdue cycle, §5.6), intake columns
  (`intake_state`, `intake_current_slot` — active values: `welcome`/`client_type`/`inquiry_type`/`issue`/`action_choice`/`full_name`/`email`/`id_photo`/`poa`/`done`; `team_routing` is a legacy value only, slot removed; `id_photo_url`, `poa_doc_url`,
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
- `call_events`: `id_message` (unique — `pbx_call_id` from Zadarma), `id_instance` (`"zadarma"` for all
  new rows), `direction`, `counterpart_phone`, `status` (`accepted`/`missed` — `ringing`/`declined` are
  legacy values no longer produced by the Zadarma ingest path), `is_video` (always `false` for Zadarma),
  `called_at` (server receipt time).
- `email_staff_mentions`: `gmail_message_id`, `staff_id`, `staff_email` (canonical delivery target),
  `detected_via` (`to_cc`/`body`), `subject`/`recipients`/`snippet`, `status` (`pending`/`sent`/`cancelled`),
  unique `(gmail_message_id, staff_id)`.
- `whatsapp_instances`: `gateway_customer_id` (legacy Clix column — unused, Clix is removed), `green_api_*`,
  `purpose` (`conversational`/`operational`), `is_connected` (generated).
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
  summary docs — fetched, summary copied into `meetings`), GreenAPI (message/call transport only).

### Writes by flow stage (the "where is X saved" map)
- **Inbound message** → `messages` (direction, sent_by, body, `whatsapp_message_id` unique-dedup, status).
  **Conversation** upsert → `conversations` (by `whatsapp_chat_id`; `last_message_at`). **Client**
  create/link → `clients`. **Pauses** → `conversations.bot_paused` / `bot_paused_until`. Settings read
  → `bot_settings` (id=1).
- **Intake answers** → `clients` (`intake_state`, `intake_current_slot`, `client_type`, `full_name`,
  `email`, `inquiry_type`, `id_number`, `id_validated`, `complexity`, `pipeline_stage`,
  `intake_completed_at`). On each advance + finalize → **Google Sheet** row (new clients only, §10).
- **ID photo / POA file** → **Google Drive** (anyone-with-link) **+** `documents` row
  (`file_url`=webViewLink) **+** `clients.id_photo_url`/`poa_doc_url` (and `id_number` for the ID).
  **Finalize** → `clients` (completed, `pipeline_stage='meeting_scheduling'`, `complexity`) **+** `meetings`
  insert (`type='google_meet'`, `status='pending_booking'`) **+** `conversations.bot_paused=true`. **Bot
  replies** → `messages` (`sent_by='bot'`).
- **Old-client rep handoff** → `clients` (`intake_state='completed'`, `pipeline_stage='new_lead'`) +
  `conversations` (`bot_paused=true`). No booking link, no `meetings` insert.
- **Booking sync** → `system_settings.google_calendar_last_sync`; `meetings` (`calendar_event_id`,
  `scheduled_at`, `status='scheduled'`, `type=zoom|google_meet`); `clients` (email backfill,
  `pipeline_stage='meeting_scheduled'`); `messages` (confirmation incl. Zoom link). **Reminders** →
  `meetings.reminder_24h_sent`/`reminder_1h_sent` + `messages`.
- **Timeless** → `meetings` (`timeless_meeting_id`, `transcript`, `summary_draft`, `recording_url`,
  `summary_final`, `summary_status`, and `staff_picker_sent_at` / `client_summary_emailed_at` idempotency
  claims); `timeless_unmatched_meetings` (parked); `system_settings` (`timeless_*`). The client summary
  **email** goes via Gmail (body not stored).
- **Staff assignment** → `clients` (`assigned_handler_id`, `last_service_date`). No task rows.
- **Biennial service reminder** (§5.6) → on a successful client send: `clients`
  (`last_service_reminder_at = today`, `intake_state='collecting'`, `intake_current_slot='welcome'`) +
  `conversations` (`bot_paused=false`, `bot_paused_until=NULL`) + `messages` (the outreach). 
- **Operational** → `call_events` (Zadarma NOTIFY_END webhooks, pruned > 48h after digest runs);
  `commitments` (insert pending → `sent`/`cancelled`); `email_staff_mentions` (insert pending → `sent`);
  `system_settings` (`commitment_self_chat_id` — still written for self-chat **exclusion**, no longer a
  send target; `op_self_chat_id` is no longer re-derived since the op-line call-webhook path was removed).
  The Didi-facing reminders themselves go out over the **conversational GreenAPI instance** (not stored as
  our `messages`).

---

## 8. Config / providers (`config/env.ts`)

- **WhatsApp:** conversational GreenAPI instance: `GREENAPI_ID_INSTANCE`, `GREENAPI_API_TOKEN`,
  `GREENAPI_BASE_URL`, `GREENAPI_WEBHOOK_TOKEN` — all **optional** in `env.ts`; when blank, sends no-op
  with a warning (staged rollout guard). Scan/op creds `GREENAPI_SCAN_*` and `GREENAPI_OP_*` optional
  (features stay dormant if unset). There are no `CLIX_*` env vars — Clix is fully removed.
- **AI:** `OPENROUTER_API_KEY` required; `AI_MODEL` default `google/gemini-2.5-flash`; `AI_FALLBACK_MODEL`
  `google/gemini-3.1-pro-preview`; `COMMITMENT_AI_MODEL` `google/gemini-3.1-flash-lite`.
- **Google:** **Calendar** OAuth `GOOGLE_*` (separate client) for booking sync. **Workspace** OAuth
  `GOOGLE_WS_CLIENT_ID`/`GOOGLE_WS_CLIENT_SECRET` (single account) for Sheets + Drive + Gmail. The old
  per-staff `GOOGLE_OAUTH_*` Gmail vars are **gone**.
- **Timeless:** `TIMELESS_API_KEY`; `SUMMARY_RECIPIENT_PHONE` (owner line — the target for the post-meeting
  summary/staff-picker and the operational Didi-reminders via `notifyOwner`; also gates the
  operational-only owner number in the webhook). **Set to `972547725826` (Didi) as of 2026-06-30.**
  When unset, all owner-facing sends (op Didi-reminders + post-meeting summary/staff-picker) skip — the
  feature code is intact, only the recipient is unconfigured.
- **Department routing:** `DEPT_ELEMENTARY_PHONE` (vehicle/home/business ping target);
  `DEPT_LIFE_FINANCE_PHONE` (life_health_pension/finance ping target). Both optional; missing → no ping.
- **Zadarma:** no env vars (the webhook is unauthenticated; IP-locked to Zadarma's block in code).
  Endpoint `POST /api/zadarma/call-webhook` is ready — requires Zadarma-side setup (DID + GSM forward).
- **Leads mirror:** `LEADS_SPREADSHEET_ID`, `LEADS_SHEET_TAB`, `LEADS_SHEET_TAB_NEW`,
  `LEADS_DRIVE_FOLDER_ID`, `LEADS_MIRROR_ENABLED` — all have defaults in `env.ts`.
- **Provider toggles:** `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER` (`stub`/`live`); `STAFF_EMAIL_NOTIFY_MODE`
  (`log` default / `send`). (No `BAFI_PROVIDER` — BAFI is dropped.)
- `.env` lives on the VPS (not carried by the deploy workflow). Admin/ops endpoints use the static
  `ADMIN_API_TOKEN`.

---

## 9. Known issues / things to watch (as of 2026-07-01)

- **Client summary email has no human review gate** (§4.2) — the client receives the AI summary
  (Hebrew-normalised) directly.
- **Unmatched Timeless meetings are silent** (§4.1) — depend on the client-email-as-participant hard gate;
  recover via `GET /unmatched` + `POST /unmatched/:id/link`.
- **`sendOwnerEmail` From address.** The code sets **no `From:` header** — Gmail sends from the
  authorised Workspace mailbox (`userId:"me"` = `didi@ddins.net`, which holds the `google_ws_refresh_token`).
  That account's **primary send-as is `shaked-ins.com`**, so the From shown to recipients resolves to
  **`"דידי פרידלנדר" <didi@shaked-ins.com>`** — confirmed by a real test send (2026-06-28).
- **Conversational GreenAPI creds** (`GREENAPI_*`): when **blank**, all conversational sends no-op silently
  (no throw); when **set but the instance is unauthorized** (no number connected), sends error `502` (caught
  by callers — no crash).
- **GreenAPI PROD cutover APPLIED (2026-06-30, pre-staged — awaiting QR connect):** conversational `GREENAPI_*`
  = instance **`7107600945`**; operational `GREENAPI_OP_*` = instance **`7107600944`** (= **Didi's phone**);
  both host `https://7107.api.greenapi.com`. Settings verified live via `getSettings`: both webhooks →
  `…/api/whatsapp/webhook`; **945** token = `GREENAPI_WEBHOOK_TOKEN` (`becf48…`), incoming + outgoing-msg ON,
  calls OFF; **944** token BLANK (OK — the op short-circuit at `whatsapp.controller.ts` runs *before* the token
  gate, matched by `idInstance`), calls ON (but irrelevant — op-line webhooks are now ACK'd and dropped).
  ⚠️ **No WhatsApp number connected yet → bot OFFLINE**; outbound crons `502` harmlessly until the team
  scans the QR (**944 → Didi `972547725826`**; **945 → a separate bot line**, ≠ Didi & ≠ 944). On scan it
  goes live automatically — no restart / no `setSettings` needed.
- **`SUMMARY_RECIPIENT_PHONE` = `972547725826`** (Didi, `054-7725826`); **`REPLY_ALLOWLIST` = `972547725826`**
  — the **Didi-lock**: intake is closed to ALL clients (non-allowlisted senders get no reply); only Didi's
  `assign_staff:` taps act (owner-guard runs *before* the allowlist gate). To reopen intake to clients, blank
  `REPLY_ALLOWLIST`.
- **`STAFF_EMAIL_NOTIFY_MODE` = `send` (turned ON 2026-06-30 — go-live)** — Pillar 3 now emails **real** staff:
  the **08:00 email-mentions** cron sends each mentioned staff a reminder (subject `תזכורת ממשרד שקד`), and the
  **staff-tap handoff** emails the assigned staff (subject `הקצאת לקוח חדשה — <client>`) once the conv bot is
  connected. Both send via the Gmail WS token; the 08:00 mentions cron is **independent of WhatsApp** (runs even
  before the numbers connect). Rows flip to `sent`, so re-runs don't re-notify.
- **`team_routing` slot removed** — the 4-button team menu (`team_routing` slot) has been deleted from the
  intake state machine. Routing is driven entirely by `inquiry_type` selection (dept ping) and the `client_type`
  fork (new/old path).
- **Zadarma telephony pending (owner action required):** `POST /api/zadarma/call-webhook` is deployed and
  IP-locked. Missing steps: Zadarma KYC approval + DID number purchase (`055`, ~$3/mo) + attach to PBX +
  GSM call-forwarding on Didi's phone. Until complete no real missed-call data is recorded.
- **Auto-reply wiring (verify)** — confirm whether free-form `ai.orchestrator` auto-reply still runs after
  intake on the current inbound path (§3.2).
- **Old-client sheet routing:** `mirrorLeadToSheet` is called in `finalizeRepresentative` as well as `finalize`,
  but the function returns immediately if `client_type !== 'new'` (§10) — old-client rows are never mirrored.
  There is no `לקוח קיים` tab write despite the task description mentioning it.
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
