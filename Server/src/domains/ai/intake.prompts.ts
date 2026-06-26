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

export const INQUIRY_TYPE_HE: Record<InquiryType, string> = {
  life: "ביטוח חיים",
  health: "ביטוח בריאות",
  property: "ביטוח רכוש",
  vehicle: "ביטוח רכב",
  liability: "ביטוח חבות",
  business: "ביטוח עסקי",
  pension: "ביטוח פנסיוני",
  travel: "ביטוח נסיעות",
  mortgage: "ביטוח משכנתא",
  general: "כללי",
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
