// Small injectable delay helper — kept in its own module so callers can
// vi.mock("../../lib/sleep.js") in tests instead of waiting on real timers.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
