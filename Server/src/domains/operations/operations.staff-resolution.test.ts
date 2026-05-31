import { describe, it, expect } from "vitest";

// The staff-resolution rule used across the codebase:
// assigned_handler_id takes priority; fall back to assigned_to.
// This helper mirrors the inline logic in operations.digest.ts (agentOf),
// operations.service.ts (createTaskChain), and operations.staff-notify.ts.
function resolveStaffId(client: {
  assigned_handler_id: string | null;
  assigned_to: string | null;
}): string | null {
  return client.assigned_handler_id ?? client.assigned_to ?? null;
}

describe("staff resolution rule (assigned_handler_id ?? assigned_to)", () => {
  it("returns assigned_handler_id when both are set", () => {
    expect(
      resolveStaffId({ assigned_handler_id: "handler-1", assigned_to: "agent-2" }),
    ).toBe("handler-1");
  });

  it("falls back to assigned_to when assigned_handler_id is null", () => {
    expect(
      resolveStaffId({ assigned_handler_id: null, assigned_to: "agent-2" }),
    ).toBe("agent-2");
  });

  it("returns null when both are null", () => {
    expect(
      resolveStaffId({ assigned_handler_id: null, assigned_to: null }),
    ).toBeNull();
  });

  it("returns assigned_handler_id even when assigned_to is null", () => {
    expect(
      resolveStaffId({ assigned_handler_id: "handler-1", assigned_to: null }),
    ).toBe("handler-1");
  });
});
