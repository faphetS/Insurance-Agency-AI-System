// Serializes ALL writers to the leads spreadsheet (mirror upsert + relevance sweep run in
// this same process). Lock rule: ONLY top-level entry points take the lock (upsertLeadRow,
// sweepRelevanceMoves); internal helpers (appendLeadRow, formatDataRow, applyRelevanceDropdowns)
// must never acquire it or they would deadlock the chain.
let tail: Promise<void> = Promise.resolve();

export function withSheetLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(() => fn());
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
