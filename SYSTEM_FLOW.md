# SYSTEM_FLOW.md — End-to-End Behavioral Reference

> Canonical description of **how the system behaves**, re-traced from source on **2026-07-01**,
> updated **2026-07-09** for the **conversational bot v4/v4.1** redesign (9-button menu + sheet-mirror
> tab routing), and **2026-07-10** for the **CRM-sheet relevance dropdown + row mover** (§10) and the
> unanswered-WA session-model rework (§6a).
>
> **📍 The two bots each have a dedicated deep-dive doc — read those for feature-level detail:**
> - **`.claude/CONVERSATIONAL_BOT.md`** — the customer-facing WhatsApp intake bot (v4.1 state machine,
>   staff-email routing, lead mirror, control switches).
> - **`.claude/OPERATIONAL_BOT.md`** — every automation outside intake (morning digest, commitments,
>   missed-call/Zadarma capture, email staff-mentions, Timeless post-meeting pipeline, staff handoff,
>   calendar machinery, biennial), each tagged LIVE / DISABLED / DORMANT.
>
> This file stays the end-to-end map (cross-bot flow, data locations, cadences); the two docs above are
> the per-bot source of truth and are updated first when a bot changes.
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
selection added. **2026-07-09: conversational bot v4** — the linear intake is replaced by a 9-button
menu (7 insurance types → staff **email**; callback → Didi WA alert; meeting → existing/new split with
tap-only consent + lenient ID OCR); department-routing pings removed; terminals now pause 24h (cooldown,
fresh menu on return); 3h stall watcher alerts Didi; calendar booking-sync + 24h/1h reminders + Timeless
run-loops **disabled** (code kept, server.ts registrations commented out); biennial service-meeting cron
deleted (service kept dormant); lead mirror rewritten to a 7-column single-tab progressive upsert.
**v4.1 (same day, `b0da7b3`): sheet mirror tab-routed — rows appear only after a definitive menu choice
(buttons 1-8 → `לידים חדשים `; button 9 + existing → `לקוח קיים `; no flow-start phone-only rows);
appended rows auto-formatted 13pt/not-bold/white; `meeting_didi` tap + fresh-restart now clear stale
`inquiry_type`/`client_type`.**

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

### 3.1 Intake state machine (v4, 2026-07-09) — `ai/intake.orchestrator.ts`, prompts in `ai/intake.prompts.ts`

