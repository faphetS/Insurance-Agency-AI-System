import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export const Drawer = ({ open, onClose, title, subtitle, children }: DrawerProps) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto bg-white shadow-2xl transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-neutral-200 bg-white px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-neutral-900">{title}</h2>
            {subtitle && <p className="text-sm text-neutral-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </aside>
    </>
  );
};
