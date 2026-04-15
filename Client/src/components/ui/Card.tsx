import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export const Card = ({ children, className = "", onClick }: CardProps) => (
  <div
    onClick={onClick}
    className={`rounded-lg border border-neutral-200 bg-white p-4 shadow-sm ${
      onClick ? "cursor-pointer transition hover:border-orange-300 hover:shadow-md" : ""
    } ${className}`}
  >
    {children}
  </div>
);
