import { describe, it, expect } from "vitest";
import {
  INQUIRY_TYPES,
  INQUIRY_TYPE_HE,
  INTAKE_PROMPTS,
  SLOT_ORDER,
} from "./intake.prompts.js";

describe("INQUIRY_TYPE_HE", () => {
  it("has an entry for every value in INQUIRY_TYPES (exhaustiveness)", () => {
    for (const type of INQUIRY_TYPES) {
      expect(INQUIRY_TYPE_HE).toHaveProperty(type);
      expect(typeof INQUIRY_TYPE_HE[type]).toBe("string");
      expect(INQUIRY_TYPE_HE[type]!.length).toBeGreaterThan(0);
    }
  });

  it("covers exactly the 7 insurance button ids", () => {
    expect(Object.keys(INQUIRY_TYPE_HE)).toHaveLength(INQUIRY_TYPES.length);
  });

  it("maps vehicle → ביטוח רכב", () => {
    expect(INQUIRY_TYPE_HE.vehicle).toBe("ביטוח רכב");
  });

  it("maps life_health_pension → ביטוח חיים/בריאות/פנסיה", () => {
    expect(INQUIRY_TYPE_HE.life_health_pension).toBe("ביטוח חיים/בריאות/פנסיה");
  });

  it("maps other → אחר", () => {
    expect(INQUIRY_TYPE_HE.other).toBe("אחר");
  });
});

describe("SLOT_ORDER — v4.1 slot machine", () => {
  it("is exactly the seven v4.1 slots in order (email between meeting_type and consent)", () => {
    expect([...SLOT_ORDER]).toEqual([
      "welcome",
      "menu",
      "meeting_type",
      "email",
      "consent",
      "id_photo",
      "done",
    ]);
  });
});

describe("INTAKE_PROMPTS.menu — 9-button opening", () => {
  it("has 9 buttons (7 insurance + callback + meeting)", () => {
    expect(INTAKE_PROMPTS.menu.buttons).toHaveLength(9);
  });

  it("keeps the 7 insurance buttonIds stable and adds callback_didi + meeting_didi", () => {
    const ids = INTAKE_PROMPTS.menu.buttons.map((b) => b.buttonId);
    expect(ids).toEqual([
      "vehicle",
      "home",
      "business",
      "life_health_pension",
      "travel",
      "finance",
      "other",
      "callback_didi",
      "meeting_didi",
    ]);
  });

  it("uses Didi's exact callback + meeting labels", () => {
    const byId = Object.fromEntries(INTAKE_PROMPTS.menu.buttons.map((b) => [b.buttonId, b.buttonText]));
    expect(byId["callback_didi"]).toBe("מבקש שדידי יחזור אליי");
    expect(byId["meeting_didi"]).toBe("בקשת תיאום פגישה עם דידי");
  });

  it("opening text is Didi's flowchart copy verbatim", () => {
    expect(INTAKE_PROMPTS.menu.text).toBe(
      "היי, הגעתם לשקד סוכנות לביטוח - דידי פרידלנדר. אנו שמחים שפנית אלינו באפשרותך לבצע מספר פעולות או להשאיר הודעה ונחזור אליך בהקדם אנא בחר מתפריט:",
    );
  });

  it("every menu button label is ≤ 25 chars (GreenAPI limit)", () => {
    for (const b of INTAKE_PROMPTS.menu.buttons) {
      expect(b.buttonText.length).toBeLessThanOrEqual(25);
    }
  });
});

describe("INTAKE_PROMPTS.meeting_type — existing/new sub-choice", () => {
  it("has לקוח קיים / לקוח חדש buttons, both ≤ 25 chars", () => {
    const ids = INTAKE_PROMPTS.meeting_type.buttons.map((b) => b.buttonId);
    expect(ids).toEqual(["existing_client", "new_client"]);
    const byId = Object.fromEntries(INTAKE_PROMPTS.meeting_type.buttons.map((b) => [b.buttonId, b.buttonText]));
    expect(byId["existing_client"]).toBe("לקוח קיים");
    expect(byId["new_client"]).toBe("לקוח חדש");
    for (const b of INTAKE_PROMPTS.meeting_type.buttons) {
      expect(b.buttonText.length).toBeLessThanOrEqual(25);
    }
  });
});

describe("INTAKE_PROMPTS.consent — tap-only מאשר", () => {
  it("has a single מאשר button (id consent_approve), ≤ 25 chars", () => {
    expect(INTAKE_PROMPTS.consent.buttons).toHaveLength(1);
    expect(INTAKE_PROMPTS.consent.buttons[0]!.buttonId).toBe("consent_approve");
    expect(INTAKE_PROMPTS.consent.buttons[0]!.buttonText).toBe("מאשר");
    expect(INTAKE_PROMPTS.consent.buttons[0]!.buttonText.length).toBeLessThanOrEqual(25);
  });

  it("consent text is Didi's flowchart copy verbatim", () => {
    expect(INTAKE_PROMPTS.consent.text).toBe(
      "רגע לפני תיאום הפגישה, כדי שנהיה מוכנים היטב לקראת פגישתנו אנו זקוקים לאישורך להזמנת נתונים ממסלקה פנסיונית והר הביטוח.",
    );
  });
});

describe("INTAKE_PROMPTS — terminal + re-prompt copy", () => {
  it("thanks/menu re-prompt/consent re-prompt/id request use the approved strings", () => {
    expect(INTAKE_PROMPTS.thanks_menu.text).toBe(
      "תודה על פנייתך! קיבלנו את הפרטים וניצור איתך קשר בהקדם.",
    );
    expect(INTAKE_PROMPTS.thanks_callback.text).toBe(
      "תודה! הפרטים הועברו לדידי והוא יחזור אליך בהקדם.",
    );
    expect(INTAKE_PROMPTS.menu_reprompt.text).toBe("אנא בחר אחת מהאפשרויות בתפריט למעלה");
    expect(INTAKE_PROMPTS.consent_reprompt.text).toBe('כדי להמשיך, יש ללחוץ על כפתור "מאשר"');
    expect(INTAKE_PROMPTS.email.text).toBe("מה כתובת המייל שלך?");
    expect(INTAKE_PROMPTS.email_reprompt.text).toBe(
      "לא זיהינו כתובת מייל תקינה. נא לשלוח כתובת מייל, לדוגמה: name@example.com",
    );
    expect(INTAKE_PROMPTS.id_photo.text).toBe(
      "תודה, לצורך הזמנת הנתונים נשמח לקבל צילום תעודת הזהות שלך (כולל ספח)",
    );
    expect(INTAKE_PROMPTS.done_new.text).toBe(
      "תודה רבה! קיבלנו את כל הפרטים. לקביעת הפגישה, ניתן לבחור מועד נוח בקישור הבא:",
    );
  });
});
