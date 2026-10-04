# Lead ID Capture v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every image a lead sends is silently checked for an Israeli ID card + ספח, every file is archived to Drive and listed in the CRM sheet (even while the bot is paused), returning leads get a fresh sheet row, and unsupported WhatsApp message types stop vanishing.

**Architecture:** The file capture moves out of the intake state machine into the inbound pipeline (`captureLeadFile`, detached), where it runs the existing strict `validateIdPhoto` on images and records a `documents` row per file. The sheet mirror rebuilds column D from `documents` on every sync and decides "update newest row vs append" by comparing the row's creation date with the client's new `intake_started_at`. A new `kind: "other"` payload carries voice notes/video/etc. through the normal re-prompt path.

**Tech Stack:** Node 20 ESM, TypeScript strict, Express 5, Postgres via the `supabaseAdmin` shim (`Server/src/lib/db.ts`), googleapis (Sheets v4 / Drive v3), OpenRouter vision via `validateIdPhoto`, Vitest.

Spec: `docs/superpowers/specs/2026-10-04-lead-id-capture-v2-design.md`.

## Global Constraints

- Work inside `Server/`. Run commands from `Server/` (e.g. `cd Server && npx vitest run <file>`).
- ESM: relative imports end in `.js`. TypeScript strict; `noUncheckedIndexedAccess` is on (`arr[i]!` where the index is known-valid).
- DB access only via `supabaseAdmin` from `../../config/supabase.js` (shim methods used here: `from/select/eq/insert/update/delete/like/order/maybeSingle`). Never create a pg client.
- `env` from `config/env.js`, `logger` from `config/logger.js`; never `process.env` or `console`.
- No new env keys. No new sheet columns. No new lead-facing copy (the only new client-visible strings are the Chatwoot/DB placeholders in Task 2).
- Never log an ID number, a name read from an ID, or image bytes.
- Tests are colocated `*.test.ts`, Vitest, all externals mocked; follow the builder-shim helpers already in each test file.
- Baseline before this plan: `npm run typecheck` clean; `npx vitest run` → 710 passed, 3 **pre-existing** failing files (`src/__tests__/integration/*` — env bootstrap; ignore them).
- Branch `feat/lead-id-capture-v2` (already created). One commit per task. Every commit message ends with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push to `main`.
- Do not deploy, do not touch the VPS, do not run anything against the live sheet. The rollout section at the end is executed manually by the owner.

---

## File map

| File | Change |
|---|---|
| `Server/src/domains/ai/israeli-id.ts` (new) | `normalizeIsraeliId` — digits, 8–9 long, pad to 9, check digit |
| `Server/src/domains/ai/ai.service.ts` | use `normalizeIsraeliId`; drop the foreign-ID regex |
| `Server/src/domains/whatsapp/whatsapp.validator.ts` | `MessagePayload` gains `kind: "other"` |
| `Server/src/domains/whatsapp/meta/meta.validator.ts` | map audio/video/sticker/location/contacts/unknown → `other`; `button` → tap |
| `Server/src/domains/whatsapp/meta/meta.webhook.controller.ts` | info log for `other` |
| `Server/src/domains/whatsapp/inbound.pipeline.ts` | body for `other`; stamp `intake_started_at`; call `captureLeadFile` |
| `Server/src/domains/whatsapp/transport.resolve.ts` | Chatwoot label for `other` |
| `Server/src/domains/ai/intake-media.ts` | `captureIntakeDocument` → `captureLeadFile` with OCR, checked DB writes, no pointer update (the pipeline skips only an image the `id_photo` step took) |
| `Server/src/domains/ai/intake.orchestrator.ts` | remove capture call; restart stamps `intake_started_at`; tap-after-cooldown |
| `Server/src/domains/integrations/google/google.sheets.ts` | canonical phone, newest-row-by-G + `startedAt`, D wrap, cache invalidation + retry |
| `Server/src/domains/integrations/google/leads-mirror.service.ts` | D from `documents`, `startedAt`, `backfillLeadDocuments` |
| `Server/src/domains/operations/operations.controller.ts` + `operations.routes.ts` | `POST /api/operations/leads-backfill/run` |
| `Server/src/middleware/rate-limit-exempt.ts` (new) + `Server/src/server.ts` | limiter skip list incl. Chatwoot + Zadarma |
| `supabase/migrations/20261004120000_clients_intake_started_at.sql` (new) + `db/schema.sql` | `clients.intake_started_at timestamptz` |
| `SYSTEM_FLOW.md`, `.claude/CONVERSATIONAL_BOT.md` | docs |

Task order matters: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Tasks 1, 2, 3, 7, 8 touch disjoint files and may run in parallel; 4 depends on 3; 5 depends on 1 and 2; 6 depends on 5; 9 depends on 4.

---

### Task 1: Israeli ID normalizer (spec A.1)

**Files:**
- Create: `Server/src/domains/ai/israeli-id.ts`
- Create: `Server/src/domains/ai/israeli-id.test.ts`
- Modify: `Server/src/domains/ai/ai.service.ts:69-77` (delete `ID_PLAUSIBLE_RE` + `normalizeIdNumber`), `:112-128` (use the new normalizer)
- Modify: `Server/src/domains/ai/ai.service.test.ts:63-143` (rewrite the normalization block) and every test file containing the invalid sample id `123456789`

**Interfaces:**
- Produces: `export function normalizeIsraeliId(raw: unknown): string | null` — returns the 9-digit canonical id or `null`. `validateIdPhoto(...).idNumber` is now always a 9-digit string or `null`.

- [ ] **Step 1: Write the failing test**

Create `Server/src/domains/ai/israeli-id.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeIsraeliId } from "./israeli-id.js";

// Check digit: weights 1,2,1,2,…; a product above 9 loses 9; the sum must divide by 10.
// 123456782 → 1+4+3+8+5+3+7+7+2 = 40 ✓   123456789 → 47 ✗   012345674 → 30 ✓
describe("normalizeIsraeliId", () => {
  it("accepts a valid 9-digit ת\"ז", () => {
    expect(normalizeIsraeliId("123456782")).toBe("123456782");
  });

  it("left-pads a valid 8-digit ת\"ז to 9 digits", () => {
    expect(normalizeIsraeliId("12345674")).toBe("012345674");
  });

  it("keeps leading zeros", () => {
    expect(normalizeIsraeliId("000000018")).toBe("000000018");
  });

  it("strips spaces and dashes before checking", () => {
    expect(normalizeIsraeliId("12-345 6782")).toBe("123456782");
  });

  it("accepts a JSON number", () => {
    expect(normalizeIsraeliId(123456782)).toBe("123456782");
  });

  it("rejects a failing check digit", () => {
    expect(normalizeIsraeliId("123456789")).toBeNull();
  });

  it("rejects letters (foreign ids are not Israeli ת\"ז)", () => {
    expect(normalizeIsraeliId("A01-2345678")).toBeNull();
  });

  it("rejects a date-looking value", () => {
    expect(normalizeIsraeliId("01-01-1990")).toBeNull();
  });

  it("rejects too short and too long", () => {
    expect(normalizeIsraeliId("1234567")).toBeNull();
    expect(normalizeIsraeliId("1234567890")).toBeNull();
  });

  it("rejects null, undefined and objects", () => {
    expect(normalizeIsraeliId(null)).toBeNull();
    expect(normalizeIsraeliId(undefined)).toBeNull();
    expect(normalizeIsraeliId({})).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd Server && npx vitest run src/domains/ai/israeli-id.test.ts`
Expected: FAIL — `Cannot find module './israeli-id.js'`.

- [ ] **Step 3: Implement the normalizer**

Create `Server/src/domains/ai/israeli-id.ts`:

```ts
const WEIGHTS = [1, 2, 1, 2, 1, 2, 1, 2, 1];

/**
 * Israeli תעודת זהות: digits only (spaces/dashes tolerated), 8–9 long, left-padded
 * to 9, and the check digit must pass. Everything else — including foreign ids the
 * vision model might read — is null, so column E never holds a non-ת"ז value.
 */
export function normalizeIsraeliId(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/[\s-]/g, "");
  if (!/^\d{8,9}$/.test(digits)) return null;

  const padded = digits.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const product = Number(padded[i]) * WEIGHTS[i]!;
    sum += product > 9 ? product - 9 : product;
  }
  return sum % 10 === 0 ? padded : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd Server && npx vitest run src/domains/ai/israeli-id.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Wire it into `validateIdPhoto`**

In `Server/src/domains/ai/ai.service.ts`:

Add the import under the existing imports:

```ts
import { normalizeIsraeliId } from "./israeli-id.js";
```

Delete lines 69–77 (`const ID_PLAUSIBLE_RE = ...` through the closing `}` of `normalizeIdNumber`).

Replace the parse block inside `validateIdPhoto` (the `const parsed = JSON.parse(cleaned) as {...}` through `const idNumber = ...` lines) with:

```ts
    const parsed = JSON.parse(cleaned) as {
      hasIdCard?: boolean;
      hasAppendix?: boolean;
      idNumber?: string | number | null;
      fullName?: string | null;
    };
    const hasIdCard = parsed.hasIdCard === true;
    const hasAppendix = parsed.hasAppendix === true;
    const idNumber = normalizeIsraeliId(parsed.idNumber);
```

Everything else in the function stays as is.

- [ ] **Step 6: Update the existing tests that used the invalid sample id**

Replace the whole `describe("validateIdPhoto — idNumber extraction and normalization", ...)` block (`ai.service.test.ts` lines 63–143) with:

```ts
describe("validateIdPhoto — idNumber extraction and normalization", () => {
  it("accepts a valid 9-digit Israeli ת\"ז", async () => {
    mockLLMResponse("123456782");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("123456782");
    expect(result.valid).toBe(true);
  });

  it("left-pads a valid 8-digit ת\"ז to 9 digits", async () => {
    mockLLMResponse("12345674");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("012345674");
  });

  it("strips spaces and dashes the model may insert between groups", async () => {
    mockLLMResponse("12-345 6782");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("123456782");
  });

  it("accepts the number when the model returns it as a JSON number", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion(JSON.stringify({ hasIdCard: true, hasAppendix: true, idNumber: 123456782 })),
    );
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBe("123456782");
  });

  it("rejects a foreign alphanumeric id → null (photo itself still valid)", async () => {
    mockLLMResponse("A01-2345678");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBeNull();
    expect(result.valid).toBe(true);
  });

  it("rejects a number that fails the ת\"ז check digit → null", async () => {
    mockLLMResponse("123456780");
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBeNull();
  });

  it("returns null when model returns null for idNumber", async () => {
    mockLLMResponse(null);
    const result = await validateIdPhoto("https://example.com/id.jpg");
    expect(result.idNumber).toBeNull();
  });
```

(Keep the `it("derives valid:false when hasAppendix is false", ...)` test and everything after it unchanged — it was already inside this describe; make sure the describe's closing `});` still follows those remaining tests.)

Then replace the invalid sample everywhere it is used as a pass-through value:

Run: `cd Server && grep -rl "123456789" src --include=*.test.ts`
Expected files: `src/domains/ai/ai.service.test.ts`, `src/domains/ai/intake.orchestrator.test.ts`, `src/domains/integrations/google/leads-mirror.test.ts`, `src/__tests__/integration/intake.integration.test.ts`.

Run: `cd Server && sed -i 's/123456789/123456782/g' src/domains/ai/ai.service.test.ts src/domains/ai/intake.orchestrator.test.ts src/domains/integrations/google/leads-mirror.test.ts src/__tests__/integration/intake.integration.test.ts`

- [ ] **Step 7: Run the affected tests**

Run: `cd Server && npx vitest run src/domains/ai/ai.service.test.ts src/domains/ai/israeli-id.test.ts src/domains/ai/intake.orchestrator.test.ts src/domains/integrations/google/leads-mirror.test.ts && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add Server/src/domains/ai/israeli-id.ts Server/src/domains/ai/israeli-id.test.ts Server/src/domains/ai/ai.service.ts Server/src/domains/ai/ai.service.test.ts Server/src/domains/ai/intake.orchestrator.test.ts Server/src/domains/integrations/google/leads-mirror.test.ts Server/src/__tests__/integration/intake.integration.test.ts
git commit -m "feat(intake): validate the OCR'd ID number as an Israeli ת\"ז (check digit, 9 digits)

