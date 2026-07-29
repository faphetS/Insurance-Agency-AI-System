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

const INQUIRY_BUTTONS = [
  { buttonId: "vehicle", buttonText: "ביטוח רכב" },
  { buttonId: "home", buttonText: "ביטוח דירה" },
  { buttonId: "business", buttonText: "ביטוח עסקים" },
  { buttonId: "life_health_pension", buttonText: "ביטוח חיים/בריאות/פנסיה" },
  { buttonId: "travel", buttonText: 'ביטוח נסיעות לחו"ל' },
  { buttonId: "finance", buttonText: "פיננסים" },
] as const;

export const INTAKE_PROMPTS = {
  // Opening menu — Didi's flowchart text verbatim + 8 buttons (brand image sent as a 2nd bubble).
  menu: {
    text:
      "היי, הגעתם לשקד סוכנות לביטוח - דידי פרידלנדר. אנו שמחים שפנית אלינו באפשרותך לבצע מספר פעולות או להשאיר הודעה ונחזור אליך בהקדם אנא בחר מתפריט:",
    buttons: [
      ...INQUIRY_BUTTONS,
      { buttonId: "callback_didi", buttonText: "אשמח שדידי יחזור אליי" },
      { buttonId: "meeting_didi", buttonText: "בקשת תיאום פגישה עם דידי" },
    ],
  },
  // Button 8 sub-choice: existing vs new client.
  meeting_type: {
    text: "כדי שנוכל לסייע לך בצורה הטובה ביותר בתיאום ייעוץ מקצועי, אנא בחר:",
    buttons: [
      { buttonId: "existing_client", buttonText: "לקוח קיים" },
      { buttonId: "new_client", buttonText: "לקוח חדש" },
    ],
  },
  // Email step — both existing and new clients pass through it before their branch (v4.1).
  email: {
    text: "מה כתובת המייל שלך?",
  },
  email_reprompt: {
    text: "לא זיהינו כתובת מייל תקינה. נא לשלוח כתובת מייל, לדוגמה: name@example.com",
  },
  // Consent step (new client) — single מאשר button; only the TAP advances.
  consent: {
    text:
      "רגע לפני תיאום הפגישה, כדי שנהיה מוכנים היטב לקראת פגישתנו אנו זקוקים לאישורך להזמנת נתונים ממסלקה פנסיונית והר הביטוח.",
    buttons: [{ buttonId: "consent_approve", buttonText: "מאשר" }],
  },
  consent_reprompt: {
    text: 'כדי להמשיך, יש ללחוץ על כפתור "מאשר"',
  },
  menu_reprompt: {
    text: "אנא בחר אחת מהאפשרויות בתפריט למעלה",
  },
  id_photo: {
    text: "תודה, לצורך הזמנת הנתונים נשמח לקבל צילום תעודת הזהות שלך (כולל ספח)",
  },
  id_photo_invalid: {
    text: "לא הצלחנו לאמת את תעודת הזהות. נא לשלוח תמונה אחת וברורה הכוללת גם את תעודת הזהות וגם את הספח.",
  },
  thanks_menu: {
    text: "תודה על פנייתך! קיבלנו את הפרטים וניצור איתך קשר בהקדם.",
  },
  thanks_callback: {
    text: "תודה! הפרטים הועברו לדידי והוא יחזור אליך בהקדם.",
  },
  done_existing: {
    text: "לקביעת פגישה, ניתן לבחור מועד נוח בקישור הבא:",
  },
  done_new: {
    text: "תודה רבה! קיבלנו את כל הפרטים. לקביעת הפגישה, ניתן לבחור מועד נוח בקישור הבא:",
  },
} as const;

export const SLOT_ORDER = [
  "welcome",
  "menu",
  "meeting_type",
  "email",
  "consent",
  "id_photo",
  "done",
] as const;

export type IntakeSlot = (typeof SLOT_ORDER)[number];
