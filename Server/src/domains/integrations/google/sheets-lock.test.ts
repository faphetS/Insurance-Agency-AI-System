import { describe, it, expect } from "vitest";
import { withSheetLock } from "./sheets-lock.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("withSheetLock", () => {
  it("runs two concurrent calls strictly in order — the second waits for the first to settle", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = withSheetLock(async () => {
      order.push("first-start");
      await first.promise;
      order.push("first-end");
    });

    const p2 = withSheetLock(async () => {
      order.push("second-start");
    });

    // fn2 cannot run until fn1's promise settles — this is structural, not a timing race.
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    first.resolve();
    await p1;
    await p2;

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("a rejecting fn propagates to its own caller but does not block the next queued fn", async () => {
    const p1 = withSheetLock(async () => {
      throw new Error("boom");
    });

    let secondRan = false;
    const p2 = withSheetLock(async () => {
      secondRan = true;
      return "ok";
    });

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(secondRan).toBe(true);
  });

  it("passes through the resolved value of fn", async () => {
    const result = await withSheetLock(async () => 42);
    expect(result).toBe(42);
  });

  it("runs three queued calls in strict FIFO order regardless of individual durations", async () => {
    const order: number[] = [];

    const p1 = withSheetLock(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    const p2 = withSheetLock(async () => {
      order.push(2);
    });
    const p3 = withSheetLock(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});
