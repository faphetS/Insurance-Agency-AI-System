export const INTAKE_PROMPTS = {
  welcome: {
    text1: "שלום! לפני קביעת הפגישה, נדרשים מספר פרטים ומסמכים. בואו נתחיל",
    text2: "מהו השם המלא?",
  },
  client_type: {
    text: "היי, הגעתם לשקד סוכנות לביטוח - דידי פרידלנדר. נשמח לעזור לך! כדי שנוכל להפנות אותך לגורם המתאים, אנא בחר/י:",
    buttons: [
      { buttonId: "old_client", buttonText: "אני לקוח/ה קיים/ת" },
      { buttonId: "new_client", buttonText: "אני עדיין לא לקוח/ה" },
    ],
  },
  full_name: { text: "מהו השם המלא?" },
  email: { text: "מהי כתובת האימייל?" },
  inquiry_type: {
    text: "כדי שנוכל לתת לך את המענה המדויק ביותר, באיזה נושא נוכל לעזור לך היום? אנא בחר/י מהרשימה",
    buttons: [
      { buttonId: "vehicle", buttonText: "ביטוח רכב" },
      { buttonId: "home", buttonText: "ביטוח דירה" },
      { buttonId: "business", buttonText: "ביטוח עסקים" },
      { buttonId: "life_health_pension", buttonText: 'ביטוח חיים/בריאות/פנסיה' },
      { buttonId: "travel", buttonText: 'ביטוח נסיעות לחו"ל' },
      { buttonId: "finance", buttonText: "פיננסים" },
      { buttonId: "other", buttonText: "אחר" },
    ],
  },
  issue: {
    text: "אנא ספר/י לנו מהי הבעיה או הנושא שבו תרצה/י שנעזור לך.",
  },
  action_choice: {
    text: "מה תרצה/י לעשות?",
    buttons: [
      { buttonId: "move_to_rep", buttonText: "מעבר לנציג/ה" },
      { buttonId: "schedule_meeting", buttonText: "קביעת פגישה" },
    ],
  },
  rep_ack: {
    text: "מצוין, העברנו את הפרטים לנציג/ה הרלוונטי/ת — ניצור איתך קשר בהקדם. תודה! 🙏",
  },
  id_photo: {
    text: "נא לשלוח תמונה ברורה של תעודת הזהות (הצד הקדמי). חשוב שהטקסט יהיה קריא.",
  },
  id_photo_invalid: {
    text: "לא ניתן לאמת את תמונת תעודת הזהות — {reason}. נא לשלוח תמונה נוספת וברורה של תעודת הזהות.",
  },
  poa: {
    text: 'במידה ויש מסמך ייפוי כוח, נא לשלוח אותו כעת. אחרת, יש להשיב "דלג".',
  },
  done: {
    text: "תודה! התקבלו כל הפרטים הנדרשים. ייווצר קשר בהקדם לקביעת הפגישה.",
  },
  done_existing: {
    text: "לקביעת פגישה, ניתן לבחור מועד נוח בקישור הבא:",
  },
} as const;

export const INQUIRY_TYPES = [
  "vehicle",
  "home",
  "business",
  "life_health_pension",
  "travel",
  "finance",
  "other",
] as const;

export type InquiryType = (typeof INQUIRY_TYPES)[number];

export const INQUIRY_TYPE_HE: Record<string, string> = {
  vehicle: "ביטוח רכב",
  home: "ביטוח דירה",
  business: "ביטוח עסקים",
  life_health_pension: "ביטוח חיים/בריאות/פנסיה",
  travel: 'ביטוח נסיעות לחו"ל',
  finance: "פיננסים",
  other: "אחר",
};

// Linear new-client slot order. `issue` and `action_choice` are old-client
// branch-only terminals resolved via INTAKE_PROMPTS lookup in advanceTo —
// they are intentionally absent from this array.
export const SLOT_ORDER = [
  "welcome",
  "client_type",
  "inquiry_type",
  "full_name",
  "email",
  "id_photo",
  "poa",
  "done",
] as const;

export type IntakeSlot =
  | (typeof SLOT_ORDER)[number]
  | "issue"
  | "action_choice";
