# Lead ID capture v2 — design

Date: 2026-10-04. Status: approved by the owner (Justin) in conversation; written up for review.

## Why

Client feedback (2026-10-04): "I don't see any ID" and "there are no new leads going into the sheet".

What the investigation found (production data, read-only):

- The strict ID check (card + ספח in ONE photo, number read from it) exists and is correct, but it runs only at the `id_photo` step of the button-8 path, which no real lead has reached since go-live. Column E (ID number) has never been filled.
- Every image a lead sends anywhere else is archived to Drive with **no check** and its link overwrites column D, so D holds Instagram screenshots, car photos and PDFs under the header "תמונת תעודת זהות", and only the last file per lead.
- Images sent while the bot is paused (24h cooldown after a thank-you, 6h after a Chatwoot reply) are discarded.
- A returning lead updates their **old** sheet row in place with the old creation date, so repeat inquiries look like nothing arrived.
- No transport or gate bug drops leads: Meta subscription active, 30/30 first contacts since 09-01 got the menu within 60 s, 193/194 bot sends delivered, no 401/429. A 60-agent code audit confirmed this and surfaced the extra items in sections E and F.

## Decisions (owner, 2026-10-04)

1. Run the ID check silently on **every** image, at any step. Do not reply or decline; if it is an ID, put the number in the sheet.
2. Save files even while the bot is paused.
3. Column D accumulates links (one per line); nothing is ever deleted. **Same column, no new columns.**
4. A **new sheet row per inquiry** when a lead comes back.
5. The Chatwoot private-note slip is human error: no change. Chatwoot attachment forwarding is a code gap but unrelated: follow-up.
6. Audit additions approved: unsupported Meta message types (E), tap-after-cooldown, photo-sent-as-file, three hardenings (F).

## Scope

In: sections A–F below, their tests, the DB column, the one-off backfill, docs.

Out (follow-ups, not in this change): Chatwoot attachment/rejected-reply feedback; the 6h takeover pause swallowing a lead's tap; a staff route for the button-8 branch; retry on sheet writes; in-flight loss on restart; emailing staff when a lead writes during the cooldown.

## A. Universal silent ID detection

**Trigger.** Any inbound `image`, or `document` whose MIME type starts with `image/`, from a linked client, at any slot **except `id_photo`** (that handler keeps its own OCR-gated flow), regardless of `bot_settings.enabled`, pause state or `intake_state='skipped'`. (Amended 2026-10-05 after the Task 5+6 review: the exception covers only an image the `id_photo` step actually took, accepted or re-asked. A document at that step, or a file sent while the step is gated, is captured like any other; before this amendment those files were lost.)

**Runs detached.** Fired with `void …catch()` so the bot reply is never delayed; never throws into the caller.

**Steps, in order.**

1. Download the bytes (Meta `mediaId` or GreenAPI `fileUrl`, as today). Download failure → warn log, stop.
2. Run `validateIdPhoto(dataUrl)` — the existing strict prompt, unchanged. An OCR error or unparsable reply counts as "not an ID"; the file is still archived.
3. Normalize the ID number with the new `normalizeIsraeliId` (section A.1). `idOk = valid photo && number passes`.
4. Upload to Drive. Name: `<OCR name> - ID.<ext>` when the photo is a valid ID and a name was read; otherwise `<displayName or phone digits> - <Israel stamp>.<ext>` as today.
5. Insert a `documents` row: `type='id_photo'` when the photo is a valid ID (even if the number was unreadable), else `type='other'`; `file_url`, `file_name`, `mime_type` as today.
6. Client update, only when the photo is a valid ID:
   - `id_photo_url = link` (newest valid ID wins).
   - `id_number = <9-digit>` only when `idOk`; otherwise leave `id_number` untouched and warn-log `intake-media: ID photo without a readable number`.
   - `id_validated` becomes `true` when `idOk`; it is never set back to `false` (a previously verified client is never downgraded).
   - `full_name = <OCR name>` when a name was read (same rule as the existing ID step).
7. `mirrorLeadToSheet(clientId)` (section C decides the row).

**PDFs and other documents** are archived (steps 1, 4, 5, 7) with no OCR.

