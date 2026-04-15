export const INTAKE_PROMPTS = {
  full_name: { text: "Hi! What is your full name?" },
  email: { text: 'What is your email? (reply "skip" to skip)' },
  inquiry_type: {
    text: "What is your inquiry type?",
    buttons: [
      { buttonId: "life", buttonText: "Life" },
      { buttonId: "health", buttonText: "Health" },
      { buttonId: "vehicle", buttonText: "Vehicle" },
    ],
    footer:
      "Not shown? Reply: property, liability, business, pension, travel, mortgage, or general.",
  },
  id_photo: { text: "Please send a photo of your ID." },
  poa: {
    text: 'Please send your power of attorney document. (reply "skip" to skip)',
  },
  done: { text: "Thanks, we've received your details." },
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

// Slot order
export const SLOT_ORDER = [
  "full_name",
  "email",
  "inquiry_type",
  "id_photo",
  "poa",
  "done",
] as const;

export type IntakeSlot = (typeof SLOT_ORDER)[number];
