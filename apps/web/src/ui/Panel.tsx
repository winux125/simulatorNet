import type { HTMLAttributes, ReactNode } from "react";

export function Panel({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`ui-panel ${className}`} {...props} />;
}

interface PanelHeaderProps {
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
}

export function PanelHeader({ title, detail, actions }: PanelHeaderProps) {
  return (
    <header className="ui-panel-header">
      <div><strong>{title}</strong>{detail && <span>{detail}</span>}</div>
      {actions && <div className="ui-panel-header__actions">{actions}</div>}
    </header>
  );
}
