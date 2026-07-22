import type { ReactNode } from "react";

export interface TabOption<Value extends string> {
  value: Value;
  label: string;
  icon?: ReactNode;
  count?: number;
}

interface TabsProps<Value extends string> {
  label: string;
  value: Value;
  options: Array<TabOption<Value>>;
  onChange(value: Value): void;
}

export function Tabs<Value extends string>({ label, value, options, onChange }: TabsProps<Value>) {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <span aria-hidden="true">{option.icon}</span>}
          {option.label}
          {option.count !== undefined && <small>{option.count}</small>}
        </button>
      ))}
    </div>
  );
}
