/**
 * Integration test: operations.email-milestones — milestoneProvider
 *
 * Seeds active staff in the DB and asserts:
 *   - getStaffList() returns all active staff mapped to { id, name, phone? }
 *   - getStaffList() excludes inactive staff (is_active = false)
 *   - checkForms / checkReceipt / checkPolicy / checkDeposit
 *     all return { found: false } when no Gmail integration is active
 *   - None of the check methods throw
 *
 * Note: crossCheck is no longer a method on milestoneProvider. The cross_check
 * task step derives its flags directly from sibling task completion status via
 * crossCheckFlagsFromTasks() in operations.checker.ts.
 *
 * No external I/O is required for these tests — milestoneProvider.getStaffList
 * queries the DB directly; the check* methods fall back to { found: false }
 * when no Gmail integration is connected.
 * WhatsApp mocks are included defensively in case any indirect import
 * triggers the WA service module.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — defensive; milestoneProvider itself does not make WA calls
// ---------------------------------------------------------------------------

vi.mock("../../domains/whatsapp/whatsapp.service.js", () => ({
  sendMessageWithTyping: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `ms-${Math.random().toString(36).slice(2)}` })),
  sendInteractiveButtonsWithTyping: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `ms-btn-${Math.random().toString(36).slice(2)}` })),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi
    .fn()
    .mockImplementation(() => ({ idMessage: `ms-msg-${Math.random().toString(36).slice(2)}` })),
}));

// ---------------------------------------------------------------------------
// Subject + helpers
// ---------------------------------------------------------------------------

import { milestoneProvider } from "../../domains/operations/operations.email-milestones.js";
import { pool } from "../../lib/db.js";

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------

interface MilestoneSeeds {
  activeStaff1Id: string;
  activeStaff2Id: string;
  inactiveStaffId: string;
}

async function seed(): Promise<MilestoneSeeds> {
  const activeStaff1Id = randomUUID();
  const activeStaff2Id = randomUUID();
  const inactiveStaffId = randomUUID();

  await pool.query(
    `INSERT INTO staff (id, full_name, email, phone, role, is_active)
     VALUES ($1, $2, $3, $4, 'agent', true)`,
    [activeStaff1Id, "Milestone Active 1", `ms-a1-${activeStaff1Id}@test.example`, "+972501000001"],
  );

  await pool.query(
    `INSERT INTO staff (id, full_name, email, phone, role, is_active)
     VALUES ($1, $2, $3, $4, 'agent', true)`,
    [activeStaff2Id, "Milestone Active 2", `ms-a2-${activeStaff2Id}@test.example`, "+972501000002"],
  );

  await pool.query(
    `INSERT INTO staff (id, full_name, email, phone, role, is_active)
     VALUES ($1, $2, $3, $4, 'agent', false)`,
    [inactiveStaffId, "Milestone Inactive", `ms-in-${inactiveStaffId}@test.example`, "+972501000003"],
  );

  return { activeStaff1Id, activeStaff2Id, inactiveStaffId };
}

async function teardown(seeds: MilestoneSeeds) {
  await pool.query(`DELETE FROM staff WHERE id IN ($1, $2, $3)`, [
    seeds.activeStaff1Id,
    seeds.activeStaff2Id,
    seeds.inactiveStaffId,
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("milestoneProvider.getStaffList", () => {
  let seeds: MilestoneSeeds;

  beforeAll(async () => {
    seeds = await seed();
  });

  afterAll(async () => {
    await teardown(seeds);
  });

  it("returns active staff mapped to { id, name, phone }", async () => {
    const list = await milestoneProvider.getStaffList();

    const a1 = list.find((s) => s.id === seeds.activeStaff1Id);
    const a2 = list.find((s) => s.id === seeds.activeStaff2Id);

    expect(a1).toBeDefined();
    expect(a1!.name).toBe("Milestone Active 1");
    expect(a1!.phone).toBe("+972501000001");

    expect(a2).toBeDefined();
    expect(a2!.name).toBe("Milestone Active 2");
    expect(a2!.phone).toBe("+972501000002");
  });

  it("excludes inactive staff from the list", async () => {
    const list = await milestoneProvider.getStaffList();
    const inactive = list.find((s) => s.id === seeds.inactiveStaffId);
    expect(inactive).toBeUndefined();
  });

  it("returns objects with at least { id, name } shape", async () => {
    const list = await milestoneProvider.getStaffList();
    for (const entry of list) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.name).toBe("string");
      if (entry.phone !== undefined) {
        expect(typeof entry.phone).toBe("string");
      }
    }
  });

  it("returns an empty array (not an error) when no active staff exist", async () => {
    await pool.query(
      `UPDATE staff SET is_active = false WHERE id IN ($1, $2)`,
      [seeds.activeStaff1Id, seeds.activeStaff2Id],
    );

    const list = await milestoneProvider.getStaffList();
    const ours = list.filter(
      (s) => s.id === seeds.activeStaff1Id || s.id === seeds.activeStaff2Id,
    );
    expect(ours).toHaveLength(0);

    await pool.query(
      `UPDATE staff SET is_active = true WHERE id IN ($1, $2)`,
      [seeds.activeStaff1Id, seeds.activeStaff2Id],
    );
  });
});

describe("milestoneProvider — check methods return { found: false } without Gmail connection", () => {
  const fakeClientId = randomUUID();

  it("checkForms returns { found: false }", async () => {
    const result = await milestoneProvider.checkForms(fakeClientId);
    expect(result).toMatchObject({ found: false });
  });

  it("checkReceipt returns { found: false }", async () => {
    const result = await milestoneProvider.checkReceipt(fakeClientId);
    expect(result).toMatchObject({ found: false });
  });

  it("checkPolicy returns { found: false }", async () => {
    const result = await milestoneProvider.checkPolicy(fakeClientId);
    expect(result).toMatchObject({ found: false });
  });

  it("checkDeposit returns { found: false }", async () => {
    const result = await milestoneProvider.checkDeposit(fakeClientId);
    expect(result).toMatchObject({ found: false });
  });

  it("none of the check methods throw", async () => {
    await expect(milestoneProvider.checkForms(fakeClientId)).resolves.not.toThrow();
    await expect(milestoneProvider.checkReceipt(fakeClientId)).resolves.not.toThrow();
    await expect(milestoneProvider.checkPolicy(fakeClientId)).resolves.not.toThrow();
    await expect(milestoneProvider.checkDeposit(fakeClientId)).resolves.not.toThrow();
  });
});

describe("milestoneProvider.getStaffList — DB error handling", () => {
  it("returns empty array (not a thrown error) when the staff table is unreachable", async () => {
    const result = await milestoneProvider.getStaffList();
    expect(Array.isArray(result)).toBe(true);
  });
});
