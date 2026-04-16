const STORAGE_KEY = "__auth_debug";
const MAX_ENTRIES = 50;

export type AuthDebugEntry = {
  ts: number;
  event: string;
  detail?: unknown;
  href: string;
};

export function logAuth(event: string, detail?: unknown): void {
  console.debug("[auth]", event, detail);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const entries: AuthDebugEntry[] = raw ? (JSON.parse(raw) as AuthDebugEntry[]) : [];
    entries.push({ ts: Date.now(), event, detail, href: location.href });
    const trimmed = entries.slice(-MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage failures must not break the app
  }
}

export function getAuthDebugLog(): AuthDebugEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AuthDebugEntry[];
  } catch {
    return [];
  }
}

export function clearAuthDebugLog(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
