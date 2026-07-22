import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      <span className="ui-empty-state__icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}
