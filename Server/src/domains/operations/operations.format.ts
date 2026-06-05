export const TASK_LABELS_HE: Record<string, string> = {
  forms_check: "בדיקת טפסים",
  receipt_check: "בדיקת קבלה",
  policy_check: "בדיקת פוליסה",
  deposit_check: "בדיקת הפקדה",
  cross_check: "הצלבת מסמכים",
};

export function formatDueDate(iso: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}
