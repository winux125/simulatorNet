import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  active?: boolean;
}

export function IconButton({ label, icon, active, className = "", ...props }: IconButtonProps) {
  return (
    <button
      className={`ui-icon-button tooltip-anchor ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-tooltip={label}
      {...props}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
