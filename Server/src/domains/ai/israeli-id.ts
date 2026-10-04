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
  // All zeros passes the checksum (sum 0) but is a model placeholder, never a real ת"ז.
  if (/^0+$/.test(padded)) return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const product = Number(padded[i]) * WEIGHTS[i]!;
    sum += product > 9 ? product - 9 : product;
  }
  return sum % 10 === 0 ? padded : null;
}