The number read from the ID photo was only format-checked with a foreign-id
regex left over from a June test, so dates and passport-style strings could
land in the sheet. Now only an 8-9 digit number with a valid check digit is
kept; anything else leaves the ID-number column blank.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Unsupported Meta message types become `kind: "other"` (spec E)

**Files:**
- Modify: `Server/src/domains/whatsapp/whatsapp.validator.ts:105-116`
- Modify: `Server/src/domains/whatsapp/meta/meta.validator.ts:9-42` (schema) and `:124-161` (`extractMetaPayload`)
- Modify: `Server/src/domains/whatsapp/meta/meta.webhook.controller.ts:57-62`
- Modify: `Server/src/domains/whatsapp/inbound.pipeline.ts:28-34`
- Modify: `Server/src/domains/whatsapp/transport.resolve.ts:144-148`
- Modify: `Server/src/domains/ai/intake-media.ts:11-12`
- Test: `Server/src/domains/whatsapp/meta/meta.validator.test.ts`, `meta.webhook.controller.test.ts`, `Server/src/domains/whatsapp/inbound.pipeline.test.ts`, `transport.resolve.test.ts`, `Server/src/domains/ai/intake.orchestrator.test.ts`

**Interfaces:**
- Produces: `MessagePayload` union member `{ kind: "other"; subtype: string; label: string }`. Every existing `payload.kind !== "text"` check in the orchestrator treats it as non-text (re-prompt); the capture ignores it.

- [ ] **Step 1: Write the failing validator tests**

In `Server/src/domains/whatsapp/meta/meta.validator.test.ts`, replace the three tests `sticker → null`, `unsupported → null`, `unknown type → null` (lines 103–113) with:

```ts
  it("sticker → kind:other with the sticker label", () => {
    expect(extractMetaPayload(msg({ type: "sticker" }))).toEqual({
      kind: "other",
      subtype: "sticker",
      label: "[סטיקר]",
    });
  });

  it("voice note (audio) → kind:other with the voice label", () => {
    expect(extractMetaPayload(msg({ type: "audio", audio: { id: "m1", voice: true } }))).toEqual({
      kind: "other",
      subtype: "audio",
      label: "[הודעה קולית]",
    });
  });

  it("video / location / contacts → their labels", () => {
    expect(extractMetaPayload(msg({ type: "video" }))).toMatchObject({ kind: "other", label: "[וידאו]" });
    expect(extractMetaPayload(msg({ type: "location" }))).toMatchObject({ kind: "other", label: "[מיקום]" });
    expect(extractMetaPayload(msg({ type: "contacts" }))).toMatchObject({ kind: "other", label: "[איש קשר]" });
  });

  it("unsupported and unknown types → the generic label", () => {
    expect(extractMetaPayload(msg({ type: "unsupported" }))).toEqual({
      kind: "other",
      subtype: "unsupported",
      label: "[הודעה לא נתמכת]",
    });
    expect(extractMetaPayload(msg({ type: "order" }))).toMatchObject({ kind: "other", subtype: "order" });
  });

  it("request_welcome → null (an 'opened the chat' event, not a message)", () => {
    expect(extractMetaPayload(msg({ type: "request_welcome" }))).toBeNull();
  });

  it("template quick-reply (type button) → a button tap with the payload as id", () => {
    expect(
      extractMetaPayload(msg({ type: "button", button: { payload: "callback_didi", text: "אשמח שדידי יחזור אליי" } })),
    ).toEqual({ kind: "text", text: "callback_didi", isButtonReply: true, buttonTitle: "אשמח שדידי יחזור אליי" });
  });

  it("template quick-reply without payload falls back to the visible text", () => {
    expect(extractMetaPayload(msg({ type: "button", button: { text: "מאשר" } }))).toEqual({
      kind: "text",
      text: "מאשר",
      isButtonReply: true,
      buttonTitle: "מאשר",
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd Server && npx vitest run src/domains/whatsapp/meta/meta.validator.test.ts`
Expected: the new tests FAIL (received `null`), the rest PASS.

- [ ] **Step 3: Extend the payload union**

In `Server/src/domains/whatsapp/whatsapp.validator.ts` replace lines 105–116 with:

```ts
export type MessagePayload =
  | { kind: "text"; text: string; isButtonReply?: true; buttonTitle?: string }
  | {
      kind: "image" | "document";
      // GreenAPI delivers a remote download URL; Meta delivers a media id.
      // Exactly one of the two is set.
      fileUrl?: string;
      mediaId?: string;
      mimeType?: string;
      fileName?: string;
      caption?: string;
    }
  // Message types the bot cannot act on (voice notes, video, stickers, locations,
  // contact cards, anything Meta adds later). Carried through so the lead still
  // gets a reply, staff still see a placeholder, and the volume can be measured.
  | { kind: "other"; subtype: string; label: string };
```

- [ ] **Step 4: Map the types in the Meta validator**

In `Server/src/domains/whatsapp/meta/meta.validator.ts`:

Add to `metaMessageSchema` (after the `document` field, before `.passthrough()`):

```ts
    button: z
      .object({ payload: z.string().optional(), text: z.string().optional() })
      .passthrough()
      .optional(),
```

Add above `extractMetaPayload`:

```ts
const OTHER_LABELS: Record<string, string> = {
  audio: "[הודעה קולית]",
  video: "[וידאו]",
  sticker: "[סטיקר]",
  location: "[מיקום]",
  contacts: "[איש קשר]",
};
const UNSUPPORTED_LABEL = "[הודעה לא נתמכת]";

// Not messages: a reaction edits an earlier message; request_welcome fires when a
// lead merely opens the chat from an ad.
const IGNORED_TYPES = new Set(["reaction", "request_welcome"]);
```

Replace the final `return null;` of `extractMetaPayload` (and update its doc comment) with:

```ts
  // Quick-reply button on a TEMPLATE an agent sent (different shape from interactive).
  if (msg.type === "button" && msg.button) {
    const id = msg.button.payload ?? msg.button.text;
    if (!id) return null;
    return { kind: "text", text: id, isButtonReply: true, buttonTitle: msg.button.text };
  }

  if (IGNORED_TYPES.has(msg.type)) return null;

  return { kind: "other", subtype: msg.type, label: OTHER_LABELS[msg.type] ?? UNSUPPORTED_LABEL };
```

Doc comment on `extractMetaPayload` becomes: `Normalise a Meta inbound message into the shared MessagePayload union. Returns null only for reaction / request_welcome (not messages) and an interactive without a reply.`

- [ ] **Step 5: Run the validator tests**

Run: `cd Server && npx vitest run src/domains/whatsapp/meta/meta.validator.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing downstream tests**

`Server/src/domains/whatsapp/transport.resolve.test.ts` — add inside `describe("mirrorInboundHook")`:

```ts
  it("mirrors the placeholder label for unsupported message types", async () => {
    await mirrorInboundHook("972500000000@c.us", { kind: "other", subtype: "audio", label: "[הודעה קולית]" });

    expect(mockMirrorInbound).toHaveBeenCalledWith("972500000000@c.us", "[הודעה קולית]", undefined);
  });
```

`Server/src/domains/whatsapp/inbound.pipeline.test.ts` — add a new describe at the end of the file:

```ts
// ---------------------------------------------------------------------------
// Unsupported message types — stored with their placeholder label
// ---------------------------------------------------------------------------

describe("processInboundCustomerMessage — kind:other", () => {
  it("stores the placeholder label as the message body and still runs intake", async () => {
    const msgBuilder = makeBuilder({ data: { id: "msg1" }, error: null });
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      msgBuilder,
      makeBuilder({ data: { id: "conv1", client_id: "client-1" }, error: null }),
    ]);

    const payload: MessagePayload = { kind: "other", subtype: "audio", label: "[הודעה קולית]" };
    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, payload, "meta"));

    const inserted = (msgBuilder["insert"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { body: string };
    expect(inserted.body).toBe("[הודעה קולית]");
    expect(mockHandleIntake).toHaveBeenCalledWith("conv1", "client-1", LEAD_CHAT_ID, payload);
  });
});
```

`Server/src/domains/whatsapp/meta/meta.webhook.controller.test.ts` — add next to the `reaction messages are skipped` test:

```ts
  it("a voice note is processed with the placeholder payload (not dropped)", async () => {
    const body = inboundEnvelope([
      { from: "972500000000", id: "wamid.V1", type: "audio", audio: { id: "m1", mime_type: "audio/ogg", voice: true } },
    ]);
    const req = makePostReq(body);
    const res = makeRes();

    metaWebhookController.handleWebhook(req, res);
    await flushImmediates();

    expect(mockProcessInbound).toHaveBeenCalledOnce();
    expect(mockProcessInbound.mock.calls[0]![0]).toMatchObject({
      messageId: "wamid.V1",
      payload: { kind: "other", subtype: "audio", label: "[הודעה קולית]" },
    });
  });
```

`Server/src/domains/ai/intake.orchestrator.test.ts` — add inside `describe("menu slot — free-text / image re-prompt")`:

```ts
  it("voice note at menu → same re-prompt as any non-text message", async () => {
    setupFrom([makeBuilder(BOT_ENABLED), makeBuilder(CONV_ACTIVE), makeBuilder(clientState("menu")), makeBuilder({ data: null, error: null })]);

    const result = await handleIntake("conv1", "client1", "chat1@c.us", { kind: "other", subtype: "audio", label: "[הודעה קולית]" });

    expect(result.consumed).toBe(true);
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe("אנא בחר אחת מהאפשרויות בתפריט למעלה");
  });
```

- [ ] **Step 7: Run them to verify they fail**

Run: `cd Server && npx vitest run src/domains/whatsapp/transport.resolve.test.ts src/domains/whatsapp/inbound.pipeline.test.ts src/domains/whatsapp/meta/meta.webhook.controller.test.ts src/domains/ai/intake.orchestrator.test.ts`
Expected: the four new tests FAIL (TypeScript narrowing errors or wrong body/label); the orchestrator one may already pass — that is fine.

- [ ] **Step 8: Implement the downstream handling**

`Server/src/domains/whatsapp/inbound.pipeline.ts` lines 28–34 become:

```ts
  // Derive the body to store in messages table. "other" is tested first: TypeScript
  // cannot narrow the shared image|document member through two separate === checks.
  const messageBody =
    payload.kind === "text"
      ? payload.text
      : payload.kind === "other"
        ? payload.label
        : payload.kind === "image"
          ? payload.caption ?? "[image]"
          : payload.caption ?? "[document]";
```

`Server/src/domains/whatsapp/transport.resolve.ts` lines 144–148 become:

```ts
function inboundMirrorText(payload: MessagePayload): string | null {
  if (payload.kind === "text") return payload.buttonTitle ?? payload.text;
  if (payload.kind === "other") return payload.label;
  const label = payload.kind === "image" ? "[תמונה]" : "[מסמך]";
  return payload.caption ? `${label}\n${payload.caption}` : label;
}
```

`Server/src/domains/ai/intake-media.ts` line 12 becomes:

```ts
  if (payload.kind !== "image" && payload.kind !== "document") return null;
```

`Server/src/domains/whatsapp/meta/meta.webhook.controller.ts` — inside the `for (const msg of value.messages ?? [])` loop, right after the `if (!payload) { ... continue; }` block:

```ts
    if (payload.kind === "other") {
      logger.info({ type: msg.type, wamid: msg.id }, "Meta message type not supported by the bot — carried as a placeholder");
    }
```

- [ ] **Step 9: Run the tests and typecheck**

Run: `cd Server && npx vitest run src/domains/whatsapp src/domains/ai/intake.orchestrator.test.ts src/domains/ai/intake-media.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (the `kind` switches above are the only places the union is narrowed — the grep `payload.kind` in `src` confirms it).

- [ ] **Step 10: Commit**

