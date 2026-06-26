export const INTAKE_PROMPTS = {
  welcome: {
    text1: "שלום! לפני קביעת הפגישה, נדרשים מספר פרטים ומסמכים. בואו נתחיל",
    text2: "מהו השם המלא?",
  },
  client_type: {
    text: "שלום, תודה שפנית אלינו 🙏",
    buttons: [
      { buttonId: "new_client", buttonText: "New client" },
      { buttonId: "old_client", buttonText: "Old client" },
    ],
  },
  team_routing: {
    text: "פנית לצוות שלנו — כיצד נוכל לעזור לך?",
    buttons: [
      { buttonId: "team_y", buttonText: "Team Y" },
      { buttonId: "team_z", buttonText: "Team Z" },
      { buttonId: "contact_didi", buttonText: "Contact Didi" },
      { buttonId: "stay", buttonText: "Stay" },
    ],
  },
  full_name: { text: "מהו השם המלא?" },
  email: { text: "מהי כתובת האימייל?" },
  inquiry_type: {
    text: "באיזה סוג ביטוח יש עניין?",
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

export const SLOT_ORDER = [
  "welcome",
  "client_type",
  "team_routing",
  "full_name",
  "email",
  "inquiry_type",
  "id_photo",
  "poa",
  "done",
] as const;

export type IntakeSlot = (typeof SLOT_ORDER)[number];