**Logging.** One info line per capture: `{ clientId, kind, mimeType, isIdPhoto, hasIdCard, hasAppendix, idOk, fileId }`. Never log the number, the name or the image.

**Nothing is sent to the lead** by this path. The slot handler still sends whatever it sends today (menu re-prompt, email re-prompt, …).

### A.1 `normalizeIsraeliId` (shared by this path and the existing ID step)

Input: the model's `idNumber` (string or number). Strip spaces and dashes; must be 8–9 digits only; left-pad to 9; the Israeli check digit must pass (weights 1,2,1,2,…; products > 9 lose 9; sum % 10 == 0). Anything else → `null`. Replaces `normalizeIdNumber` (the foreign-ID regex left over from a June test). The existing ID step's lead-facing acceptance rule is unchanged; it simply stops storing junk numbers.

## B. Capture while paused

The capture trigger moves to the top of `handleIntake`, after the client row (`intake_state`, `intake_current_slot`) is loaded and **before** the kill-switch, pause/cooldown, `skipped` and restart checks. The `id_photo` exclusion stays. Consequence: files sent during the 24h cooldown, during a staff takeover, or while the bot is globally off are archived and linked exactly like any other file. (Amended 2026-10-05 after the Task 5+6 review: the capture runs from the inbound pipeline right after `handleIntake`, which reports `fileHandled` when the `id_photo` step took the image. Everything else is captured, so the consequence above now also holds at the `id_photo` step.)

## C. Column D accumulates

- `mirrorLeadToSheet` reads the client's `documents` rows (`file_url`, `created_at`), oldest first, and writes **D = links joined with `\n`**. E = `id_number ?? ""`. `clients.id_photo_url` is no longer the sheet source (it stays as "latest verified ID" for compatibility).
- Row gate becomes: skip only when there is no menu choice **and** no `documents` row since `intake_started_at` (the same 1-minute slack as the row matching in section D; `NULL` = `created_at`). Older files already sit on the previous inquiry's row, so a returning lead who writes anything but a menu tap after the cooldown opens no blank row; D still lists every link. (Amended 2026-10-05 after the Task 4 review.)
- Because D is rebuilt from the DB on every sync, concurrent captures can no longer overwrite each other (fixes the time-of-check race).
- Formatting: column D of the written row gets `wrapStrategy: WRAP` (best-effort, both the append and the update path) so every link is visible and clickable. Verified once on the live sheet with a test row that is then deleted.
- **Backfill:** a one-off run of `mirrorLeadToSheet` for every client with at least one `documents` row (admin trigger or VPS script), executed once after deploy. Fills the links missing today (7 leads, 14 files).

## D. New sheet row per inquiry

- DB: `ALTER TABLE clients ADD COLUMN intake_started_at timestamptz;` (+ `db/schema.sql`). Set to `now()` when the client row is created (inbound pipeline) and on every fresh restart (orchestrator). `NULL` is treated as `created_at`.
- Sheet matching (`upsertLeadRow`, new option `startedAt`): among the rows whose column-A phone matches (across the 3 tabs, normalized per F2), take the one with the **latest G** (`DD/MM/YYYY HH:mm`, Asia/Jerusalem). If that G ≥ `startedAt` minus 1 minute → update that row; otherwise, or if no row / no parsable G → **append** to the target tab. G stays set-once, so the new row carries its own date.
- Old rows are untouched, including rows a human moved to `לא רלוונטי` or `לקוח קיים`; a new inquiry always lands in the routed tab for fresh triage. The relevance mover is unaffected.
- **Tap after cooldown:** in the restart block, if the first message after the cooldown is a valid menu choice (button id or exact label), reset to slot `menu`, stamp `intake_started_at`, and process it with `handleMenu` (thank-you + `endFlow` → new row). Any other message behaves as today (welcome → menu + brand image).

## E. Unsupported Meta message types