```bash
git add Server/src/domains/whatsapp Server/src/domains/ai/intake-media.ts Server/src/domains/ai/intake.orchestrator.test.ts
git commit -m "feat(whatsapp): carry voice notes, video, stickers, locations and template taps through the bot

Meta messages of any type other than text/interactive/image/document were
dropped before the pipeline: no DB row, no Chatwoot placeholder, no reply, and
only a debug log. A lead whose first contact was a voice note got nothing and
nobody knew. They now arrive as kind:other with a Hebrew placeholder, get the
normal re-prompt, show up in Chatwoot, and are counted in the logs. Template
quick-reply taps are treated as button taps.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Sheet layer — canonical phones, newest-row matching, D wrap, cache self-heal (spec C/D/F1/F2)

**Files:**
- Modify: `Server/src/domains/integrations/google/google.sheets.ts` (`formatDataRow` :142-184, `findPhoneRow` :263-278, `upsertLeadRow`/`upsertLeadRowLocked` :280-386)
- Test: `Server/src/domains/integrations/google/google.sheets.test.ts`

**Interfaces:**
- Produces: `upsertLeadRow(values: string[], tabTitle?: string, opts?: { setOnceColumns?: number[]; startedAt?: Date }): Promise<boolean>` — with `startedAt`, updates the phone's newest row (by column G) only if that row was created at or after `startedAt - 60s`; otherwise appends. `export function canonicalPhone(raw): string`. `export function israelKey(date: Date): string` (`YYYYMMDDHHmm` in Asia/Jerusalem).

- [ ] **Step 1: Write the failing tests**

In `google.sheets.test.ts`:

1. Extend the fake settings store (inside `createSettingsStore`, after the `upsert` definition) so the cache-invalidation path can be observed:

```ts
    builder["delete"] = vi.fn().mockReturnValue(builder);
    builder["like"] = vi.fn((_col: string, pattern: string) => {
      const prefix = pattern.replace(/%$/, "");
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
      return builder;
    });
```

2. Update the two formatting assertions that count requests: in `appendLeadRow triggers exactly one repeatCell batchUpdate on the parsed row` change `expect(requests).toHaveLength(2);` to `expect(requests).toHaveLength(3);` and widen the `requests` tuple type with a third element `{ repeatCell: { range: { startColumnIndex: number; endColumnIndex: number }; cell: { userEnteredFormat: { wrapStrategy: string } }; fields: string } }`, then append:

```ts
    const wrap = requests[2].repeatCell;
    expect(wrap.range.startColumnIndex).toBe(3);
    expect(wrap.range.endColumnIndex).toBe(4);
    expect(wrap.cell.userEnteredFormat.wrapStrategy).toBe("WRAP");
    expect(wrap.fields).toBe("userEnteredFormat.wrapStrategy");
```

   In `upsertLeadRow append branch also triggers the repeatCell batchUpdate` change `toHaveLength(2)` to `toHaveLength(3)`.

3. Add new describes at the end of the file:

```ts
// ---------------------------------------------------------------------------
// New row per inquiry — match the phone's NEWEST row (col G) against startedAt
// ---------------------------------------------------------------------------

describe("upsertLeadRow — startedAt (new row per inquiry)", () => {
  const OLD = "01/09/2026 10:00";
  const NEWER = "20/09/2026 12:30";

  it("updates the phone's newest row when it was created after startedAt", async () => {
    mockSheetsBatchGet.mockResolvedValue(
      batchGetFixture([[["972501234567", "a", "", "", "", "", OLD], ["972501234567", "b", "", "", "", "", NEWER]], [], []]),
    );
    mockSheetsUpdate.mockResolvedValue({});

    const row = ["972501234567", "Name", "ביטוח רכב", "", "", "", "20/09/2026 12:31"];
    const result = await upsertLeadRow(row, TAB_NEW, { startedAt: new Date("2026-09-20T09:00:00Z") }); // 12:00 Israel

    expect(result).toBe(true);
    expect(mockSheetsAppend).not.toHaveBeenCalled();
    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_NEW}'!A2:G2`);
  });

  it("appends a fresh row when the newest row predates startedAt", async () => {
    mockSheetsBatchGet.mockResolvedValue(
      batchGetFixture([[["972501234567", "a", "", "", "", "", OLD], ["972501234567", "b", "", "", "", "", NEWER]], [], []]),
    );
    mockSheetsAppend.mockResolvedValue({});

    const row = ["972501234567", "Name", "ביטוח דירה", "", "", "", "04/10/2026 10:00"];
    const result = await upsertLeadRow(row, TAB_NEW, { startedAt: new Date("2026-10-04T07:00:00Z") }); // 10:00 Israel

    expect(result).toBe(true);
    expect(mockSheetsUpdate).not.toHaveBeenCalled();
    expect(mockSheetsAppend).toHaveBeenCalledOnce();
  });

  it("the newest row wins even when it sits in another tab", async () => {
    mockSheetsBatchGet.mockResolvedValue(
      batchGetFixture([[["972501234567", "a", "", "", "", "", OLD]], [], [["972501234567", "moved", "", "", "", "", NEWER]]]),
    );
    mockSheetsUpdate.mockResolvedValue({});

    await upsertLeadRow(["972501234567", "n", "", "", "", "", ""], TAB_NEW, { startedAt: new Date("2026-09-20T09:00:00Z") });

    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_IRRELEVANT}'!A1:G1`);
  });

  it("a row with no parsable creation date counts as old → append", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972501234567", "typed by hand"]], [], []]));
    mockSheetsAppend.mockResolvedValue({});

    await upsertLeadRow(["972501234567", "n", "", "", "", "", ""], TAB_NEW, { startedAt: new Date("2026-10-04T07:00:00Z") });

    expect(mockSheetsAppend).toHaveBeenCalledOnce();
    expect(mockSheetsUpdate).not.toHaveBeenCalled();
  });

  it("allows one minute of slack between the stamp and the row's creation date", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972501234567", "a", "", "", "", "", "04/10/2026 09:59"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});

    await upsertLeadRow(["972501234567", "n", "", "", "", "", ""], TAB_NEW, { startedAt: new Date("2026-10-04T07:00:20Z") }); // 10:00:20 Israel

    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
  });

  it("without startedAt keeps the legacy behaviour: newest row is updated", async () => {
    mockSheetsBatchGet.mockResolvedValue(
      batchGetFixture([[["972501234567", "a", "", "", "", "", OLD], ["972501234567", "b", "", "", "", "", NEWER]], [], []]),
    );
    mockSheetsUpdate.mockResolvedValue({});

    await upsertLeadRow(["972501234567", "n", "", "", "", "", ""], TAB_NEW);

    const updateArg = mockSheetsUpdate.mock.calls[0]?.[0] as { range: string };
    expect(updateArg.range).toBe(`'${TAB_NEW}'!A2:G2`);
  });
});

describe("upsertLeadRow — phone normalisation (F2)", () => {
  it("a hand-typed 05x number matches the 972 lead", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["054-123-4567"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});

    await upsertLeadRow(["972541234567", "n", "", "", "", "", ""], TAB_NEW);

    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
    expect(mockSheetsAppend).not.toHaveBeenCalled();
  });

  it("a 9-digit landline typed with a leading 0 also matches", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["02-6244791"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});

    await upsertLeadRow(["97226244791", "n", "", "", "", "", ""], TAB_NEW);

    expect(mockSheetsUpdate).toHaveBeenCalledOnce();
  });
});

describe("upsertLeadRow — column D wrap on update", () => {
  it("sets WRAP on D when the written cell has several lines", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972501234567"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});
    mockSheetsBatchUpdate.mockResolvedValue({});

    await upsertLeadRow(["972501234567", "n", "", "https://a\nhttps://b", "", "", ""], TAB_NEW);

    expect(mockSheetsBatchUpdate).toHaveBeenCalledOnce();
    const arg = mockSheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: { requests: [{ repeatCell: { range: { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number }; cell: { userEnteredFormat: { wrapStrategy: string } } } }] };
    };
    const req = arg.requestBody.requests[0].repeatCell;
    expect(req.range).toEqual({ sheetId: SHEETID_NEW, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 });
    expect(req.cell.userEnteredFormat.wrapStrategy).toBe("WRAP");
  });

  it("does not touch formatting when D is a single line", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972501234567"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});

    await upsertLeadRow(["972501234567", "n", "", "https://a", "", "", ""], TAB_NEW);

    expect(mockSheetsBatchUpdate).not.toHaveBeenCalled();
  });

  it("a wrap failure never fails the update", async () => {
    mockSheetsBatchGet.mockResolvedValue(batchGetFixture([[["972501234567"]], [], []]));
    mockSheetsUpdate.mockResolvedValue({});
    mockSheetsBatchUpdate.mockRejectedValue(new Error("format API down"));

    const result = await upsertLeadRow(["972501234567", "n", "", "https://a\nhttps://b", "", "", ""], TAB_NEW);

    expect(result).toBe(true);
  });
});

