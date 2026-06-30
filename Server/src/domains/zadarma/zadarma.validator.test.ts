import { describe, it, expect } from "vitest";
import { normalizePhone, mapZadarmaEvent } from "./zadarma.validator.js";

// ---------------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------------

describe("normalizePhone", () => {
  it("strips leading + and formatting from E.164", () => {
    expect(normalizePhone("+972525628632")).toBe("972525628632");
  });

  it("converts Israeli national format (leading 0) to 972", () => {
    expect(normalizePhone("0525628632")).toBe("972525628632");
  });

  it("leaves already-canonical digits untouched", () => {
    expect(normalizePhone("972525628632")).toBe("972525628632");
  });

  it("strips 00 international prefix", () => {
    expect(normalizePhone("00972525628632")).toBe("972525628632");
  });

  it("strips formatting characters before normalising", () => {
    expect(normalizePhone("+972-52-562-8632")).toBe("972525628632");
  });

  it("handles 0xx with spaces", () => {
    expect(normalizePhone("052 562 8632")).toBe("972525628632");
  });
});

// ---------------------------------------------------------------------------
// mapZadarmaEvent — ignored events
// ---------------------------------------------------------------------------

describe("mapZadarmaEvent — ignored events", () => {
  it("returns null for NOTIFY_START", () => {
    expect(mapZadarmaEvent({ event: "NOTIFY_START", pbx_call_id: "abc" })).toBeNull();
  });

  it("returns null for NOTIFY_INTERNAL", () => {
    expect(mapZadarmaEvent({ event: "NOTIFY_INTERNAL", pbx_call_id: "abc" })).toBeNull();
  });

  it("returns null when event is missing", () => {
    expect(mapZadarmaEvent({ pbx_call_id: "abc" })).toBeNull();
  });

  it("returns null when pbx_call_id is missing on NOTIFY_END", () => {
    expect(mapZadarmaEvent({ event: "NOTIFY_END", caller_id: "+972501234567" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapZadarmaEvent — direction
// ---------------------------------------------------------------------------

describe("mapZadarmaEvent — direction", () => {
  it("maps NOTIFY_END → incoming", () => {
    const row = mapZadarmaEvent({
      event: "NOTIFY_END",
      pbx_call_id: "in_abc",
      caller_id: "+972501234567",
      disposition: "cancel",
    });
    expect(row?.direction).toBe("incoming");
  });

  it("maps NOTIFY_OUT_END → outgoing", () => {
    const row = mapZadarmaEvent({
      event: "NOTIFY_OUT_END",
      pbx_call_id: "out_abc",
      destination: "+972509876543",
      disposition: "answered",
    });
    expect(row?.direction).toBe("outgoing");
  });
});

// ---------------------------------------------------------------------------
// mapZadarmaEvent — disposition → status
// ---------------------------------------------------------------------------

describe("mapZadarmaEvent — status from disposition", () => {
  const base = { event: "NOTIFY_END" as const, pbx_call_id: "x", caller_id: "+972501234567" };

  it("answered → accepted", () => {
    expect(mapZadarmaEvent({ ...base, disposition: "answered" })?.status).toBe("accepted");
  });

  it("cancel → missed", () => {
    expect(mapZadarmaEvent({ ...base, disposition: "cancel" })?.status).toBe("missed");
  });

  it("no answer → missed", () => {
    expect(mapZadarmaEvent({ ...base, disposition: "no answer" })?.status).toBe("missed");
  });

  it("busy → missed", () => {
    expect(mapZadarmaEvent({ ...base, disposition: "busy" })?.status).toBe("missed");
  });

  it("failed → missed", () => {
    expect(mapZadarmaEvent({ ...base, disposition: "failed" })?.status).toBe("missed");
  });

  it("no money → missed", () => {
    expect(mapZadarmaEvent({ ...base, disposition: "no money" })?.status).toBe("missed");
  });

  it("unallocated number → missed", () => {
    expect(mapZadarmaEvent({ ...base, disposition: "unallocated number" })?.status).toBe("missed");
  });

  it("unknown disposition → missed (default)", () => {
    expect(mapZadarmaEvent({ ...base, disposition: "something_new" })?.status).toBe("missed");
  });

  it("missing disposition → missed", () => {
    expect(mapZadarmaEvent({ ...base })?.status).toBe("missed");
  });
});

// ---------------------------------------------------------------------------
// mapZadarmaEvent — phone normalisation on the row
// ---------------------------------------------------------------------------

describe("mapZadarmaEvent — counterpart_phone normalisation", () => {
  it("incoming: uses caller_id normalised", () => {
    const row = mapZadarmaEvent({
      event: "NOTIFY_END",
      pbx_call_id: "in_1",
      caller_id: "+972525628632",
      disposition: "cancel",
    });
    expect(row?.counterpart_phone).toBe("972525628632");
  });

  it("incoming: normalises 0xx national format from caller_id", () => {
    const row = mapZadarmaEvent({
      event: "NOTIFY_END",
      pbx_call_id: "in_2",
      caller_id: "0525628632",
      disposition: "cancel",
    });
    expect(row?.counterpart_phone).toBe("972525628632");
  });

  it("outgoing: uses destination when present", () => {
    const row = mapZadarmaEvent({
      event: "NOTIFY_OUT_END",
      pbx_call_id: "out_1",
      destination: "+972509876543",
      called_did: "972559397252",
      disposition: "answered",
    });
    expect(row?.counterpart_phone).toBe("972509876543");
  });

  it("outgoing: falls back to called_did when destination absent", () => {
    const row = mapZadarmaEvent({
      event: "NOTIFY_OUT_END",
      pbx_call_id: "out_2",
      called_did: "972559397252",
      disposition: "answered",
    });
    expect(row?.counterpart_phone).toBe("972559397252");
  });
});

// ---------------------------------------------------------------------------
// mapZadarmaEvent — fixed fields
// ---------------------------------------------------------------------------

describe("mapZadarmaEvent — fixed fields", () => {
  const row = mapZadarmaEvent({
    event: "NOTIFY_END",
    pbx_call_id: "in_fixed",
    caller_id: "+972501234567",
    call_start: "2026-06-30 15:26:41",
    disposition: "cancel",
  });

  it("id_message = pbx_call_id", () => {
    expect(row?.id_message).toBe("in_fixed");
  });

  it("id_instance = 'zadarma'", () => {
    expect(row?.id_instance).toBe("zadarma");
  });

  it("is_video = false", () => {
    expect(row?.is_video).toBe(false);
  });

  it("parses call_start as UTC Date", () => {
    expect(row?.called_at).toBeInstanceOf(Date);
    expect(row?.called_at.toISOString()).toBe("2026-06-30T15:26:41.000Z");
  });

  it("falls back to now() when call_start is absent", () => {
    const before = Date.now();
    const r = mapZadarmaEvent({
      event: "NOTIFY_END",
      pbx_call_id: "in_no_start",
      caller_id: "+972501234567",
    });
    const after = Date.now();
    expect(r?.called_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(r?.called_at.getTime()).toBeLessThanOrEqual(after);
  });

  it("falls back to now() when call_start is invalid", () => {
    const before = Date.now();
    const r = mapZadarmaEvent({
      event: "NOTIFY_END",
      pbx_call_id: "in_bad_start",
      caller_id: "+972501234567",
      call_start: "not-a-date",
    });
    const after = Date.now();
    expect(r?.called_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(r?.called_at.getTime()).toBeLessThanOrEqual(after);
  });
});
