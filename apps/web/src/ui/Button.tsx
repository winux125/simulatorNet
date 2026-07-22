import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "default" | "primary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: ReactNode;
}

export function Button({ className = "", variant = "default", size = "md", icon, children, ...props }: ButtonProps) {
  return (
    <button className={`ui-button ui-button--${variant} ui-button--${size} ${className}`} {...props}>
      {icon && <span className="ui-button__icon" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}
