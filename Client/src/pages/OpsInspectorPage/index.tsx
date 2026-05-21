import { useState } from "react";
import { ServiceMeetingsSection } from "./sections/ServiceMeetingsSection";
import { MeetingSummariesSection } from "./sections/MeetingSummariesSection";
import { TimelessSection } from "./sections/TimelessSection";
import { BafiSection } from "./sections/BafiSection";
import { EmailStatusSection } from "./sections/EmailStatusSection";
import { WhatsAppStatusSection } from "./sections/WhatsAppStatusSection";

type Section =
  | "service-meetings"
  | "meeting-summaries"
  | "timeless"
  | "bafi"
  | "email"
  | "whatsapp";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "service-meetings", label: "Service Meetings" },
  { key: "meeting-summaries", label: "Meeting Summaries" },
  { key: "timeless", label: "Timeless" },
  { key: "bafi", label: "BAFI" },
  { key: "email", label: "Email Status" },
  { key: "whatsapp", label: "WhatsApp Status" },
];

export default function OpsInspectorPage() {
  const [active, setActive] = useState<Section>("service-meetings");

  return (
    <div className="min-h-screen bg-white">
      <div className="border-b border-gray-300 bg-gray-50 px-4 py-3 flex items-center gap-4">
        <span className="font-bold text-sm">Ops Inspector</span>
        <a href="/" className="text-xs text-blue-600 underline">
          Back to Dashboard
        </a>
      </div>

      <div className="flex">
        <nav className="w-44 shrink-0 border-r border-gray-300 min-h-screen p-2">
          {SECTIONS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActive(key)}
              className={`block w-full text-left px-2 py-1.5 text-sm rounded mb-0.5 ${
                active === key ? "bg-gray-200 font-semibold" : "hover:bg-gray-100"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-auto">
          <div className="border-b border-gray-200 bg-gray-50 px-4 py-2">
            <h1 className="text-sm font-bold">
              {SECTIONS.find((s) => s.key === active)?.label}
            </h1>
          </div>

          {active === "service-meetings" && <ServiceMeetingsSection />}
          {active === "meeting-summaries" && <MeetingSummariesSection />}
          {active === "timeless" && <TimelessSection />}
          {active === "bafi" && <BafiSection />}
          {active === "email" && <EmailStatusSection />}
          {active === "whatsapp" && <WhatsAppStatusSection />}
        </main>
      </div>
    </div>
  );
}
