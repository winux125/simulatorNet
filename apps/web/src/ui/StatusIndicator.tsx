import { AlertTriangle, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";

interface StatusIndicatorProps {
  status: "ready" | "running" | "paused" | "error" | "loading" | "unsaved" | "up" | "down";
  label?: string;
  compact?: boolean;
}

export function StatusIndicator({ status, label, compact = false }: StatusIndicatorProps) {
  const Icon = status === "ready" || status === "up"
    ? CircleCheck
    : status === "running" || status === "loading"
      ? LoaderCircle
      : status === "error" || status === "unsaved"
        ? AlertTriangle
        : CircleDashed;
  return (
    <span className={`ui-status ui-status--${status} ${compact ? "ui-status--compact" : ""}`}>
      <Icon size={compact ? 11 : 13} aria-hidden="true" />
      {!compact && <span>{label ?? status}</span>}
    </span>
  );
}