- `extractMetaPayload` maps `audio` (voice note), `video`, `sticker`, `location`, `contacts`, and unknown/`unsupported` types to a new payload `{ kind: "other", label }` with Hebrew labels: `[הודעה קולית]`, `[וידאו]`, `[סטיקר]`, `[מיקום]`, `[איש קשר]`, `[הודעה לא נתמכת]`. `reaction` stays ignored (not a message). `request_welcome` stays ignored (out of scope). `system` (Meta's notice that the lead changed number or identity) stays ignored too: it is not a message, and handled as one it would restart a finished lead. (Amended 2026-10-05 after the final review.)
- `button` (quick reply on a template an agent sent) maps to `{ kind: "text", text: button.payload ?? button.text, isButtonReply: true, buttonTitle: button.text }`.
- Downstream: the pipeline stores the label as the message body; Chatwoot shows the label; every slot handler treats `kind: "other"` exactly like a non-text message (menu re-prompt, welcome menu, email/consent re-prompt, ID prompt). No file is archived for these types.
- One info log per such message (`type`, `wamid`) so volume can be measured.

## F. Hardenings

- **F1 Sheet tab cache.** If a Sheets write fails with HTTP 400/404, delete the cached `leads_sheet_tab_resolved:*` / `leads_sheet_gid:*` entries for the tabs involved, re-resolve, and retry once. Renaming a tab then self-heals instead of silently killing every write.
- **F2 Phone matching.** `findPhoneRow` compares canonical phones: digits only; a leading `0` with 9–10 digits becomes `972…`. Hand-typed `054…` rows now match `972…` leads instead of spawning duplicates.
- **F3 Rate limiter.** The `/api` limiter skips `/api/whatsapp/meta-webhook`, `/api/whatsapp/webhook`, `/api/chatwoot/callback/*` and `/api/zadarma/call-webhook`; each has its own authentication.

## Not changing

Chatwoot stays as is (placeholder text for files, no link). The button-8 ID step keeps its prompts and acceptance rule. No new sheet columns. No message to leads about their files.

## Testing

Unit tests first (vitest, all external calls mocked), one failing test per behaviour before the code:

- A: valid ID → `documents.type='id_photo'`, client fields, Drive name from OCR; invalid → `other`, no client ID fields; OCR throws → still archived; `document` with `image/jpeg` → OCR runs; PDF → no OCR; a previously verified client is never downgraded; an image the `id_photo` step took is not captured again, while a document there, or a file sent while the step is gated, is; a failed DB write is logged (code + message only) and never reported as archived.
- A.1: check digit (valid/invalid), 8-digit padding, dashes/spaces, JSON number input, junk → null; the existing ID step uses it.
- B: paused, bot-off and `skipped` conversations still capture.
- C: D from 2+ documents, newline-joined, oldest first; E; gate with documents but no menu choice; wrap applied.
- D: newest-row match vs `startedAt` (update), older row (append), no G (append); F2 normalization; tap after cooldown processed, free text after cooldown → menu as before; `intake_started_at` stamped on create and restart.
- E: each type → label; `button` → tap; pipeline body; Chatwoot label; each slot's reaction to `other`.
- F1: 400 → cache cleared → retry; F3: limiter skip for the listed paths.
- Existing tests whose expectation flips (e.g. "paused conversation captures nothing") are updated, not deleted.

Known: the 3 integration tests are red before this change (env bootstrap), unrelated.

Live verification after deploy (test phone, then clean up): image during cooldown → Drive + D; second image → D has two clickable lines; voice note → re-prompt + Chatwoot label; returning test number → new row with today's date; backfill fills the 7 leads above.

## Rollout

- Branch `feat/lead-id-capture-v2` from `main`; PR into `main` (the deploy workflow runs on push to `main`). Deploy only on an explicit go.
- **Order (binding): apply the `intake_started_at` DDL on the VPS before merging to `main`.** The merge is the deploy. The new code names the column in the new-client insert and the restart update, so against the old schema new leads get no reply and returning leads cannot restart. The old code ignores the column, so applying it first is safe. No `DEFAULT now()`: it would stamp every existing client and make their next sync append a duplicate row. (Amended 2026-10-05 after the Task 5+6 review; it used to say either order was safe.)
- Docs in the same change: `SYSTEM_FLOW.md` §3.1/§7/§10 (also fixing the stale "lenient" wording) and `.claude/CONVERSATIONAL_BOT.md` (unversioned, kept current by hand).
