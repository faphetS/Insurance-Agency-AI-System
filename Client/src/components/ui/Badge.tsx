import type { ReactNode } from "react";

type Variant = "default" | "auto" | "hybrid" | "manual" | "warning" | "success" | "info";

const variantStyles: Record<Variant, string> = {
  default: "bg-neutral-200 text-neutral-700 border-neutral-300",
  auto: "bg-orange-100 text-orange-700 border-orange-300",
  hybrid: "bg-purple-100 text-purple-700 border-purple-300",
  manual: "bg-slate-100 text-slate-700 border-slate-300",
  warning: "bg-amber-100 text-amber-800 border-amber-300",
  success: "bg-emerald-100 text-emerald-700 border-emerald-300",
  info: "bg-sky-100 text-sky-700 border-sky-300",
};

interface BadgeProps {
  children: ReactNode;
  variant?: Variant;
  className?: string;
}

export const Badge = ({ children, variant = "default", className = "" }: BadgeProps) => (
  <span
    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${variantStyles[variant]} ${className}`}
  >
    {children}
  </span>
);
