import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/**
 * Drop-in replacement for a native <select> that is fully theme-able on every
 * platform (the native popup is OS-drawn and can't be styled on macOS).
 *
 * Usage is identical to a native select — pass <option> children and a
 * native-style onChange:
 *
 *   <ThemedSelect value={x} onChange={(e) => setX(e.target.value)}>
 *     <option value="all">All</option>
 *     {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
 *   </ThemedSelect>
 *
 * onChange receives a synthetic { target: { value } } so existing handlers
 * work unchanged.
 */

type Opt = { value: string; label: ReactNode; disabled?: boolean };

function extractOptions(children: ReactNode): Opt[] {
  const out: Opt[] = [];
  Children.toArray(children).forEach((child) => {
    if (isValidElement(child) && child.type === "option") {
      const p = child.props as { value?: unknown; children?: ReactNode; disabled?: boolean };
      out.push({
        value: p.value != null ? String(p.value) : "",
        label: p.children,
        disabled: p.disabled,
      });
    }
  });
  return out;
}

type Props = {
  value?: string | number;
  onChange?: (e: { target: { value: string } }) => void;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  title?: string;
  children?: ReactNode;
  "aria-label"?: string;
};

export default function ThemedSelect({
  value,
  onChange,
  className = "",
  disabled,
  required,
  name,
  title,
  children,
  "aria-label": ariaLabel,
}: Props) {
  const opts = useMemo(() => extractOptions(children), [children]);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);

  const currentValue = value != null ? String(value) : "";
  const current = opts.find((o) => o.value === currentValue) ?? null;

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const estHeight = Math.min(opts.length * 36 + 8, 264);
      const spaceBelow = window.innerHeight - r.bottom;
      const up = spaceBelow < estHeight + 8 && r.top > spaceBelow;
      setPos({
        top: up ? r.top - 4 : r.bottom + 4,
        left: r.left,
        width: r.width,
        up,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, opts.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (v: string) => {
    setOpen(false);
    if (v !== currentValue) onChange?.({ target: { value: v } });
  };

  // Native-validation mirror. The visible control is a <button>, which the
  // browser excludes from constraint validation, so a required ThemedSelect
  // would silently pass an empty submit. This hidden <input required> carries
  // the current value and participates in the form's native validation exactly
  // like any required text input — blocking submit and showing the browser's
  // "Please fill out this field" bubble when empty. It must NOT be display:none,
  // readonly, or disabled (all barred from validation), so it's positioned
  // off-view with opacity 0 instead. The `relative` wrapper anchors the bubble
  // to the control; width is forwarded so `w-full` selects still stretch.
  const stretch = className.split(/\s+/).includes("w-full");

  return (
    <span className={`relative ${stretch ? "block w-full" : "inline-block"}`}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={`inline-flex items-center justify-between gap-2 bg-input-background border border-border rounded-md text-sm text-foreground transition-colors hover:border-brand-500/50 focus:outline-none focus:ring-2 focus:ring-brand-500/50 disabled:opacity-50 disabled:cursor-not-allowed ${
          open ? "border-brand-500/60 ring-2 ring-brand-500/40" : ""
        } ${className}`}
      >
        <span className="truncate text-left">{current?.label ?? opts[0]?.label ?? ""}</span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>

      {required && !disabled && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          name={name}
          required
          value={currentValue}
          onChange={() => {}}
          onFocus={(e) => {
            // If validation focuses the mirror, open the real control instead.
            e.currentTarget.blur();
            btnRef.current?.focus();
            setOpen(true);
          }}
          style={{
            position: "absolute",
            left: 12,
            bottom: 0,
            height: 1,
            width: 1,
            opacity: 0,
            padding: 0,
            margin: 0,
            border: 0,
            pointerEvents: "none",
          }}
        />
      )}

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            style={{
              position: "fixed",
              top: pos.up ? undefined : pos.top,
              bottom: pos.up ? window.innerHeight - pos.top : undefined,
              left: pos.left,
              minWidth: pos.width,
              maxWidth: Math.max(pos.width, 280),
              zIndex: 9999,
            }}
            className="max-h-64 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl shadow-black/20 animate-[feed-slide-in_0.14s_ease-out]"
          >
            {opts.map((o, i) => {
              const active = o.value === currentValue;
              return (
                <button
                  key={`${o.value}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={o.disabled}
                  onClick={() => pick(o.value)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-40 ${
                    active
                      ? "bg-brand-500/15 text-brand-700 dark:text-brand-500 font-medium"
                      : "text-foreground hover:bg-accent"
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {active && <Check className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}
