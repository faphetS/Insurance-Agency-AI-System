export const INTAKE_PROMPTS = {
  welcome: {
    text1: "שלום! לפני קביעת הפגישה, נדרשים מספר פרטים ומסמכים. בואו נתחיל",
    text2: "מהו השם המלא?",
  },
  full_name: { text: "מהו השם המלא?" },
  email: { text: "מהי כתובת האימייל?" },
  inquiry_type: {
    text: "באיזה סוג ביטוח יש עניין?",
    buttons: [
      { buttonId: "life", buttonText: "ביטוח חיים" },
      { buttonId: "health", buttonText: "ביטוח בריאות" },
      { buttonId: "vehicle", buttonText: "ביטוח רכב" },
    ],
    footer:
      "לא ברשימה? יש להשיב: רכוש, חבות, עסקי, פנסיה, נסיעות, משכנתא, או כללי.",
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
} as const;

export const INQUIRY_TYPES = [
  "life",
  "health",
  "property",
  "vehicle",
  "liability",
  "business",
  "pension",
  "travel",
  "mortgage",
  "general",
] as const;

export type InquiryType = (typeof INQUIRY_TYPES)[number];

export const SLOT_ORDER = [
  "welcome",
  "full_name",
  "email",
  "inquiry_type",
  "id_photo",
  "poa",
  "done",
] as const;

export type IntakeSlot = (typeof SLOT_ORDER)[number];
