import { Check, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItemDef {
  id: string;
  label: string;
  shortcut?: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** When defined the item renders as a radio-style entry with a check mark. */
  checked?: boolean;
  onSelect?: () => void;
  submenu?: MenuEntry[];
}

export interface MenuSeparatorDef {
  separator: true;
  id?: string;
}

export type MenuEntry = MenuItemDef | MenuSeparatorDef;

export interface MenuDef {
  id: string;
  label: string;
  items: MenuEntry[];
}

/** Why the menu is closing — controls whether focus returns to the opener. */
type CloseReason = "action" | "escape";

function isSeparator(entry: MenuEntry): entry is MenuSeparatorDef {
  return "separator" in entry && entry.separator;
}

function isActionable(entry: MenuEntry): entry is MenuItemDef {
  return !isSeparator(entry) && !entry.disabled;
}

export function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [openId, setOpenId] = useState<string>();
  const barRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!openId) return;
    const onPointerDown = (event: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setOpenId(undefined);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [openId]);

  const focusTrigger = (id: string) => triggerRefs.current.get(id)?.focus();

  const moveTrigger = (direction: 1 | -1, alsoOpen: boolean) => {
    const activeIndex = menus.findIndex((menu) =>
      menu.id === openId || triggerRefs.current.get(menu.id) === document.activeElement,
    );
    const base = activeIndex < 0 ? 0 : activeIndex;
    const next = menus[(base + direction + menus.length) % menus.length];
    if (!next) return;
    focusTrigger(next.id);
    if (alsoOpen || openId) setOpenId(next.id);
  };

  return (
    <div className="menu-bar" role="menubar" aria-label="Application menu" ref={barRef}>
      {menus.map((menu, index) => {
        const open = openId === menu.id;
        return (
          <div className="menu-bar__slot" key={menu.id}>
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              className={`menu-bar__trigger${open ? " is-open" : ""}`}
              tabIndex={openId ? (open ? 0 : -1) : index === 0 ? 0 : -1}
              ref={(element) => {
                if (element) triggerRefs.current.set(menu.id, element);
                else triggerRefs.current.delete(menu.id);
              }}
              onClick={() => setOpenId(open ? undefined : menu.id)}
              onMouseEnter={() => { if (openId && openId !== menu.id) setOpenId(menu.id); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") { event.preventDefault(); moveTrigger(-1, false); }
                else if (event.key === "ArrowRight") { event.preventDefault(); moveTrigger(1, false); }
                else if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpenId(menu.id); }
                else if (event.key === "Escape") setOpenId(undefined);
              }}
            >
              {menu.label}
            </button>
            {open && (
              <MenuList
                items={menu.items}
                ariaLabel={menu.label}
                onClose={(reason) => { setOpenId(undefined); if (reason === "escape") focusTrigger(menu.id); }}
                onSibling={(direction) => moveTrigger(direction, true)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface MenuListProps {
  items: MenuEntry[];
  ariaLabel: string;
  nested?: boolean;
  onClose(reason: CloseReason): void;
  onSibling?(direction: 1 | -1): void;
}

function MenuList({ items, ariaLabel, nested, onClose, onSibling }: MenuListProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(() => items.findIndex(isActionable));
  const [submenuIndex, setSubmenuIndex] = useState<number>();

  useEffect(() => {
    if (submenuIndex === undefined) itemRefs.current[activeIndex]?.focus();
  }, [activeIndex, submenuIndex]);

  const stepTo = (direction: 1 | -1) => {
    const count = items.length;
    for (let offset = 1; offset <= count; offset++) {
      const candidate = (activeIndex + direction * offset + count * count) % count;
      const entry = items[candidate];
      if (entry && isActionable(entry)) { setActiveIndex(candidate); return; }
    }
  };

  const edge = (direction: 1 | -1) => {
    const ordered = direction === 1 ? items.map((_, i) => i) : items.map((_, i) => i).reverse();
    for (const i of ordered) {
      const entry = items[i];
      if (entry && isActionable(entry)) { setActiveIndex(i); return; }
    }
  };

  const activate = (item: MenuItemDef, index: number) => {
    if (item.submenu) { setActiveIndex(index); setSubmenuIndex(index); return; }
    if (item.disabled) return;
    item.onSelect?.();
    onClose("action");
  };

  return (
    <div
      className={`menu-list${nested ? " menu-list--nested" : ""}`}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        // Keep application-wide keyboard shortcuts from firing while a menu is open.
        event.stopPropagation();
        if (submenuIndex !== undefined) return;
        switch (event.key) {
          case "ArrowDown": event.preventDefault(); stepTo(1); break;
          case "ArrowUp": event.preventDefault(); stepTo(-1); break;
          case "Home": event.preventDefault(); edge(1); break;
          case "End": event.preventDefault(); edge(-1); break;
          case "Escape": event.preventDefault(); onClose("escape"); break;
          case "ArrowLeft":
            event.preventDefault();
            if (nested) onClose("escape"); else onSibling?.(-1);
            break;
          case "ArrowRight": {
            event.preventDefault();
            const current = items[activeIndex];
            if (current && !isSeparator(current) && current.submenu) setSubmenuIndex(activeIndex);
            else if (!nested) onSibling?.(1);
            break;
          }
          default: break;
        }
      }}
    >
      {items.map((entry, index) => {
        if (isSeparator(entry)) return <div key={entry.id ?? `sep-${index}`} className="menu-list__separator" role="separator" />;
        const hasSubmenu = Boolean(entry.submenu?.length);
        const role = entry.checked !== undefined ? "menuitemradio" : "menuitem";
        return (
          <div className="menu-list__slot" key={entry.id}>
            <button
              type="button"
              role={role}
              className={`menu-list__item${entry.danger ? " is-danger" : ""}`}
              tabIndex={index === activeIndex ? 0 : -1}
              disabled={entry.disabled}
              aria-disabled={entry.disabled || undefined}
              aria-haspopup={hasSubmenu ? "menu" : undefined}
              aria-expanded={hasSubmenu ? submenuIndex === index : undefined}
              aria-checked={entry.checked !== undefined ? entry.checked : undefined}
              ref={(element) => { itemRefs.current[index] = element; }}
              onClick={() => activate(entry, index)}
              onMouseEnter={() => { setActiveIndex(index); if (!hasSubmenu) setSubmenuIndex(undefined); }}
            >
              <span className="menu-list__icon" aria-hidden="true">{entry.checked ? <Check size={13} /> : entry.icon}</span>
              <span className="menu-list__label">{entry.label}</span>
              {hasSubmenu
                ? <ChevronRight size={13} className="menu-list__caret" aria-hidden="true" />
                : entry.shortcut ? <kbd className="menu-list__shortcut">{entry.shortcut}</kbd> : null}
            </button>
            {hasSubmenu && submenuIndex === index && (
              <MenuList
                items={entry.submenu ?? []}
                ariaLabel={entry.label}
                nested
                onClose={(reason) => {
                  setSubmenuIndex(undefined);
                  if (reason === "action") onClose("action");
                  else itemRefs.current[index]?.focus();
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
