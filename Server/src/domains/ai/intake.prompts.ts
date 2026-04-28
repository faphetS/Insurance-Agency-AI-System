export const INTAKE_PROMPTS = {
  welcome: {
    text: "Hi! Before we schedule your consultation, I need to collect a few details and documents. Let's start — what is your full name?",
  },
  full_name: { text: "What is your full name?" },
  email: { text: 'What is your email address? (reply "skip" to skip)' },
  inquiry_type: {
    text: "What type of insurance are you interested in?",
    buttons: [
      { buttonId: "life", buttonText: "Life" },
      { buttonId: "health", buttonText: "Health" },
      { buttonId: "vehicle", buttonText: "Vehicle" },
    ],
    footer:
      "Not listed? Reply: property, liability, business, pension, travel, mortgage, or general.",
  },
  id_photo: {
    text: "Please send a clear photo of your government-issued ID (front side). Make sure the text is readable.",
  },
  id_photo_invalid: {
    text: "I couldn't verify that ID photo — {reason}. Please send another clear photo of your ID.",
  },
  poa: {
    text: 'If you have a power of attorney document, please send it now. Otherwise reply "skip".',
  },
  done: {
    text: "Thanks! We have everything we need. We'll be in touch shortly to schedule your consultation.",
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