**Slot order (`SLOT_ORDER`, DB CHECK enforces exactly these six):**
`welcome → menu → meeting_type → consent → id_photo → done`.
All prompts in Hebrew, masculine-generic (Didi's style), no emojis in client messages. Gated by
`bot_settings.enabled` (singleton id=1) and the per-conversation pause (auto-resumes when
`bot_paused_until` lapses). `intake_state='skipped'` is an operator escape hatch (bot ignores the chat).

- **welcome** — no message of its own; advances to `menu` (which sends the opening), then schedules the
  **brand-image 2nd bubble** ~3–5s later (`WELCOME_IMAGE_URL`, default `<BACKEND_URL>/assets/brand.jpeg`).
- **menu** — the opening message (Didi's flowchart text verbatim,
  `"היי, הגעתם לשקד סוכנות לביטוח - דידי פרידלנדר. …אנא בחר מתפריט:"`) + **9 buttons**:
  the 7 insurance types (`vehicle`/`home`/`business`/`life_health_pension`/`travel`/`finance`/`other`)
  + `callback_didi` "מבקש שדידי יחזור אליי" + `meeting_didi` "בקשת תיאום פגישה עם דידי".
  - **Buttons 1-7** → save `inquiry_type` → **staff EMAIL** via `intake-notify.service.ts`
    (vehicle→merav@, home→hodaya@, business→giti@, life_health_pension/finance→ rivka+tzivia+ruth+yafa@
    shaked-ins.com in ONE email; **travel/other → nobody, deliberate**), gated by
    `STAFF_EMAIL_NOTIFY_MODE` (`log`=dry-run) → thank-you → `endFlow('new_lead')`.
  - **Button 8** (`callback_didi`) → `inquiry_type='callback'` → **📞 WhatsApp alert to Didi**
    (`notifyOwner` → `SUMMARY_RECIPIENT_PHONE`) → thank-you → `endFlow('new_lead')`.
  - **Button 9** (`meeting_didi`) → `inquiry_type='meeting'` → advance to `meeting_type`.
  - Free text / media → text-only re-prompt `"אנא בחר אחת מהאפשרויות בתפריט למעלה"` (nobody notified).
- **meeting_type** — buttons `existing_client` "לקוח קיים" / `new_client` "לקוח חדש".
  **Existing** → `client_type='old'` → booking-link message (`GOOGLE_CALENDAR_BOOKING_URL`) →
  `endFlow('meeting_scheduling')` — **no notification** (the calendar booking is the signal).
  **New** → `client_type='new'` → advance to `consent`, stamp `clients.consent_prompted_at`
  (starts the 3h stall clock, §3.6) and clear `stall_notified_at`.
- **consent** — single button `consent_approve` "מאשר" (data-pull consent: מסלקה פנסיונית + הר הביטוח).
  Advances **only on a real button TAP** (`payload.isButtonReply` set by `extractPayload`'s
  button-response branch); typed "מאשר" or anything else → re-prompt
  `'כדי להמשיך, יש ללחוץ על כפתור "מאשר"'`. If the buttons-send fell back to a text list, tapping is
  impossible → the stall alert is the designed safety net.
- **id_photo** — image only. `validateIdPhoto()` is **lenient**: any readable government ID passes
  (the ספח is requested in the prompt but its absence never invalidates); extracts `idNumber` +
  **`fullName` as printed on the ID**. On success: bytes fetched from the GreenAPI `downloadUrl` →
  **Google Drive** upload named `"<OCR name> - ID"` (fallback: phone digits) → `documents` row +
  `clients.id_photo_url`/`id_number`/`id_validated=true`, and `full_name` is **upgraded to the OCR
  name**. Then booking-link terminal → `endFlow('meeting_scheduling')` — **silent completion** (the
  Sheet row + Drive file are the record). Invalid/unreadable → Hebrew `{reason}` re-prompt.
- **`endFlow(pipelineStage)`** (replaces the old finalize/finalizeRepresentative) — sets
  `intake_state='completed'`, slot `done`, `intake_completed_at`, `pipeline_stage` (`new_lead` for
  buttons 1-8, `meeting_scheduling` for the button-9 terminals), mirrors the lead, and pauses the
  conversation for a **24h cooldown** (`bot_paused=true`, `bot_paused_until=now+24h`) — NOT permanent.
- **Fresh restart:** a message from a completed client after the cooldown expired (or after a manual
  unpause) resets intake (`collecting`/`welcome`, clears consent/stall/completed stamps) and re-runs
  the menu in the same call. No meetings row and no complexity classification exist anymore.

**Removed in v4:** slots `client_type`/`inquiry_type`(as a slot)/`issue`/`action_choice`/`full_name`/
`email`/`poa`; the department-routing WhatsApp ping (`department-routing.ts` deleted —
`DEPT_ELEMENTARY_PHONE`/`DEPT_LIFE_FINANCE_PHONE` env keys removed; replaced by the staff emails);
`classifyComplexity` + `classifyIntakeResponse`; the pending-booking `meetings` insert.

**Sheet mirror during intake:** `mirrorLeadToSheet(clientId)` is called on every slot advance and at
`endFlow` (see §10) — best-effort, never blocks intake.

### 3.1a Staff notify + stall watcher (v4) — `ai/intake-notify.service.ts`, `ai/intake-stall.service.ts`
- **Staff lead email:** subject `"פנייה חדשה מהבוט — <type HE>"`, Didi-style Hebrew body (greeting by
  first name, or plain `היי,` for the 4-person team; fields: insurance type, client phone in
  `05X-XXXXXXX` local format via `toLocalPhone`, WhatsApp name with `לא צוין` fallback via
  `displayName`). Sent as didi@ddins.net via `sendOwnerEmail`; **hard-gated by
  `STAFF_EMAIL_NOTIFY_MODE`** (`log` = compose to pm2 logs only).
- **Stall watcher:** every **10 min** (server.ts interval, `isPublicWebhook` only) — clients
  `collecting` at `consent`/`id_photo` with `consent_prompted_at` ≥ 3h old and `stall_notified_at`
  null → **⚠️ WhatsApp alert to Didi** (phone, WA name, stopped-at step) via `notifyOwner`, then
  `stall_notified_at` stamped (at-most-once, after the attempt).

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
- Intake terminal (`endFlow`, any branch) → **24h cooldown** (`bot_paused_until=now+24h`); after expiry
  the next message triggers a **fresh menu restart** (§3.1). Known quirk: a manual send after a terminal
  overwrites the 24h cooldown with now+1h.
- All timed pauses auto-expire via `bot_paused_until` and auto-resume. Global kill switch: `bot_settings`.
  (The 2h escalation pause is **gone** — human escalation was removed, §3.3.)

### 3.5 Booking → confirmation → reminders — **DISABLED in v4** (`calendar/booking-sync.service.ts`, `calendar/reminder.service.ts`)
Booking is still via the **Calendly link** sent at the button-9 terminals, and the booked Google
Calendar event carries the Zoom link — but the backend no longer reacts to it: the **booking-sync
(every 3 min) and 24h/1h reminder (every 10 min) run-loops are commented out in `server.ts`**
(`// v4: disabled`; services + tests kept dormant, no confirmation message is sent). The booking
simply appears in Didi's calendar. Re-enable by un-commenting the registrations.

---

## 4. Post-meeting flow (Timeless) — **DISABLED in v4** — `integrations/timeless/*`, `meetings/meeting-handoff.service.ts`

> **v4 (2026-07-09):** the Timeless run-loops are **commented out in `server.ts`** — no webhook
> re-registration at boot and no hourly poll. The HMAC-verified webhook **route stays mounted**
> (`POST /api/integrations/timeless/webhook`), so a webhook subscription that already exists on the
> Timeless side can still deliver events and trigger the ingest below. All service code is intact;
> the description below is the dormant behavior.

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

**Send transport (changed 2026-07-10):** the Didi-facing reminders (pillars 1 & 2 + the merged digest +
unanswered-WA alerts) **deliver through the dedicated NOTIFY GreenAPI instance** (`GREENAPI_NOTIFY_*`,
instance `7107677591`, free tier — only ever messages Didi) via `notifyOwnerOps(text)`
(`operations/owner-notify.ts` → `sendMessageWith(notifyCreds(), toChatId(SUMMARY_RECIPIENT_PHONE), text)`).
It returns `false` (and sends nothing) if `SUMMARY_RECIPIENT_PHONE` or the notify creds are blank, and the
"mark sent"/prune steps are gated on a `true` result. The old `notifyOwner` (conversational 945 line) now
carries ONLY the intake 📞 callback + ⚠️ stall alerts.
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
  via `notifyOwnerOps` (NOTIFY instance), but in production this section is **merged into
  the 09:00 morning digest** (§5.4). `call_events` pruned older than 48h after a successful send.

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
  07:00–21:00 Jerusalem; `date_only` (date, no time) → **09:00 on the due date**; `floating` (neither) →
  **next day 09:00** (message date + 1 day).
- **Fire.**
  - **Timed:** `fireTimedReminders` runs every **15 min** (`setInterval` in `startCommitmentCrons`). It
    cancels `timed` rows that are stale by > 2 h, then sends due rows grouped by minute as
    `"⏰ תזכורת:"` + `• <text> בשעה <HH:mm> — <contact>`, and flips them to `sent` (only after a successful
    send).
  - **Date-only / floating:** `buildMorningCommitmentSection` (status `pending`, kind in
    `date_only`/`floating`, `fire_at <= now`) is composed by the LLM into a Hebrew bullet list
    (`"בוקר טוב! התזכורות להיום:"`, fallback template on LLM failure) and **merged into the 09:00 digest**;
    the included ids are then marked `sent`.
- All commitment reminders go to **Didi via the NOTIFY instance** (`sendSelfMessage`
  wraps `notifyOwnerOps` — despite the legacy name it sends to `SUMMARY_RECIPIENT_PHONE`, not as a
  self-message on the op line).

### 5.3 Pillar 3 — Email staff-mentions — `operations/email-mentions.service.ts`
- **Scan (`scanAndStoreSentMentions`).** Lists Didi's **sent** Gmail of the last day
  (`in:sent newer_than:1d`), skips e-sign/process-completion templates (subject matches
  `חתימה מרחוק|סיום תהליך`), and for each active **agent** staff checks whether the **To/CC** contains the
  staff local-part (so both `@shaked-ins.com` and `@ddins.net` match; body matching was removed to avoid
  quoted-header false positives). Matches are inserted into `email_staff_mentions`, dedup
  `(gmail_message_id, staff_id)`.
- **Notify (`notifyStaffMentions`).** Groups pending rows per staff and composes the Hebrew reminder
  (`buildStaffReminderEmail`, new template 2026-07-10): subject `"תזכורת"`; greeting `היי <first name>`;
  ONE subject → `זוהי תזכורת למייל שקיבלת מדידי בנושא <subject>.`, SEVERAL → plural sentence + `•` bullets;
  sign-off `תודה, דידי`. **30s gap between emails in `send` mode** (none in `log`). **Delivery is gated by
  `STAFF_EMAIL_NOTIFY_MODE`** (default **`log`** = dry-run to pm2 logs, **no send**; `send` = actually
  email each staff via `sendOwnerEmail`). Rows flip to `status='sent'` either way (idempotent).
- `runStaffEmailNotify` (scan + notify) runs at **09:00** alongside the digest cron.

### 5.3b Pillar 5 — Unanswered emails (self-notification, new 2026-07-10) — `operations/unanswered-emails.service.ts`
- **Scan (`runUnansweredEmailNotify`, same 09:00 cron tick).** Lists Didi's **inbox** (`in:inbox
  newer_than:7d`) and keeps messages inside the window `[watermark, run-start)` — the watermark
  (`system_settings` key `unanswered_emails_last_run`, advanced to run-start after EVERY run, log mode
  included) makes each email appear **once only** and self-heals after downtime (floored at 7 days).
  First run falls back to the last 24h.
- **Eligibility:** must carry the `CATEGORY_PERSONAL` label (⚠️ the `category:primary` **query operator
  returns 0** on this account — tabs disabled — so filtering is client-side by `labelIds`); drops
  self-sent (`from` contains own address — also prevents the notification itself being re-flagged),
  `no-reply`/`donotreply` senders, and newsletters (`List-Unsubscribe` header). Staff mail IS included
  (owner decision). Leftover Primary bot-noise (Mislaka payroll etc.) accepted, no blocklist.
- **"Responded" check:** dedupe to one row per **thread** (latest message), then drop threads where a
  message **from Didi** exists later in the thread (`threadRepliedAfter` — reply or forward both count;
  archiving removes the mail from `in:inbox` = natural dismiss).
- **Notify:** empty list → nothing sent (watermark still advances). Otherwise ONE Hebrew email to
  **Didi himself** (`sendOwnerEmail(ownAddress …)`, address from `users.getProfile`): subject
  `מיילים שלא נענו מאתמול`, body `היי דידי — אלו המיילים מ־24 השעות האחרונות שעדיין לא הגבת עליהם:` +
  `• <subject> — מאת: <sender>` bullets (oldest first, `(ללא נושא)` fallback) + `(מייל אוטומטי מהמערכת)`.
  Gated by **`STAFF_EMAIL_NOTIFY_MODE`** (`log` = pm2 dry-run, `send` = real self-email). Self-send from
  the own account can't be spam-flagged; 1 email/day max, no pacing needed.

### 5.4 The merged 09:00 digest — `operations/morning-digest.service.ts`
`sendMorningDigest` (cron `0 9 * * *`, Asia/Jerusalem) re-scans commitments (`refreshCommitments`), builds
the **commitment morning section** and the **call-reminder section** in parallel, joins them (commitments
first, blank line, then calls) into **one** Hebrew message and sends it **to Didi via `notifyOwnerOps`**
(NOTIFY instance). If both sections are empty it returns early without sending anything.
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
scheduled jobs: `/call-reminder/run`, `/commitments/run`, `/morning-digest/run`, `/email-mentions/run`,
`/unanswered/run` (WA sweeper + follow-ups), `/unanswered-emails/run` (⚠️ advances the watermark — the
next 09:00 run then only covers mail received after the manual run), `/leads-relevance/run` (dropdown
re-apply + relevance-mover sweep, returns both result objects — §10).

### 5.6 Biennial service meetings — **REMOVED from the schedule in v4** — `calendar/service-meeting.service.ts`
**v4 (2026-07-09): the 08:10 cron block and its import were deleted from `server.ts`** (owner: "we
won't need the biennial message"). `service-meeting.service.ts` + its test are kept dormant in the
repo. The dormant behavior, for the record: `checkServiceMeetingEligibility` finds
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
localhost) so dev boots never touch live lines or prod data.

**Active after v4 (2026-07-09):**

| Job | Trigger | Cadence | Source |
|---|---|---|---|
| Commitment timed reminders | `setInterval` (`startCommitmentCrons`) | every 15 min | `commitments.reminders.ts` |
| Morning digest (commitments + calls) **and** email staff-mentions **and** unanswered-emails self-notify **and** unanswered-WA follow-ups **and** relevance-dropdown re-apply | `cron` | `0 9 * * *` Asia/Jerusalem (moved from 08:00, 2026-07-10) | `morning-digest.service.ts` + `email-mentions.service.ts` + `unanswered-emails.service.ts` + `unanswered-wa.service.ts` + `leads-relevance.service.ts` |
| **Unanswered-WA sweeper (new 2026-07-10)** | `setInterval` | every 5 min | `operations/unanswered-wa.service.ts` |
| **Leads relevance mover (new 2026-07-10)** | `setInterval` (+ one-shot `setTimeout` 30s boot dropdown-apply) | every 5 min | `integrations/google/leads-relevance.service.ts` |
| **Intake stall watcher (v4)** | `setInterval` | every 10 min | `ai/intake-stall.service.ts` |

**Disabled/removed in v4** (registrations commented out or deleted in `server.ts`; service code kept):
calendar booking-sync (was +30s / 3 min), appointment 24h/1h reminders (was 10 min), biennial
service-meeting cron (was `10 8 * * *` — **deleted**), Timeless hourly poll + webhook registration.

Note: the **call reminder** is not independently scheduled — it ships inside the 09:00 digest.

### 6a. Unanswered WA messages (new pillar 2026-07-10; session-model rework same day) — `operations/unanswered-wa.service.ts`
Watches Didi's own line (944) via its webhook (token now REQUIRED — see §9): incoming private-chat message
07:00–20:00 Israel with no reply for 1h → **LLM closer gate** (`unanswered-wa.llm.ts`: gemini-2.5-flash reads
the chat's last 4 messages with `[DD/MM HH:MM]` Israel-time labels; "תודה"-type closers resolve silently,
fail-open on error) → auto-reply from 944 as Didi (office number 026244791); anyone replying cancels;
2nd same-day episode is suppressed-but-tracked (no repeat auto-reply, still gets next-day buttons);
next day 09:00 → 2-button follow-up (`ua_ok` = silent resolve / `ua_callback` → 🔔 alert to Didi via the
NOTIFY instance); untapped buttons expire at midnight Israel (daily session reset). Caps: 1 auto-reply/chat/day,
20 auto-replies/day, 40 follow-ups/day; 20s pacing. Env `UNANSWERED_WINDOW_DISABLED` bypasses the watch window
(testing only). Table `wa_unanswered`. Full spec: `.claude/OPERATIONAL_BOT.md` §2b.

---

## 7. Data model & where everything is saved (`db/schema.sql` + filesystem/Drive)

**Tables (15):** `staff`, `clients`, `meetings`, `documents`, `audit_logs`, `conversations`, `messages`,
`bot_settings`, `system_settings`, `whatsapp_instances`, `timeless_unmatched_meetings`, `commitments`,
`call_events`, `email_staff_mentions`, `wa_unanswered` (new 2026-07-10, §6a). **No `tasks`,
`notifications`, `gmail_integrations`, or `v_client_pipeline`.**

- `clients`: `pipeline_stage`, `complexity` (dormant since v4), `id_number`, `policy_number`,
  `client_type` (`new`/`old`), `assigned_to` / `assigned_handler_id` (handler preferred),
  `last_service_date`, `last_service_reminder_at` (biennial re-arm — dormant, cron removed §5.6),
  intake columns (`intake_state`, `intake_current_slot` — **v4 CHECK allows exactly:
  `welcome`/`menu`/`meeting_type`/`consent`/`id_photo`/`done`** (migration `20260709120000_intake_v4`);
  `id_photo_url`, `poa_doc_url` (dormant), `id_validated`, `intake_completed_at`),
  **v4 stall-watcher columns `consent_prompted_at` + `stall_notified_at`** (timestamptz), and
  `mirrored_to_sheet_at` (column exists but is **not read/written by the lead-mirror code** — sheet
  idempotency is phone-based, see §10). `inquiry_type` CHECK includes the fixed button set plus **v4
  values `callback` (button 8) and `meeting` (button 9)** plus legacy keys for old rows.
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
- **Intake answers (v4)** → `clients` (`intake_state`, `intake_current_slot`, `client_type`,
  `inquiry_type` incl. `callback`/`meeting`, `consent_prompted_at`/`stall_notified_at`, `id_number`,
  `id_validated`, `full_name` upgraded to the OCR name, `pipeline_stage`, `intake_completed_at`).
  On each advance + at `endFlow` → **Google Sheet** row (every branch, single tab, §10).
- **ID photo** → **Google Drive** (anyone-with-link, `"<OCR name> - ID"`) **+** `documents` row
  (`file_url`=webViewLink) **+** `clients.id_photo_url`/`id_number`. **`endFlow`** → `clients`
  (completed, `pipeline_stage='new_lead'|'meeting_scheduling'`) **+** `conversations.bot_paused=true` /
  `bot_paused_until=now+24h`. No `meetings` insert, no POA path anymore. **Bot replies** → `messages`
  (`sent_by='bot'`). **Staff lead email** (buttons 1-7) → Gmail (or pm2 log in `log` mode); **callback/
  stall alerts** → Didi's WhatsApp (not stored as our `messages`).
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
  (features stay dormant if unset). **NEW (2026-07-10):** `GREENAPI_NOTIFY_*` (id/token/base-url) — the
  dedicated operational-notify instance (`7107677591`); blank → `notifyOwnerOps` no-ops.
  There are no `CLIX_*` env vars — Clix is fully removed.
- **AI:** `OPENROUTER_API_KEY` required; `AI_MODEL` default `google/gemini-2.5-flash`; `AI_FALLBACK_MODEL`
  `google/gemini-3.1-pro-preview`; `COMMITMENT_AI_MODEL` `google/gemini-3.1-flash-lite`.
- **Google:** **Calendar** OAuth `GOOGLE_*` (separate client) for booking sync. **Workspace** OAuth
  `GOOGLE_WS_CLIENT_ID`/`GOOGLE_WS_CLIENT_SECRET` (single account) for Sheets + Drive + Gmail. The old
  per-staff `GOOGLE_OAUTH_*` Gmail vars are **gone**.
- **Timeless:** `TIMELESS_API_KEY`; `SUMMARY_RECIPIENT_PHONE` (owner line — the target for the post-meeting
  summary/staff-picker, the operational Didi-reminders via `notifyOwnerOps` (NOTIFY instance) and the
  intake alerts via `notifyOwner` (945); also gates the
  operational-only owner number in the webhook). **Set to `972547725826` (Didi) as of 2026-06-30.**
  When unset, all owner-facing sends (op Didi-reminders + post-meeting summary/staff-picker) skip — the
  feature code is intact, only the recipient is unconfigured.
- **Department routing:** **REMOVED in v4** — `DEPT_ELEMENTARY_PHONE` / `DEPT_LIFE_FINANCE_PHONE` no
  longer exist in `env.ts` (stale lines in a VPS `.env` are ignored). Staff routing is now by email
  (§3.1a), gated by `STAFF_EMAIL_NOTIFY_MODE`.
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
  calls OFF; ⚠️ **944 token was verified BLANK — this is now BROKEN by the 2026-07-10 rework**: the token
  gate runs *before* the op-instance routing, so 944 events are dropped until the console sets 944's webhook
  token = `GREENAPI_WEBHOOK_TOKEN` + incoming AND outgoing notifications ON (required for unanswered-WA, §6a).
  ⚠️ **No WhatsApp number connected yet → bot OFFLINE**; outbound crons `502` harmlessly until the team
  scans the QR (**944 → Didi `972547725826`**; **945 → a separate bot line**, ≠ Didi & ≠ 944). On scan it
  goes live automatically — no restart / no `setSettings` needed.
- **Env is at FULL go-live values (since 2026-07-10 evening):** `REPLY_ALLOWLIST=` blank → intake **open
  to everyone**; `SUMMARY_RECIPIENT_PHONE=972547725826` (real Didi); **`STAFF_EMAIL_NOTIFY_MODE=send`** —
  all four gated email paths (intake staff notify §3.1a, mention reminders §5.3, unanswered-emails
  self-notify §5.4, meeting-handoff) send REAL emails now. The only remaining go-live steps are physical:
  QR-scan the three instances (944 → Didi's real phone, 945 → bot line, 7591 → notify; **clear each
  instance's message queue immediately before its scan** — queues refill from the daily crons) and the
  Zadarma telephony setup below.
- **v4 removed the department pings and the old slots** — routing is the 9-button menu (§3.1); the
  `client_type` fork survives only inside the button-9 meeting flow.
- **Zadarma telephony pending (owner action required):** `POST /api/zadarma/call-webhook` is deployed and
  IP-locked. Missing steps: Zadarma KYC approval + DID number purchase (`055`, ~$3/mo) + attach to PBX +
  GSM call-forwarding on Didi's phone. Until complete no real missed-call data is recorded.
- **Auto-reply wiring (verify)** — confirm whether free-form `ai.orchestrator` auto-reply still runs after
  intake on the current inbound path (§3.2).
- **Timeless webhook route still mounted** (§4) — the run-loops are disabled, but a webhook subscription
  that already exists on the Timeless side can still deliver events; with a test DB the ingest parks
  unmatched (nothing sent), but be aware the client-summary email path inside it is NOT gated by
  `STAFF_EMAIL_NOTIFY_MODE`.
- **PII:** intake ID documents live in Google Drive as **anyone-with-link** (deliberate); the links
  sit in the CRM sheet (§10).

---

## 10. Lead mirror → Google Sheets + Drive (single Google Workspace account)

**Single-account Google OAuth** (`GOOGLE_WS_*`, separate from the Calendar `GOOGLE_*` client): one agency
Workspace account, scopes `spreadsheets` + `drive.file` + `gmail.readonly` + `gmail.send` (no calendar).
Refresh token in `system_settings.google_ws_refresh_token`. Routes
`GET /api/integrations/google/{authorize,callback,status}` (public OAuth browser flow); shared helper
`getAuthenticatedClient()` in `integrations/google/google.auth.ts`. This account also powers
`sendOwnerEmail` (the client-summary and staff-mention emails) and the Gmail sent-mail scan.

**During intake (the Drive upload path in §3.1, v4):**
- **ID photo** (only after the lenient OCR passes) is uploaded to Drive folder `LEADS_DRIVE_FOLDER_ID`
  as `"<OCR name> - ID"` (fallback: phone digits), set **anyone-with-link** reader. The Drive
  `webViewLink` is stored in `clients.id_photo_url` **and** `documents.file_url`. On Drive/fetch
  failure the bot re-prompts a resend (no data loss). The POA upload path is gone with the `poa` slot.

**Lead row mirror — `mirrorLeadToSheet(clientId)`** (v4 rewrite; called on each slot advance + at
`endFlow`, EVERY branch, best-effort, never blocks intake):
- **Tab routing (v4.1):** buttons 1-8 + callback → **`לידים חדשים `** (`LEADS_SHEET_TAB_NEW`, trailing
  space, sheetId 0); button-9 meeting + existing client → **`לקוח קיים `** (`LEADS_SHEET_TAB_EXISTING`).
  The bot never *appends* to `לא רלוונטי` (`LEADS_SHEET_TAB_IRRELEVANT`, new env 2026-07-10) — rows only
  arrive there via the relevance mover below. Tab titles resolved against live metadata (trim-match) and
  cached in `system_settings.leads_sheet_tab_resolved:<tab>` (+ `leads_sheet_gid:<title>` for sheetIds).
- **7 columns A→G:** phone · name (`displayName` — blank if the WA name is just the phone) · inquiry
  type (1-7 → Hebrew via `INQUIRY_TYPE_HE`; `callback` → `בקשת שיחה חוזרת`; `meeting` →
  `תיאום פגישה — לקוח קיים/חדש` per `client_type`; `general` → blank) · ID-photo Drive URL · ID number ·
  רלוונטיות (**human-owned dropdown**, bot writes blank — see mover below) · creation date
  `DD/MM/YYYY HH:mm` Asia/Jerusalem. **Set-once columns `[5, 6]`** (2026-07-10, was `[6]`): a
  manually-picked relevance value AND the creation date survive every re-mirror.
- **Idempotency is phone-based across ALL 3 tabs** (2026-07-10): `upsertLeadRow` batch-reads column A of
  `[target, new, existing, irrelevant]` (deduped by trim, target first) and updates the row **in the tab
  where it lives** — a returning lead you already triaged into `לקוח קיים`/`לא רלוונטי` is updated in
  place there, never duplicated into new-leads. Appends to the target tab only when the phone is found
  nowhere. All same-process sheet writers are serialized by `withSheetLock` (`sheets-lock.ts`). (The
  `clients.mirrored_to_sheet_at` column is **not** used by this code.)
- One-time restructure script (7 headers on all 3 tabs + test-row wipe):
  `scripts/oneoff/restructure-crm-sheet.mjs` (run on the VPS).

**Relevance dropdown + row mover — `leads-relevance.service.ts` (new 2026-07-10, `bc3f0b8`; all legs
live-tested same day):**
- **Dropdown:** `applyRelevanceDropdowns()` sets a `ONE_OF_LIST` data-validation rule (strict +
  `showCustomUi`) on **F2:F unbounded** of all 3 tabs, values = the 3 **trimmed** tab names. Idempotent;
  runs at boot (+30s), inside the 09:00 cron bundle (heals rows appended into fresh tabs, which inherit
  validation from the row above), and via the manual trigger. Blank cells are always allowed — the bot
  keeps writing `""` and a human picks later.
- **Mover:** `sweepRelevanceMoves()` every **5 min** (≈288 batched reads/day vs the 300-reads/**min**
  Sheets quota). One `values.batchGet` of `A2:G` across the 3 tabs, then per row: `trim(F)` empty →
  ignored; not a known tab name → ignored; equals the current tab → stable no-op; phone AND name both
  empty → ignored (stray dropdown pick on an empty row); otherwise the row **moves** to the tab F names —
  **symmetric across all 3 tabs** (a `לא רלוונטי` row can be resurrected by picking `לידים חדשים`).
  Move = append the full 7-value row to the destination (**F kept as picked** → self-stable) + one
  descending-sorted `deleteDimension` batch per source tab. Counters
  `{scanned, moved, ignoredEmpty, ignoredInvalid, errors}`; re-entrancy-guarded, never throws, holds
  `withSheetLock` for the whole scan→move so it can't race the intake mirror.
- Manual: `POST /api/operations/leads-relevance/run` (§5.5) — dropdown re-apply + immediate sweep.

**Modules:** `integrations/google/{google.auth,google.gmail,google.drive,google.sheets,leads-mirror.service,leads-relevance.service,sheets-lock}.ts`.