describe("upsertLeadRow — stale tab cache self-heals (F1)", () => {
  it("a 400 drops every leads_sheet_* cache key, re-resolves and retries once", async () => {
    mockSheetsBatchGet
      .mockRejectedValueOnce(Object.assign(new Error("Unable to parse range: 'לידים חדשים '!A:G"), { code: 400 }))
      .mockResolvedValueOnce(batchGetFixture([[], [], []]));
    mockSheetsAppend.mockResolvedValue({});

    const result = await upsertLeadRow(["972501234567", "n", "", "", "", "", ""], TAB_NEW);

    expect(result).toBe(true);
    expect(mockSpreadsheetsGet).toHaveBeenCalled(); // cache miss after invalidation → live resolution
    expect(mockSheetsBatchGet).toHaveBeenCalledTimes(2);
    expect(mockSheetsAppend).toHaveBeenCalledOnce();
    expect(store.get(`leads_sheet_tab_resolved:${TAB_NEW}`)).toBe(TAB_NEW); // re-cached
  });

  it("a second 400 is not retried again", async () => {
    mockSheetsBatchGet.mockRejectedValue(Object.assign(new Error("bad range"), { code: 400 }));

    const result = await upsertLeadRow(["972501234567", "n", "", "", "", "", ""], TAB_NEW);

    expect(result).toBe(false);
    expect(mockSheetsBatchGet).toHaveBeenCalledTimes(2);
  });

  it("a 500 is not a cache problem → no retry", async () => {
    mockSheetsBatchGet.mockRejectedValue(Object.assign(new Error("backend"), { code: 500 }));

    const result = await upsertLeadRow(["972501234567", "n", "", "", "", "", ""], TAB_NEW);

    expect(result).toBe(false);
    expect(mockSheetsBatchGet).toHaveBeenCalledOnce();
    expect(store.get(`leads_sheet_tab_resolved:${TAB_NEW}`)).toBe(TAB_NEW); // untouched
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd Server && npx vitest run src/domains/integrations/google/google.sheets.test.ts`
Expected: the new tests FAIL (append instead of update, missing batchUpdate, no retry); the two edited formatting tests FAIL on `toHaveLength(3)`.

- [ ] **Step 3: Implement**

In `Server/src/domains/integrations/google/google.sheets.ts`:

(a) Add after `quoteA1Title`:

```ts
// Column A may hold a lead's phone as 972…, +972-…, or a hand-typed 05x/02-…; compare
// all of them in one canonical form so a returning lead never spawns a duplicate row.
export function canonicalPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return /^0\d{8,9}$/.test(digits) ? `972${digits.slice(1)}` : digits;
}

// Creation dates are written to col G as DD/MM/YYYY HH:mm (Asia/Jerusalem). Both sides
// are compared as YYYYMMDDHHmm keys in that same local frame — no timezone arithmetic.
function creationKey(g: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec((g ?? "").trim());
  return m ? `${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}` : null;
}

export function israelKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}`;
}
```

(b) In `formatDataRow`, add a third request after the `setDataValidation` request:

```ts
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: rowIndex1Based - 1,
              endRowIndex: rowIndex1Based,
              startColumnIndex: 3,
              endColumnIndex: 4,
            },
            cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
            fields: "userEnteredFormat.wrapStrategy",
          },
        },
```

and add a sibling helper after `formatAppendedRowBestEffort`:

```ts
// Column D holds one Drive link per line; without WRAP the row shows only the first.
async function wrapColumnDBestEffort(
  sheets: ReturnType<typeof google.sheets>,
  exactTitle: string,
  rowIndex1Based: number,
): Promise<void> {
  try {
    const sheetId = await resolveLeadsSheetId(exactTitle);
    if (sheetId === null) return;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: rowIndex1Based - 1,
                endRowIndex: rowIndex1Based,
                startColumnIndex: 3,
                endColumnIndex: 4,
              },
              cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
              fields: "userEnteredFormat.wrapStrategy",
            },
          },
        ],
      },
    });
  } catch (err) {
    logger.warn({ err }, "google.sheets: column D wrap failed");
  }
}
```

(c) Replace `findPhoneRow` (lines 263–278) with:

```ts
interface PhoneRowMatch {
  title: string;
  row: number;
  creation: string | null;
}

function findPhoneRows(
  valueRanges: Array<{ values?: string[][] | null }>,
  titles: string[],
  phone: string,
): PhoneRowMatch[] {
  const target = canonicalPhone(phone);
  const out: PhoneRowMatch[] = [];
  if (!target) return out;
  for (let t = 0; t < titles.length; t++) {
    const rows = valueRanges[t]?.values ?? [];
    for (let i = 0; i < rows.length; i++) {
      if (canonicalPhone(rows[i]?.[0]) === target) {
        out.push({ title: titles[t]!, row: i + 1, creation: creationKey(rows[i]?.[6]) });
      }
    }
  }
  return out;
}

// The lead's newest row by creation date; rows without a parsable date sort oldest and
// search order (target tab first) breaks exact ties.
function pickNewest(matches: PhoneRowMatch[]): PhoneRowMatch | null {
  let best: PhoneRowMatch | null = null;
  for (const m of matches) {
    if (!best || (m.creation ?? "") > (best.creation ?? "")) best = m;
  }
  return best;
}

function isRangeError(err: unknown): boolean {
  const e = err as { code?: number | string; response?: { status?: number } } | null;
  const status = Number(e?.response?.status ?? e?.code);
  return status === 400 || status === 404;
}

// A renamed or recreated tab makes every cached title/gid stale at once; drop them all
// and let the next resolution rebuild from the live spreadsheet.
async function invalidateLeadsSheetCache(): Promise<void> {
  await supabaseAdmin.from("system_settings").delete().like("key", "leads_sheet_%");
}
```

(d) Change the public signature and the locked implementation:

```ts
export interface UpsertLeadRowOptions {
  setOnceColumns?: number[];
  // Start of the lead's current inquiry: the phone's newest row is updated only if it
  // was created at/after this instant (1 min slack); an older row means a NEW inquiry
  // and a fresh row is appended instead.
  startedAt?: Date;
}

export function upsertLeadRow(
  values: string[],
  tabTitle?: string,
  opts?: UpsertLeadRowOptions,
): Promise<boolean> {
  return withSheetLock(() => upsertLeadRowLocked(values, tabTitle, opts, 0));
}

async function upsertLeadRowLocked(
  values: string[],
  tabTitle: string | undefined,
  opts: UpsertLeadRowOptions | undefined,
  attempt: number,
): Promise<boolean> {
```

Inside it, keep the resolution and auth code as is, then replace the body of the main `try { ... } catch` with:

```ts
  try {
    const sheets = google.sheets({ version: "v4", auth: client });

    const batchRes = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: env.LEADS_SPREADSHEET_ID,
      ranges: resolvedTitles.map((t) => `${quoteA1Title(t)}!A:G`),
    });

    const valueRanges = (batchRes.data.valueRanges ?? []) as Array<{ values?: string[][] | null }>;
    const newest = pickNewest(findPhoneRows(valueRanges, resolvedTitles, phone));
    const startedKey = opts?.startedAt ? israelKey(new Date(opts.startedAt.getTime() - 60_000)) : null;
    const match = newest && !(startedKey && (newest.creation ?? "") < startedKey) ? newest : null;

    const endCol = colLetter(values.length);

    if (match !== null) {
      const outValues = [...values];

      // Preserve set-once columns (e.g. creation date, relevance) that already hold a value.
      const setOnce = opts?.setOnceColumns;
      if (setOnce && setOnce.length > 0) {
        const existingRes = await sheets.spreadsheets.values.get({
          spreadsheetId: env.LEADS_SPREADSHEET_ID,
          range: `${quoteA1Title(match.title)}!A${match.row}:${endCol}${match.row}`,
        });
        const existing = ((existingRes.data.values as string[][] | null | undefined) ?? [])[0] ?? [];
        for (const idx of setOnce) {
          const prev = existing[idx];
          if (typeof prev === "string" && prev.trim() !== "") {
            outValues[idx] = prev;
          }
        }
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: env.LEADS_SPREADSHEET_ID,
        range: `${quoteA1Title(match.title)}!A${match.row}:${endCol}${match.row}`,
        valueInputOption: "RAW",
        requestBody: { values: [outValues] },
      });

      if ((outValues[3] ?? "").includes("\n")) {
        await wrapColumnDBestEffort(sheets, match.title, match.row);
      }
    } else {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: env.LEADS_SPREADSHEET_ID,
        range: `${targetTitle}!A:${endCol}`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      });
      await formatAppendedRowBestEffort(sheets, targetTitle, res.data?.updates?.updatedRange);
    }

    return true;
  } catch (err) {
    if (attempt === 0 && isRangeError(err)) {
      logger.warn({ err }, "google.sheets: upsertLeadRow got 400/404 — refreshing the tab cache and retrying once");
      await invalidateLeadsSheetCache();
      return upsertLeadRowLocked(values, tabTitle, opts, 1);
    }
    logger.error({ err }, "google.sheets: upsertLeadRow failed");
    return false;
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd Server && npx vitest run src/domains/integrations/google && npm run typecheck`
Expected: PASS (including the unchanged legacy tests: "phone found in target AND another tab → target wins" still holds because equal, missing creation keys keep the first match).

- [ ] **Step 5: Commit**

```bash
git add Server/src/domains/integrations/google/google.sheets.ts Server/src/domains/integrations/google/google.sheets.test.ts
git commit -m "feat(sheets): newest-row matching per inquiry, canonical phones, D wrap, tab-cache self-heal

upsertLeadRow now reads A:G, matches phones in one canonical form (054… ==
972…), updates the lead's NEWEST row only when it belongs to the current
inquiry (startedAt), and appends a fresh row otherwise. Column D is wrapped
whenever it holds several lines. A 400/404 from Sheets drops the cached tab
titles/gids and retries once, so renaming a tab no longer kills every write.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Sheet mirror — column D from `documents`, `startedAt` (spec C/D)

**Files:**
- Modify: `Server/src/domains/integrations/google/leads-mirror.service.ts`
- Test: `Server/src/domains/integrations/google/leads-mirror.test.ts`

**Interfaces:**
- Consumes: `upsertLeadRow(row, tab, { setOnceColumns, startedAt })` from Task 3.
- Produces: `mirrorLeadToSheet(clientId)` unchanged signature; D = all `documents.file_url` for the client, oldest first, joined with `\n`; E = `clients.id_number`. With no menu choice, a row is written only when there is a `documents` row since `intake_started_at` (1-minute slack, as in `upsertLeadRow`; `NULL` = `created_at`).

> Amended 2026-10-05 after the Task 4 review: the gate first counted any `documents` row the client ever had. With Task 6's restart stamp and Task 3's append rule, that opened a blank-C row for every returning lead who had ever sent a file and then wrote anything but a menu tap. Spec C was amended to match.

- [ ] **Step 1: Rewrite the failing tests**

In `leads-mirror.test.ts`:

1. Replace `clientRow` with:

```ts
function clientRow(over: Record<string, unknown>) {
  return {
    phone: "972501234567",
    full_name: "יעל כהן",
    inquiry_type: "vehicle",
    client_type: null,
    id_number: null,
    intake_started_at: "2026-10-04T07:00:00.000Z",
    created_at: "2026-09-01T08:00:00.000Z",
    ...over,
  };
}

function docsResult(urls: string[]) {
  return { data: urls.map((u, i) => ({ file_url: u, created_at: `2026-10-0${i + 1}T08:00:00.000Z` })), error: null };
}
```

2. Every `setupFromSequence([makeBuilder({ data: clientRow(...), error: null })])` call becomes a two-builder sequence — clients first, documents second. Add a helper right under `setupFromSequence`:

```ts
function setupClient(clientOver: Record<string, unknown>, docUrls: string[] = []) {
  setupFromSequence([
    makeBuilder({ data: clientRow(clientOver), error: null }),
    makeBuilder(docsResult(docUrls)),
  ]);
}

// Each document's created_at spelled out: with no menu choice, only a file from the current
// inquiry (on/after intake_started_at, 1 min slack) opens a row.
function setupClientDocsAt(clientOver: Record<string, unknown>, docs: [url: string, createdAt: string][]) {
  setupFromSequence([
    makeBuilder({ data: clientRow(clientOver), error: null }),
    makeBuilder({ data: docs.map(([file_url, created_at]) => ({ file_url, created_at })), error: null }),
  ]);
}
```

and use it: e.g. the first test becomes

```ts
    setupClient(
      { inquiry_type: "life_health_pension", id_number: "123456782", client_type: "new" },
      ["https://drive.google.com/file/d/abc/view"],
    );
```

   with assertions `expect(row[3]).toBe("https://drive.google.com/file/d/abc/view")` and `expect(opts).toEqual({ setOnceColumns: [5, 6], startedAt: new Date("2026-10-04T07:00:00.000Z") })`.

   For tests that pass `id_photo_url` in `clientRow(...)`, pass the url through `setupClient(..., [url])` instead and drop the `id_photo_url` key. The "not found" test keeps `setupFromSequence([makeBuilder({ data: null, error: null })])`.

3. Replace the describe `mirrorLeadToSheet — photo-bearing lead with no menu choice` with:

```ts
describe("mirrorLeadToSheet — column D from documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertLeadRow.mockResolvedValue(true);
  });

  it("joins every document link oldest-first, one per line", async () => {
    setupClient({ inquiry_type: "vehicle" }, ["https://drive/1", "https://drive/2", "https://drive/3"]);

    await mirrorLeadToSheet(CLIENT_ID);

    const [row] = mockUpsertLeadRow.mock.calls[0] as [string[]];
    expect(row[3]).toBe("https://drive/1\nhttps://drive/2\nhttps://drive/3");
  });

  it("reads documents ordered by created_at ascending", async () => {
    const docs = makeBuilder(docsResult(["https://drive/1"]));
    setupFromSequence([makeBuilder({ data: clientRow({}), error: null }), docs]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(docs["eq"]).toHaveBeenCalledWith("client_id", CLIENT_ID);
    expect(docs["order"]).toHaveBeenCalledWith("created_at", { ascending: true });
  });

  it("'general' + a document from this inquiry → row IS written, col C blank, into the new-leads tab", async () => {
    setupClientDocsAt({ inquiry_type: "general" }, [
      ["https://drive.google.com/file/d/cap/view", "2026-10-04T07:05:00.000Z"],
    ]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).toHaveBeenCalledOnce();
    const [row, tab, opts] = mockUpsertLeadRow.mock.calls[0] as [string[], string, { setOnceColumns: number[] }];
    expect(row[2]).toBe("");
    expect(row[3]).toBe("https://drive.google.com/file/d/cap/view");
    expect(tab).toBe("לידים חדשים");
    expect(opts.setOnceColumns).toEqual([2, 5, 6]);
  });

  it("still skips 'general' when there is no document", async () => {
    setupClient({ inquiry_type: "general" }, []);
    await mirrorLeadToSheet(CLIENT_ID);
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("a returning lead back on 'general' whose files all predate this inquiry → no row (they sit on the previous inquiry's row)", async () => {
    setupClientDocsAt({ inquiry_type: "general" }, [
      ["https://drive/old-id", "2026-09-20T08:00:00.000Z"],
      ["https://drive/old-2", "2026-10-04T06:58:59.000Z"], // 61 s before intake_started_at
    ]);

    await mirrorLeadToSheet(CLIENT_ID);

    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });

  it("a known inquiry still overwrites col C (setOnce stays [5,6])", async () => {
    setupClient({ inquiry_type: "vehicle" }, ["https://drive/x"]);
    await mirrorLeadToSheet(CLIENT_ID);
    const [row, , opts] = mockUpsertLeadRow.mock.calls[0] as [string[], string, { setOnceColumns: number[] }];
    expect(row[2]).toBe("ביטוח רכב");
    expect(opts.setOnceColumns).toEqual([5, 6]);
  });

  it("falls back to created_at as startedAt when intake_started_at is null (pre-migration clients)", async () => {
    setupClient({ intake_started_at: null });
    await mirrorLeadToSheet(CLIENT_ID);
    const [, , opts] = mockUpsertLeadRow.mock.calls[0] as [string[], string, { startedAt: Date }];
    expect(opts.startedAt).toEqual(new Date("2026-09-01T08:00:00.000Z"));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd Server && npx vitest run src/domains/integrations/google/leads-mirror.test.ts`
Expected: FAIL (D empty / wrong, `startedAt` missing).

- [ ] **Step 3: Implement**

Replace the body of `mirrorLeadToSheet` in `leads-mirror.service.ts` (keep `nowIsraelString` and `inquiryColumn` as they are):

```ts
export async function mirrorLeadToSheet(clientId: string): Promise<void> {
  if (!env.LEADS_MIRROR_ENABLED) return;

  try {
    const { data: client } = await supabaseAdmin
      .from("clients")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("phone, full_name, inquiry_type, client_type, id_number, intake_started_at, created_at" as any)
      .eq("id", clientId)
      .maybeSingle();

    if (!client) {
      logger.warn({ clientId }, "leads-mirror: client not found — skipping");
      return;
    }

    const c = client as {
      phone?: string | null;
      full_name?: string | null;
      inquiry_type?: string | null;
      client_type?: string | null;
      id_number?: string | null;
      intake_started_at?: string | Date | null;
      created_at?: string | Date | null;
    };

    if (!c.phone) {
      logger.debug({ clientId }, "leads-mirror: no phone — skipping");
      return;
    }

    const { data: docs } = await supabaseAdmin
      .from("documents")
      .select("file_url, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: true });
    const docRows = (docs ?? []) as { file_url?: string | null; created_at?: string | Date | null }[];
    const links = docRows
      .map((d) => d.file_url)
      .filter((u): u is string => typeof u === "string" && u.length > 0);

    // Pre-migration clients have no intake_started_at: their creation stands in for it,
    // so their existing row keeps being updated until they start a new inquiry.
    const startedAt = new Date(c.intake_started_at ?? c.created_at ?? Date.now());

    const inquiry = c.inquiry_type;
    // A lead who sent a file in this inquiry before picking a menu option still needs a row:
    // the sheet is the only place staff can reach the Drive links (Chatwoot shows [תמונה] only).
    // Files from an earlier inquiry are already on that inquiry's row, so they never open a
    // blank one. The minute of slack is upsertLeadRow's, and keeps a file that raced the
    // restart stamp.
    const noMenuChoice = !inquiry || inquiry === "general";
    const hasCurrentFile = docRows.some(
      (d) => d.created_at != null && new Date(d.created_at).getTime() >= startedAt.getTime() - 60_000,
    );
    if (noMenuChoice && !hasCurrentFile) {
      logger.debug({ clientId, inquiry }, "leads-mirror: no menu choice yet — skipping");
      return;
    }
    if (inquiry === "meeting" && c.client_type !== "old" && c.client_type !== "new") {
      logger.debug({ clientId }, "leads-mirror: meeting awaiting existing/new sub-choice — skipping");
      return;
    }

    const tab = inquiry === "meeting" && c.client_type === "old"
      ? env.LEADS_SHEET_TAB_EXISTING
      : env.LEADS_SHEET_TAB_NEW;

    const name = displayName(c.full_name, c.phone) ?? "";
    const inquiryHe = inquiryColumn(c.inquiry_type, c.client_type);

    // A phone · B name · C inquiry · D every Drive link (one per line) · E ID number ·
    // F relevance (manual) · G creation date
    const row = [
      String(c.phone),
      name,
      inquiryHe,
      links.join("\n"),
      String(c.id_number ?? ""),
      "",
      nowIsraelString(),
    ];

    // F = relevance is human-owned (dropdown) and must survive re-mirrors fired on every
    // intake slot advance; G = creation date. C joins them only while the inquiry is still
    // unknown, so a returning lead (reset to "general") never blanks the label already there.
    await upsertLeadRow(row, tab, { setOnceColumns: noMenuChoice ? [2, 5, 6] : [5, 6], startedAt });
  } catch (err) {
    logger.error({ err, clientId }, "leads-mirror: unexpected error");
  }
}
```

If `select(...)` without the `as any` cast typechecks (it did for the previous column list), drop the cast and the eslint comment.

- [ ] **Step 4: Run the tests**

Run: `cd Server && npx vitest run src/domains/integrations/google/leads-mirror.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Server/src/domains/integrations/google/leads-mirror.service.ts Server/src/domains/integrations/google/leads-mirror.test.ts
git commit -m "feat(sheets): column D lists every file the lead sent; rows keyed per inquiry

The mirror rebuilds D from the client's documents rows (oldest first, one
link per line) instead of a single overwritten pointer, so nothing is lost
and concurrent captures can't race. It passes the client's intake_started_at
so a returning lead gets a fresh row instead of silently rewriting the old one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `captureLeadFile` — silent ID detection on every file (spec A)

**Files:**
- Modify: `Server/src/domains/ai/intake-media.ts`
- Test: `Server/src/domains/ai/intake-media.test.ts` (rewrite the `captureIntakeDocument` describe)

**Interfaces:**
- Consumes: `validateIdPhoto(dataUrl)` from `./ai.service.js` (Task 1 semantics: `idNumber` is 9 digits or null), `mirrorLeadToSheet` (Task 4).
- Produces: `export async function captureLeadFile(clientId: string, payload: MessagePayload): Promise<void>` (replaces `captureIntakeDocument`). `resolveInboundMedia` unchanged.

> Amended 2026-10-05 after the Task 5+6 review: the shim resolves `{ error }` instead of throwing, so `captureLeadFile` now checks its client read, the `documents` insert and the client update. It logs only code + message, because Postgres' DETAIL ("Failing row contains (…)") carries the row, ID number and name included. A failed insert still saves a verified ID on the client. The sheet is synced when at least one write landed. Only a fully recorded file logs `intake-media: lead file archived`; a partial one logs `… not fully recorded` with `docSaved`/`clientSaved`. The `id_photo` slot guard moved out of this function (see Task 6).

- [ ] **Step 1: Write the failing tests**

In `intake-media.test.ts`:

1. Add to the hoisted block `mockValidateIdPhoto: vi.fn(),` (and destructure it), and add the mock:

```ts
vi.mock("./ai.service.js", () => ({ validateIdPhoto: mockValidateIdPhoto }));
```

2. Change the import to `import { captureLeadFile, resolveInboundMedia } from "./intake-media.js";`.

3. `clientData` becomes:

```ts
function clientData(over: Record<string, unknown> = {}) {
  return {
    data: { phone: "972501234567", full_name: "יעל כהן", intake_current_slot: "menu", ...over },
    error: null,
  };
}

const NOT_AN_ID = { valid: false, hasIdCard: false, hasAppendix: false, idNumber: null, fullName: null };
const VALID_ID = { valid: true, hasIdCard: true, hasAppendix: true, idNumber: "123456782", fullName: "ישראל ישראלי" };
const IMAGE_AS_FILE = { kind: "document" as const, mediaId: "media-9", mimeType: "image/jpeg", fileName: "IMG_1.jpg" };
```

   and in `beforeEach` add `mockValidateIdPhoto.mockResolvedValue(NOT_AN_ID);`.

4. Replace the whole `describe("captureIntakeDocument", ...)` with:

```ts
describe("captureLeadFile", () => {
  it("non-ID image → OCR ran, archived as 'other', client row untouched, sheet mirrored", async () => {
    const { builders, tables } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(mockValidateIdPhoto).toHaveBeenCalledOnce();
    expect(mockValidateIdPhoto.mock.calls[0]![0]).toMatch(/^data:image\/jpeg;base64,/);
    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string; mimeType: string; bytes: Buffer };
    expect(up.bytes).toBe(BYTES);
    expect(up.mimeType).toBe("image/jpeg");
    // "<name> - YYYY-MM-DD HH.mm.ss.<ext>" — ":" would be unsafe in a file name
    expect(up.name).toMatch(/^יעל כהן - \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.jpg$/);
    expect(tables).toContain("documents");
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({
      client_id: CLIENT_ID,
      type: "other",
      file_url: "https://drive.google.com/file/d/drive-file-1/view",
      mime_type: "image/jpeg",
    });
    expect(builders["clientsUpdate"]!["update"]).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
  });

  it("valid ID + number → 'id_photo' row, number + validated + name on the client, Drive name from the ID", async () => {
    mockValidateIdPhoto.mockResolvedValue(VALID_ID);
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string };
    expect(up.name).toBe("ישראל ישראלי - ID.jpg");
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "id_photo" });
    expect(builders["clientsUpdate"]!["update"]).toHaveBeenCalledWith({
      id_photo_url: "https://drive.google.com/file/d/drive-file-1/view",
      id_number: "123456782",
      id_validated: true,
      full_name: "ישראל ישראלי",
    });
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
  });

  it("valid ID whose number is unreadable → link + name saved, E left blank, warning logged", async () => {
    mockValidateIdPhoto.mockResolvedValue({ ...VALID_ID, idNumber: null });
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "id_photo" });
    expect(builders["clientsUpdate"]!["update"]).toHaveBeenCalledWith({
      id_photo_url: "https://drive.google.com/file/d/drive-file-1/view",
      full_name: "ישראל ישראלי",
    });
    const { logger } = await import("../../config/logger.js");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ clientId: CLIENT_ID }), expect.stringContaining("without a readable number"));
  });

  it("valid ID with no readable name → Drive name falls back to the lead's name + stamp, full_name untouched", async () => {
    mockValidateIdPhoto.mockResolvedValue({ ...VALID_ID, fullName: null });
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string };
    expect(up.name).toMatch(/^יעל כהן - \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.jpg$/);
    expect(builders["clientsUpdate"]!["update"]).toHaveBeenCalledWith({
      id_photo_url: "https://drive.google.com/file/d/drive-file-1/view",
      id_number: "123456782",
      id_validated: true,
    });
  });

  it("OCR throws → treated as not-an-ID, file still archived", async () => {
    mockValidateIdPhoto.mockRejectedValue(new Error("model down"));
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(mockUploadLeadDocument).toHaveBeenCalledOnce();
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "other" });
    expect(builders["clientsUpdate"]!["update"]).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).toHaveBeenCalledWith(CLIENT_ID);
  });

  it("a photo sent 'as a file' (document with image/* mime) is checked too", async () => {
    mockValidateIdPhoto.mockResolvedValue(VALID_ID);
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, IMAGE_AS_FILE);

    expect(mockValidateIdPhoto).toHaveBeenCalledOnce();
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "id_photo", file_name: "IMG_1.jpg" });
  });

  it("a PDF is archived without OCR", async () => {
    mockExtFor.mockReturnValue("pdf");
    const { builders } = setupTables(clientData());

    await captureLeadFile(CLIENT_ID, GREEN_DOC);

    expect(mockValidateIdPhoto).not.toHaveBeenCalled();
    expect(mockFetchRemoteFile).toHaveBeenCalledWith("https://green.example/file.pdf");
    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string; mimeType: string };
    expect(up.mimeType).toBe("application/pdf");
    expect(up.name).toMatch(/\.pdf$/);
    expect(builders["documents"]!["insert"].mock.calls[0][0]).toMatchObject({ type: "other", file_name: "policy.pdf" });
  });

  it("at the id_photo slot the handler owns the upload → nothing happens here", async () => {
    setupTables(clientData({ intake_current_slot: "id_photo" }));

    await captureLeadFile(CLIENT_ID, META_IMAGE);

    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
  });

  it("text and placeholder payloads → does nothing at all (no DB, no upload)", async () => {
    setupTables(clientData());
    await captureLeadFile(CLIENT_ID, { kind: "text", text: "שלום" });
    await captureLeadFile(CLIENT_ID, { kind: "other", subtype: "audio", label: "[הודעה קולית]" });
    expect(mockFromImpl).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("client has no phone → skips before downloading", async () => {
    setupTables({ data: { phone: null, full_name: "x" }, error: null });
    await captureLeadFile(CLIENT_ID, META_IMAGE);
    expect(mockDownloadMetaMedia).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });

  it("media download fails → no OCR, no Drive upload, no mirror", async () => {
    mockDownloadMetaMedia.mockResolvedValue(null);
    setupTables(clientData());
    await captureLeadFile(CLIENT_ID, META_IMAGE);
    expect(mockValidateIdPhoto).not.toHaveBeenCalled();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
  });

  it("Drive upload fails → no documents row, no client update, no mirror", async () => {
    mockUploadLeadDocument.mockResolvedValue(null);
    const { tables } = setupTables(clientData());
    await captureLeadFile(CLIENT_ID, META_IMAGE);
    expect(tables).not.toContain("documents");
    expect(mockMirrorLeadToSheet).not.toHaveBeenCalled();
  });

  it("falls back to the phone digits when full_name is just the phone", async () => {
    setupTables(clientData({ full_name: "972501234567" }));
    await captureLeadFile(CLIENT_ID, META_IMAGE);
    const up = mockUploadLeadDocument.mock.calls[0]![0] as { name: string };
    expect(up.name).toMatch(/^972501234567 - /);
  });

  it("never throws when the DB blows up — the pipeline must not break", async () => {
    mockFromImpl.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(captureLeadFile(CLIENT_ID, META_IMAGE)).resolves.toBeUndefined();
    expect(mockUploadLeadDocument).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd Server && npx vitest run src/domains/ai/intake-media.test.ts`
Expected: FAIL (`captureLeadFile` is not exported).

- [ ] **Step 3: Implement**

Replace everything from the `/**  * Archive a file a lead sent ...` doc comment to the end of `intake-media.ts` with:

```ts
/**
 * Archive any file a known lead sends: Drive upload, `documents` row, CRM-sheet sync.
 * Images (including photos sent "as a file") are first run through the strict ID check;
 * a valid תעודת זהות + ספח photo also fills the client's ID number and name.
 *
 * Best-effort and silent — never throws, never replies to the lead, never blocks the bot.
 * The `id_photo` slot is skipped: that handler runs its own OCR-gated upload and replies.
 */
export async function captureLeadFile(clientId: string, payload: MessagePayload): Promise<void> {
  if (payload.kind !== "image" && payload.kind !== "document") return;

  try {
    const { data } = await supabaseAdmin
      .from("clients")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("phone, full_name, intake_current_slot" as any)
      .eq("id", clientId)
      .maybeSingle();

    const client = (data ?? null) as {
      phone?: string | null;
      full_name?: string | null;
      intake_current_slot?: string | null;
    } | null;

    if (!client?.phone) {
      logger.warn({ clientId }, "intake-media: client has no phone — skipping capture");
      return;
    }
    if (client.intake_current_slot === "id_photo") return;

    const bytes = await resolveInboundMedia(payload);
    if (!bytes) {
      logger.warn({ clientId, kind: payload.kind }, "intake-media: inbound media download failed");
      return;
    }

    const mimeType =
      payload.mimeType ?? (payload.kind === "image" ? "image/jpeg" : "application/octet-stream");
    const ocr = mimeType.startsWith("image/") ? await inspectIdPhoto(bytes, mimeType) : null;
    const idPhoto = ocr && ocr.valid ? ocr : null;

    const ext = extFor(mimeType, payload.fileName);
    const base = displayName(client.full_name, client.phone) ?? client.phone.replace(/\D/g, "");
    const name = idPhoto?.fullName ? `${idPhoto.fullName} - ID.${ext}` : `${base} - ${driveStamp()}.${ext}`;

    const up = await uploadLeadDocument({ name, mimeType, bytes });
    if (!up) return; // uploadLeadDocument already logged why

    await supabaseAdmin.from("documents").insert({
      client_id: clientId,
      type: idPhoto ? "id_photo" : "other",
      file_url: up.webViewLink,
      file_name: payload.fileName ?? null,
      mime_type: mimeType,
    });

    if (idPhoto) {
      // Newest verified ID wins; a client is never downgraded (id_validated only ever becomes true).
      await supabaseAdmin
        .from("clients")
        .update({
          id_photo_url: up.webViewLink,
          ...(idPhoto.idNumber ? { id_number: idPhoto.idNumber, id_validated: true } : {}),
          ...(idPhoto.fullName ? { full_name: idPhoto.fullName } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .eq("id", clientId);
      if (!idPhoto.idNumber) {
        logger.warn({ clientId, fileId: up.fileId }, "intake-media: ID photo without a readable number — column E left blank");
      }
    }

    await mirrorLeadToSheet(clientId);

    logger.info(
      {
        clientId,
        kind: payload.kind,
        mimeType,
        isIdPhoto: idPhoto !== null,
        hasIdCard: ocr?.hasIdCard ?? null,
        hasAppendix: ocr?.hasAppendix ?? null,
        idOk: !!idPhoto?.idNumber,
        fileId: up.fileId,
      },
      "intake-media: lead file archived",
    );
  } catch (err) {
    logger.error({ err, clientId }, "intake-media: capture failed — continuing");
  }
}

// The vision pass is best-effort here: a model or API failure means "not an ID",
// never a lost file. The bytes go as a data URL because Meta media URLs need a
// Bearer header OpenRouter cannot send.
async function inspectIdPhoto(
  bytes: Buffer,
  mimeType: string,
): Promise<Awaited<ReturnType<typeof validateIdPhoto>> | null> {
  try {
    return await validateIdPhoto(`data:${mimeType};base64,${bytes.toString("base64")}`);
  } catch (err) {
    logger.warn({ err }, "intake-media: ID inspection failed — archiving as a plain file");
    return null;
  }
}
```

Add the import at the top of the file:

```ts
import { validateIdPhoto } from "./ai.service.js";
```

- [ ] **Step 4: Run the tests**

Run: `cd Server && npx vitest run src/domains/ai/intake-media.test.ts`
Expected: PASS (15 tests). `npm run typecheck` will fail until Task 6 removes the old import in the orchestrator — that is expected; move on.

- [ ] **Step 5: Commit**

```bash
git add Server/src/domains/ai/intake-media.ts Server/src/domains/ai/intake-media.test.ts
git commit -m "feat(intake): run the strict ID check on every image a lead sends, silently

captureLeadFile replaces captureIntakeDocument: each image (or photo sent as
a file) goes through validateIdPhoto before the Drive upload. A valid ID card
+ ספח photo is stored as an id_photo document, fills the client's ID number
(check-digit verified), name and verified flag, and is named after the ID.
Anything else is archived as before. The lead is never told either way, and
nothing can break the bot reply.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Capture from the pipeline (always), `intake_started_at`, tap-after-cooldown (spec B/D)

**Files:**
- Modify: `Server/src/domains/whatsapp/inbound.pipeline.ts` (:4-7 imports, :135-146 client insert, :199-211 hooks)
- Modify: `Server/src/domains/ai/intake.orchestrator.ts` (:16-17 imports, :38-52 `ClientIntakeUpdate`, :246-321 `handleMenu`, :576-598 capture + restart)
- Test: `Server/src/domains/whatsapp/inbound.pipeline.test.ts`, `Server/src/domains/ai/intake.orchestrator.test.ts`

**Interfaces:**
- Consumes: `captureLeadFile` (Task 5).
- Produces: new clients and every fresh restart carry `intake_started_at` (ISO string); the capture no longer lives in the orchestrator.

> Amended 2026-10-05 after the Task 5+6 review: the `id_photo` exclusion assumed that step archives every file at its slot. That is false for a document there (a PDF, or a photo sent as a file) and for anything sent while the step is gated (staff-takeover pause, bot off, `skipped`). Such files were lost. `handleIntake` now returns `fileHandled: true` only when the `id_photo` step took an image (accepted and uploaded, or re-asked). The pipeline fires `captureLeadFile` right after `handleIntake` unless that flag is set, so no second read of the slot can race. The restart block now checks its UPDATE's `{ error }`: on failure it logs and stops instead of looping. Spec A/B were amended to match.

- [ ] **Step 1: Write the failing pipeline tests**

In `inbound.pipeline.test.ts`:

1. Add `mockCaptureLeadFile: vi.fn().mockResolvedValue(undefined),` to the hoisted block (and destructure it) and the mock:

```ts
vi.mock("../ai/intake-media.js", () => ({ captureLeadFile: mockCaptureLeadFile }));
```

   In `beforeEach` add `mockCaptureLeadFile.mockResolvedValue(undefined);`.

2. Append a describe:

```ts
// ---------------------------------------------------------------------------
// File capture runs for every linked lead, independent of what the bot does
// ---------------------------------------------------------------------------

describe("processInboundCustomerMessage — file capture", () => {
  const imagePayload = (): MessagePayload => ({ kind: "image", mediaId: "m1", mimeType: "image/jpeg" });

  it("an image from a linked client is handed to captureLeadFile before intake runs", async () => {
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      makeBuilder({ data: { id: "msg1" }, error: null }),
      makeBuilder({ data: { id: "conv1", client_id: "client-1" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, imagePayload(), "meta"));

    expect(mockCaptureLeadFile).toHaveBeenCalledWith("client-1", expect.objectContaining({ kind: "image" }));
    expect(mockHandleIntake).toHaveBeenCalledOnce();
  });

  it("the capture still runs when intake is not consumed (paused / disabled bot)", async () => {
    mockHandleIntake.mockResolvedValue({ consumed: false });
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      makeBuilder({ data: { id: "msg1" }, error: null }),
      makeBuilder({ data: { id: "conv1", client_id: "client-1" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, imagePayload(), "meta"));

    expect(mockCaptureLeadFile).toHaveBeenCalledOnce();
  });

  it("a capture failure never breaks the pipeline", async () => {
    mockCaptureLeadFile.mockRejectedValue(new Error("drive down"));
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      makeBuilder({ data: { id: "msg1" }, error: null }),
      makeBuilder({ data: { id: "conv1", client_id: "client-1" }, error: null }),
    ]);

    await expect(processInboundCustomerMessage(inbound(LEAD_CHAT_ID, imagePayload(), "meta"))).resolves.toBeUndefined();
    expect(mockHandleIntake).toHaveBeenCalledOnce();
  });

  it("text messages are never captured", async () => {
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      makeBuilder({ data: { id: "msg1" }, error: null }),
      makeBuilder({ data: { id: "conv1", client_id: "client-1" }, error: null }),
    ]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, textPayload("שלום"), "meta"));

    expect(mockCaptureLeadFile).not.toHaveBeenCalled();
  });

  it("a brand-new client is created with intake_started_at stamped", async () => {
    const clientInsert = makeBuilder({ data: { id: "client-new" }, error: null });
    setupFrom([
      makeBuilder({ data: { id: "conv1" }, error: null }),
      makeBuilder({ data: { id: "msg1" }, error: null }),
      makeBuilder({ data: { id: "conv1", client_id: null }, error: null }),
      makeBuilder({ data: null, error: null }), // no existing client by phone
      makeBuilder({ data: { id: "staff-1" }, error: null }),
      clientInsert,
      makeBuilder({ data: null, error: null }), // link update
    ]);

    await processInboundCustomerMessage(inbound(LEAD_CHAT_ID, textPayload("שלום"), "meta"));

    const inserted = (clientInsert["insert"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { intake_started_at: string };
    expect(inserted.intake_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd Server && npx vitest run src/domains/whatsapp/inbound.pipeline.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the pipeline side**

In `inbound.pipeline.ts`:

Add the import:

```ts
import { captureLeadFile } from "../ai/intake-media.js";
```

In the new-client `.insert({...})` add after `assigned_to: staffRow.id,`:

```ts
              intake_started_at: new Date().toISOString(),
```

Replace the block from `void mirrorInboundHook(` to the end of the function with:

```ts
  void mirrorInboundHook(chatId, payload, senderName).catch((err: unknown) =>
    logger.warn({ err, chatId }, "mirrorInboundHook failed — continuing"),
  );

  // Every file a known lead sends is archived (Drive + sheet) no matter what the bot
  // does with the message — paused, switched off or mid-intake. Detached: never delays
  // the reply.
  if (linkedClientId) {
    const clientId = linkedClientId;
    void captureLeadFile(clientId, payload).catch((err: unknown) =>
      logger.warn({ err, clientId }, "captureLeadFile failed — continuing"),
    );
  }

  try {
    if (linkedClientId) {
      await handleIntake(
        conversationId,
        linkedClientId,
        chatId,
        payload,
      );
    }
  } catch (err) {
    logger.error({ conversationId, err }, "Async message processing error");
  }
}
```

- [ ] **Step 4: Run the pipeline tests**

Run: `cd Server && npx vitest run src/domains/whatsapp/inbound.pipeline.test.ts`
Expected: PASS. If an existing test asserts the exact client insert object with `toEqual`/`toHaveBeenCalledWith`, change that assertion to `expect.objectContaining({...})`.

- [ ] **Step 5: Write the failing orchestrator tests**

In `intake.orchestrator.test.ts`:

1. Delete `mockCaptureIntakeDocument` from the hoisted block and its `beforeEach` line, and delete the `vi.mock("./intake-media.js", ...)` block entirely (the real module is fine: everything it imports is already mocked here).

2. Delete the whole `describe("mid-intake document capture", ...)` (the capture now lives in the pipeline and is tested there).

3. In `describe("post-cooldown restart")`, extend the existing assertion with `intake_started_at: expect.any(String),` inside the `toMatchObject({...})`, and add:

```ts
  it("a menu tap as the first message after the cooldown is honoured, not answered with a new menu", async () => {
    const reset = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("done", "completed")),
      reset,
      makeBuilder({ data: null, error: null }), // inquiry_type update
      makeBuilder({ data: { phone: "972501234567", full_name: "דנה" }, error: null }), // loadContact
      makeBuilder({ data: null, error: null }),
    ]);

    const result = await handleIntake("conv", "client", "chat@c.us", buttonPayload("vehicle"));

    expect(result.consumed).toBe(true);
    expect((reset["update"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      intake_state: "collecting",
      intake_current_slot: "menu",
      intake_started_at: expect.any(String),
      inquiry_type: "general",
    });
    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
    expect(mockSendStaffLeadEmail).toHaveBeenCalledWith("vehicle", expect.anything());
    expect(mockSendMessageWithTyping.mock.calls[0]?.[1]).toBe("תודה על פנייתך! קיבלנו את הפרטים וניצור איתך קשר בהקדם.");
  });

  it("a typed label after the cooldown counts as a tap too", async () => {
    const reset = makeBuilder({ data: null, error: null });
    setupFrom([
      makeBuilder(BOT_ENABLED),
      makeBuilder(CONV_ACTIVE),
      makeBuilder(clientState("done", "completed")),
      reset,
      makeBuilder({ data: null, error: null }),
    ]);

    await handleIntake("conv", "client", "chat@c.us", textPayload("אשמח שדידי יחזור אליי"));

    expect(mockSendInteractiveButtons).not.toHaveBeenCalled();
    expect(mockNotifyOwner).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd Server && npx vitest run src/domains/ai/intake.orchestrator.test.ts`
Expected: the two new tests FAIL (menu re-sent, no staff email); the existing restart test FAILS on `intake_started_at`.

- [ ] **Step 7: Implement the orchestrator side**

In `intake.orchestrator.ts`:

(a) Change the intake-media import to `import { resolveInboundMedia } from "./intake-media.js";`.

(b) Add `intake_started_at?: string;` to `ClientIntakeUpdate`.

(c) Add above `handleMenu`:

```ts
/** The opening-menu button whose id or Hebrew label equals the message, if any. */
function findMenuButton(val: string) {
  const v = val.trim();
  return INTAKE_PROMPTS.menu.buttons.find((b) => b.buttonId === v || b.buttonText === v);
}
```

and in `handleMenu` replace

```ts
  const val = payload.text.trim();
  const matched = INTAKE_PROMPTS.menu.buttons.find(
    (b) => b.buttonId === val || b.buttonText === val,
  );
```

with

```ts
  const val = payload.text.trim();
  const matched = findMenuButton(val);
```

(d) Delete the capture block (the comment starting `// Leads routinely send the ID` through its closing `}`) and replace the restart block with:

```ts
  // 2. Completed / terminal + unpaused (post-cooldown) → fresh inquiry. A tap on the old
  // menu is a real choice — honour it instead of answering with yet another menu.
  if (state === "completed" || slot === "done") {
    const tapped = payload.kind === "text" ? findMenuButton(payload.text) : undefined;
    await updateClient(clientId, {
      intake_state: "collecting",
      intake_current_slot: tapped ? "menu" : "welcome",
      intake_started_at: new Date().toISOString(),
      consent_prompted_at: null,
      stall_notified_at: null,
      intake_completed_at: null,
      inquiry_type: "general",
      client_type: null,
    });
    if (tapped) {
      await handleMenu(conversationId, chatId, clientId, payload);
    } else {
      await handleWelcome(conversationId, chatId, clientId);
    }
    return { consumed: true };
  }
```

- [ ] **Step 8: Run the orchestrator tests, typecheck and lint**

Run: `cd Server && npx vitest run src/domains/ai src/domains/whatsapp && npm run typecheck && npm run lint`
Expected: PASS; clean.

- [ ] **Step 9: Commit**

```bash
git add Server/src/domains/whatsapp/inbound.pipeline.ts Server/src/domains/whatsapp/inbound.pipeline.test.ts Server/src/domains/ai/intake.orchestrator.ts Server/src/domains/ai/intake.orchestrator.test.ts
git commit -m "feat(intake): archive files even while the bot is paused; stamp intake_started_at; honour a tap after the cooldown

The file capture moves from the state machine into the inbound pipeline, so a
photo sent during the 24h cooldown or a staff takeover is saved instead of
discarded. New clients and every post-cooldown restart stamp
intake_started_at, which the sheet mirror uses to open a new row per inquiry.
A menu tap as the first message after the cooldown is processed as the choice
it is, instead of being answered with a fresh menu.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: DB column `clients.intake_started_at`

**Files:**
- Create: `supabase/migrations/20261004120000_clients_intake_started_at.sql`
- Modify: `db/schema.sql` (clients table, after `issue_description    text`)

**Interfaces:**
- Produces: nullable `clients.intake_started_at timestamptz`, read by Task 4 and written by Task 6. The OLD code ignores the column, so it runs against either schema. The NEW code does NOT: Task 6 names the column in the new-client INSERT and the restart UPDATE. Against the old schema every new lead's insert fails (42703), so the lead is never linked and gets no reply, and every returning lead's restart fails. **The column must exist on the VPS before this branch reaches `main`** (rollout step 2). No `DEFAULT now()`: it would stamp every existing client with the migration time, and their next sync would append a duplicate row. (Amended 2026-10-05 after the Task 5+6 review.)

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20261004120000_clients_intake_started_at.sql`:

```sql
-- Start of the lead's current intake run: stamped on client creation and on every
-- post-cooldown restart. The CRM-sheet mirror appends a NEW row when the lead's
-- newest sheet row predates it (one row per inquiry). NULL = pre-migration client;
-- code falls back to created_at.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS intake_started_at timestamptz;
```

- [ ] **Step 2: Mirror it in the consolidated schema**

In `db/schema.sql`, change the last column of `CREATE TABLE public.clients` from

```sql
  issue_description    text
);
```

to

```sql
  issue_description    text,

  -- Start of the lead's current intake run (creation + every post-cooldown restart).
  -- The CRM-sheet mirror appends a NEW row when the lead's newest row predates it.
  intake_started_at    timestamptz
);
```

- [ ] **Step 3: Verify the SQL parses**

Run (from repo root, no DB needed): `node -e "const s=require('fs').readFileSync('db/schema.sql','utf8'); if(!/intake_started_at\s+timestamptz\r?\n\);/.test(s)) {console.error('schema not updated'); process.exit(1)}; console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261004120000_clients_intake_started_at.sql db/schema.sql
git commit -m "feat(db): clients.intake_started_at — start of the lead's current inquiry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(The column is applied to the VPS in rollout step 2, **before the PR is merged**: the merge to `main` is the deploy.)

---

### Task 8: Rate-limiter exemption for Chatwoot + Zadarma webhooks (spec F3)

**Files:**
- Create: `Server/src/middleware/rate-limit-exempt.ts`, `Server/src/middleware/rate-limit-exempt.test.ts`
- Modify: `Server/src/server.ts:112`

**Interfaces:**
- Produces: `export function isRateLimitExempt(path: string): boolean` (path relative to the `/api` mount).

- [ ] **Step 1: Write the failing test**

Create `Server/src/middleware/rate-limit-exempt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isRateLimitExempt } from "./rate-limit-exempt.js";

describe("isRateLimitExempt", () => {
  it.each([
    "/whatsapp/webhook",
    "/whatsapp/meta-webhook",
    "/chatwoot/callback/test-path-secret",
    "/zadarma/call-webhook",
  ])("exempts %s", (path) => {
    expect(isRateLimitExempt(path)).toBe(true);
  });

  it.each(["/whatsapp/send", "/chatwoot", "/chatwoot/callback", "/operations/morning-digest/run", "/zadarma"])(
    "still limits %s",
    (path) => {
      expect(isRateLimitExempt(path)).toBe(false);
    },
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd Server && npx vitest run src/middleware/rate-limit-exempt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `Server/src/middleware/rate-limit-exempt.ts`:

```ts
// Inbound webhooks authenticate themselves (Meta HMAC, GreenAPI token, Chatwoot path
// secret, Zadarma IP gate) and arrive in bursts from a single IP — Chatwoot from
// localhost, Meta's status pings — so they bypass the per-IP /api limiter.
// Paths are relative to the /api mount; a trailing "/" means prefix match.
const EXEMPT = ["/whatsapp/webhook", "/whatsapp/meta-webhook", "/chatwoot/callback/", "/zadarma/call-webhook"];

export function isRateLimitExempt(path: string): boolean {
  return EXEMPT.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}
```

In `Server/src/server.ts` add the import next to the other middleware imports:

```ts
import { isRateLimitExempt } from "./middleware/rate-limit-exempt.js";
```

and replace line 112 with:

```ts
    skip: (req) => isRateLimitExempt(req.path),
```

- [ ] **Step 4: Run the test, typecheck**

Run: `cd Server && npx vitest run src/middleware/rate-limit-exempt.test.ts && npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add Server/src/middleware/rate-limit-exempt.ts Server/src/middleware/rate-limit-exempt.test.ts Server/src/server.ts
git commit -m "fix(server): exempt the Chatwoot and Zadarma webhooks from the per-IP /api limiter

Chatwoot posts every message event from 127.0.0.1; at 100 requests per 15 min
a busy morning could 429 an agent's reply, which Chatwoot does not retry.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: One-off backfill trigger (spec C)

**Files:**
- Modify: `Server/src/domains/integrations/google/leads-mirror.service.ts` (append)
- Modify: `Server/src/domains/operations/operations.controller.ts`, `operations.routes.ts`
- Test: `Server/src/domains/integrations/google/leads-mirror.test.ts`

**Interfaces:**
- Produces: `export async function backfillLeadDocuments(): Promise<{ clients: number }>`; `POST /api/operations/leads-backfill/run` (admin token) → `{ status: "success", clients }`.

- [ ] **Step 1: Write the failing test**

In `leads-mirror.test.ts`, change the existing import line to `import { mirrorLeadToSheet, backfillLeadDocuments } from "./leads-mirror.service.js";` and append:

```ts
// ---------------------------------------------------------------------------
// One-off backfill: re-mirror every client that has at least one document
// ---------------------------------------------------------------------------

describe("backfillLeadDocuments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertLeadRow.mockResolvedValue(true);
  });

  it("mirrors each distinct client once, in order", async () => {
    const docsList = makeBuilder({
      data: [{ client_id: "c1" }, { client_id: "c2" }, { client_id: "c1" }],
      error: null,
    });
    // After the documents listing, each mirrorLeadToSheet does clients → documents.
    setupFromSequence([
      docsList,
      makeBuilder({ data: clientRow({}), error: null }),
      makeBuilder(docsResult(["https://drive/a"])),
      makeBuilder({ data: clientRow({ phone: "972509999999" }), error: null }),
      makeBuilder(docsResult(["https://drive/b"])),
    ]);

    const result = await backfillLeadDocuments();

    expect(result).toEqual({ clients: 2 });
    expect(mockUpsertLeadRow).toHaveBeenCalledTimes(2);
    expect((mockUpsertLeadRow.mock.calls[0] as [string[]])[0][0]).toBe("972501234567");
    expect((mockUpsertLeadRow.mock.calls[1] as [string[]])[0][0]).toBe("972509999999");
  });

  it("no documents → nothing mirrored", async () => {
    setupFromSequence([makeBuilder({ data: [], error: null })]);
    const result = await backfillLeadDocuments();
    expect(result).toEqual({ clients: 0 });
    expect(mockUpsertLeadRow).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd Server && npx vitest run src/domains/integrations/google/leads-mirror.test.ts`
Expected: FAIL — `backfillLeadDocuments` is not exported.

- [ ] **Step 3: Implement**

Append to `leads-mirror.service.ts`:

```ts
/** Re-mirror every client that has at least one document (one-off, after the D-column change). */
export async function backfillLeadDocuments(): Promise<{ clients: number }> {
  const { data } = await supabaseAdmin.from("documents").select("client_id");
  const ids = [...new Set(((data ?? []) as { client_id: string }[]).map((d) => d.client_id))];
  for (const id of ids) {
    await mirrorLeadToSheet(id);
  }
  logger.info({ clients: ids.length }, "leads-mirror: backfill complete");
  return { clients: ids.length };
}
```

In `operations.controller.ts` add the import `import { backfillLeadDocuments } from "../integrations/google/leads-mirror.service.js";` and the handler:

```ts
  async runLeadsBackfill(_req: Request, res: Response): Promise<void> {
    logger.info("operations: manual leads-backfill trigger");
    const result = await backfillLeadDocuments();
    res.json({ status: "success", ...result });
  },
```

In `operations.routes.ts` add before `export default router;`:

```ts
router.post(
  "/leads-backfill/run",
  authenticate,
  authorize("admin"),
  operationsController.runLeadsBackfill,
);
```

- [ ] **Step 4: Run the tests, typecheck**

Run: `cd Server && npx vitest run src/domains/integrations/google/leads-mirror.test.ts && npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add Server/src/domains/integrations/google/leads-mirror.service.ts Server/src/domains/integrations/google/leads-mirror.test.ts Server/src/domains/operations/operations.controller.ts Server/src/domains/operations/operations.routes.ts
git commit -m "feat(ops): POST /api/operations/leads-backfill/run — re-mirror every lead with documents

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Docs

**Files:**
- Modify: `SYSTEM_FLOW.md` (header changelog; §2 "Media payload" paragraph; §3.1 `id_photo` bullet and `endFlow`/fresh-restart bullets; §7 "ID photo" write bullet; §10 "During intake" + "Lead row mirror" bullets)
- Modify: `.claude/CONVERSATIONAL_BOT.md` (gitignored; §3 table rows for `id_photo` and `done`, §5 lead mirror, §9 quirks)

- [ ] **Step 1: SYSTEM_FLOW.md**

Header (after the 2026-07-29 sentence in the opening blockquote) add:

> **2026-10-04 (lead ID capture v2):** every image a lead sends, at any step and even while the bot is paused, is silently run through the strict ID check (card + ספח in one photo); a valid ID fills the sheet's ID-number column, everything else is archived. Column D lists **every** Drive link (one per line); a returning lead gets a **new sheet row per inquiry** (`clients.intake_started_at`); voice notes/video/stickers/locations/contacts arrive as placeholders instead of being dropped; a menu tap right after the 24h cooldown is honoured.

§2 "Media payload" paragraph: append the sentence `Any other Meta type (audio/voice note, video, sticker, location, contacts, unknown) becomes {kind:"other", label} — stored with a Hebrew placeholder, mirrored to Chatwoot, and answered with the slot's normal re-prompt. Template quick-reply taps (type button) are treated as button taps. Only reaction and request_welcome are ignored.`

§3.1, replace the `id_photo` bullet's description of the check with: `validateIdPhoto() is STRICT (since 7e8ec05, 2026-07-14): the photo must show BOTH the תעודת זהות AND its ספח; the ID number is normalised as an Israeli ת"ז (8–9 digits, check digit) or left null; fullName is read from the ID. Invalid → the fixed Hebrew re-ask.` Then add a new bullet after `endFlow`:

- **Universal file capture (v2, 2026-10-04) — `ai/intake-media.ts` `captureLeadFile`, called from `inbound.pipeline.ts` right after `handleIntake` for every image/document from a linked client, detached, regardless of pause/kill-switch/slot. The only file it skips is an image the `id_photo` step took itself (`fileHandled`: that step uploads an accepted one and re-asks for a rejected one); a document at that step, or a file sent while the step is paused/off/skipped, is captured:** images (incl. photos sent as files) go through `validateIdPhoto`; a valid ID → Drive file `<OCR name> - ID.<ext>`, `documents.type='id_photo'`, `clients.id_photo_url` + `id_number` (if it passed the check digit) + `id_validated=true` + `full_name` upgraded; anything else → `documents.type='other'`. Every capture re-mirrors the sheet. The lead is never told anything by this path.

In the fresh-restart bullet add: `The restart stamps clients.intake_started_at; if the first post-cooldown message is a menu button (id or label) it is processed as that choice instead of re-sending the menu.`

§7 "ID photo" bullet: replace with `**Any file from a lead** → Google Drive + documents row (type id_photo / other); a verified ID also → clients.id_photo_url/id_number/id_validated/full_name. **Sheet column D** = every documents.file_url of the client, one per line (rebuilt on each sync, never deleted).`

§10: replace the "During intake" ID-photo bullet with the capture description above; in "Lead row mirror" replace the columns line with `A phone · B name · C inquiry · D every Drive link (newline-separated, wrap) · E ID number (check-digit verified) · F relevance · G creation date`, and add a bullet: `**One row per inquiry (2026-10-04):** upsertLeadRow matches the phone in canonical form (05x ≡ 972…) across the 3 tabs, picks the NEWEST row by col G, and updates it only if it was created at/after clients.intake_started_at (−1 min); otherwise it appends a fresh row. A 400/404 from Sheets wipes the leads_sheet_* cache and retries once. Backfill: POST /api/operations/leads-backfill/run.`

- [ ] **Step 2: .claude/CONVERSATIONAL_BOT.md**

In §3's table: the `id_photo` row keeps its text; add to the `done` row: `Fresh restart stamps intake_started_at; a menu tap as the first message after the cooldown is processed as the choice.` In §5 replace the 7-column line's D/E description with `D every Drive link for the lead (one per line, from documents) · E ID number (Israeli check digit)` and add `One row per inquiry: the mirror passes intake_started_at; the phone's newest row is updated only if it belongs to the current inquiry, else a new row is appended.` Add a §3b: `Universal silent file capture (2026-10-04): captureLeadFile runs from the inbound pipeline after handleIntake for every image/document, paused or not, except an image the id_photo step took itself; images go through the strict ID check; a valid ID fills id_number/full_name/id_validated and is named "<name> - ID"; nothing is said to the lead.` In §9 add: `Voice notes/video/stickers/locations/contacts → kind:"other" placeholder + normal re-prompt (were dropped before 2026-10-04).`

- [ ] **Step 3: Commit**

```bash
git add SYSTEM_FLOW.md
git commit -m "docs(flow): lead ID capture v2 — universal capture, D accumulates, one row per inquiry, placeholder types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(`.claude/CONVERSATIONAL_BOT.md` is gitignored; edit it in place, no commit.)

---

### Task 11: Integration pass

**Files:** none new.

- [ ] **Step 1: Full verification**

Run: `cd Server && npm run lint && npm run typecheck && npx vitest run`
Expected: lint clean, typecheck clean, every test file passes except the 3 pre-existing `src/__tests__/integration/*` files (env bootstrap). The passing count must be ≥ 710 + the tests added in Tasks 1–9.

- [ ] **Step 2: Spec coverage check (read-only)**

Confirm against the spec: A (Task 5 + 6), A.1 (Task 1), B (Task 6), C (Tasks 3, 4, 9), D (Tasks 3, 4, 6, 7), E (Task 2), F1/F2 (Task 3), F3 (Task 8), docs (Task 10). Anything missing → fix in its task's files and amend with a new commit.

- [ ] **Step 3: Build**

Run: `cd Server && npm run build`
Expected: `dist/` compiles with no errors.

---

## Rollout (manual, owner-driven — NOT part of the agent tasks)

1. **Publish only a history that never held the Chatwoot callback secret.** An early local revision of this plan carried the live `CHATWOOT_CALLBACK_SECRET` as a test path (the only credential on the unsigned Chatwoot callback). That commit stays local: the PR is a single squashed commit built from the final tree, which contains no secret. If that local history is ever pushed, rotate the secret first (new value in `.env` via `openssl rand -hex 24`, `set -a; source .env; set +a; pm2 restart insurance-api --update-env && pm2 save`, then point the Chatwoot webhook at `/api/chatwoot/callback/<new value>`). Open the PR into `main` and wait for CI (`lint-and-typecheck` green; the `test` job is red for the pre-existing integration suites).
2. **BINDING ORDER: on the VPS, apply the column BEFORE merging the PR.** The merge to `main` IS the deploy: the workflow pulls, builds and restarts on push. The new code names `intake_started_at` in the new-client INSERT and the restart UPDATE. Against the old schema, every new lead would get no reply and returning leads could not restart. The old code ignores the column, so applying it first is safe. Never add `DEFAULT now()`. Read-only elsewhere:
   `ssh deploy@187.127.224.73` → `cd /opt/app/Server && node -e "require('dotenv').config(); const {Client}=require('pg'); (async()=>{const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect(); await c.query('ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS intake_started_at timestamptz'); const r=await c.query(\"SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='intake_started_at'\"); console.log(r.rowCount===1?'ok':'MISSING'); await c.end();})()"` → must print `ok`. Do not go on to step 3 otherwise.
3. Only after step 2 printed `ok`: merge the PR → the deploy workflow pulls, builds and restarts `insurance-api` (verify `pm2 pid insurance-api` equals the pid on `:3000`). The workflow does not touch the schema, so step 2 is the only migration step; if the Action flakes, deploy by hand with the same commands.
4. Backfill once: `curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" https://srv1622531.hstgr.cloud/api/operations/leads-backfill/run` → expect `{"status":"success","clients":7}`; then read the sheet and check that every lead with several files now lists every link in column D, one per line, each clickable.
5. Live checks from a test phone: image during a cooldown → Drive + D within ~20 s; a second image → D has two lines; a voice note → "אנא בחר…" reply + `[הודעה קולית]` in Chatwoot; a returning test number tapping a button → a new row with today's date; grep pm2 for `intake-media: lead file archived` and `Meta message type not supported`, and confirm there is no `documents insert failed`, `not fully recorded` or `post-cooldown reset failed` line.
6. Clean up the test rows/files, then update the memory note and `SYSTEM_FLOW.md` status if anything differed.
