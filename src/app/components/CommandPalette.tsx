import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Building2, CalendarCheck, CornerDownLeft, FileText, HandCoins, KeyRound, ListTodo, Loader2, LogOut, Moon, Pin, Plus, Receipt, Search, Star, Clock, UserCircle, UserPlus, type LucideIcon } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useMode } from "../lib/mode";
import { togglePin, usePinned, useRecent } from "../lib/navPrefs";

/**
 * COMMAND PALETTE (2026-10-20) — ⌘K / Ctrl+K from anywhere, or the search
 * button on the rail. One box that reaches every page the user is allowed, and
 * any client, guard or invoice by name or code. Empty, it shows pinned and
 * recent pages, so the two places you go most are one keystroke away.
 *
 * Opened by the shortcut or by a "palette:open" window event (the rail and the
 * mobile menu send it), the same decoupling the mobile drawer uses.
 */

export type PaletteLink = { to: string; label: string; icon: LucideIcon; section: string };

type Item = {
  key: string;
  group: string;
  title: string;
  meta?: string;
  icon: LucideIcon;
  run: () => void;
  pinPath?: string;
};

const pageStateKey = (path: string, name: string) => `pageState:${path}:${name}`;

export default function CommandPalette({ links, onChangePassword }: { links: PaletteLink[]; onChangePassword: () => void }) {
  const navigate = useNavigate();
  const { profile, company, signOut } = useAuth();
  const { toggle: toggleMode } = useMode();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
  const pinned = usePinned();
  const recent = useRecent();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => { if (o) { setQ(""); setHits([]); } return !o; }); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("palette:open", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("palette:open", onOpen); };
  }, []);

  // Cleared on the way out, not on the way in: a reset on open would race
  // the first keystrokes typed straight after ⌘K and swallow them.
  const close = () => { setOpen(false); setQ(""); setActive(0); setHits([]); };
  const go = (to: string) => { close(); navigate(to); };
  const byPath = useMemo(() => new Map(links.map((l) => [l.to, l])), [links]);

  // Records: a short debounce, three plain reads, nothing computed.
  useEffect(() => {
    const term = q.trim();
    if (!open || !companyId || term.length < 2) { setHits([]); setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    const h = setTimeout(() => {
      void (async () => {
        const like = `%${term.replace(/[%,()*]/g, " ")}%`;
        const [cl, em, inv] = await Promise.all([
          supabase.from("clients").select("id, name, client_code").eq("company_id", companyId).or(`name.ilike.${like},client_code.ilike.${like}`).limit(5),
          supabase.from("employees").select("id, full_name, guard_code, employee_code, lifecycle_state").eq("company_id", companyId).or(`full_name.ilike.${like},guard_code.ilike.${like},employee_code.ilike.${like}`).limit(6),
          supabase.from("invoices").select("id, invoice_number, client:client_id(name)").eq("company_id", companyId).ilike("invoice_number", like).limit(5),
        ]);
        if (cancelled) return;
        const out: Item[] = [];
        // Clients and guards open their list already searched for them — the
        // page's own search box, through the page state it remembers.
        const searchThen = (path: string, name: string, value: string) => () => {
          try { sessionStorage.setItem(pageStateKey(path, name), JSON.stringify(value)); } catch { /* fine: lands unfiltered */ }
          go(path);
        };
        for (const r of (cl.data ?? []) as { id: string; name: string; client_code: string | null }[])
          out.push({ key: `c${r.id}`, group: "Clients", title: r.name, meta: r.client_code ?? undefined, icon: Building2, run: searchThen("/super-admin/clients", "Clients.search", r.name) });
        for (const r of (em.data ?? []) as { id: string; full_name: string; guard_code: string | null; employee_code: string | null; lifecycle_state: string | null }[])
          out.push({ key: `e${r.id}`, group: "Guards & staff", title: r.full_name, meta: [r.guard_code ?? r.employee_code, r.lifecycle_state && r.lifecycle_state !== "active" ? r.lifecycle_state.replace(/_/g, " ") : null].filter(Boolean).join(" · "), icon: UserCircle, run: searchThen("/super-admin/employees", "EmployeeManagement.search", r.full_name) });
        for (const r of (inv.data ?? []) as unknown as { id: string; invoice_number: string; client: { name: string } | null }[])
          out.push({ key: `i${r.id}`, group: "Invoices", title: r.invoice_number, meta: r.client?.name, icon: FileText, run: () => go(`/super-admin/invoices?focus=${r.id}&focusType=invoices`) });
        setHits(out);
        setBusy(false);
      })();
    }, 200);
    return () => { cancelled = true; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, companyId]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const pageItem = (l: PaletteLink, group: string): Item => ({ key: `${group}:${l.to}`, group, title: l.label, meta: l.section, icon: l.icon, run: () => go(l.to), pinPath: l.to });
    // Things to DO (2026-10-21): each opens the form on its page, and is only
    // offered when the page itself is one this user can open.
    const doIt: Item[] = ([
      { key: "do:expense", title: "New expense", meta: "Expenses & Advances", icon: Receipt, page: "/super-admin/expenses", to: "/super-admin/expenses?new=expense" },
      { key: "do:advance", title: "New advance to a guard", meta: "Expenses & Advances", icon: HandCoins, page: "/super-admin/expenses", to: "/super-admin/expenses?new=advance" },
      { key: "do:invoice", title: "New invoice", meta: "Invoices", icon: Plus, page: "/super-admin/invoices", to: "/super-admin/invoices?new=invoice" },
      { key: "do:receipt", title: "Record a receipt from a client", meta: "Invoices · Receivables", icon: HandCoins, page: "/super-admin/invoices", to: "/super-admin/invoices?tab=receivables" },
      { key: "do:generate", title: "Generate this month's invoices", meta: "Invoices · Generate", icon: FileText, page: "/super-admin/invoices", to: "/super-admin/invoices?tab=generate" },
      { key: "do:task", title: "New task", meta: "Task Board", icon: ListTodo, page: "/super-admin/tasks", to: "/super-admin/tasks?new=task" },
      { key: "do:attendance", title: "Mark attendance", meta: "Attendance", icon: CalendarCheck, page: "/super-admin/attendance", to: "/super-admin/attendance" },
      { key: "do:employee", title: "Add an employee", meta: "Employees", icon: UserPlus, page: "/super-admin/employees", to: "/super-admin/employees" },
    ] as (Omit<Item, "group" | "run"> & { page: string; to: string })[])
      .filter((a) => byPath.has(a.page))
      .map((a) => ({ key: a.key, group: "Do", title: a.title, meta: a.meta, icon: a.icon, run: () => go(a.to) }));
    const actions: Item[] = [
      { key: "a:mode", group: "Actions", title: "Switch light / dark", icon: Moon, run: () => { toggleMode(); close(); } },
      { key: "a:pw", group: "Actions", title: "Change password", icon: KeyRound, run: () => { close(); onChangePassword(); } },
      { key: "a:out", group: "Actions", title: "Sign out", icon: LogOut, run: () => { close(); void signOut(); } },
    ];
    if (!term) {
      const pins = pinned.map((p) => byPath.get(p)).filter((l): l is PaletteLink => !!l).map((l) => pageItem(l, "Pinned"));
      const rec = recent.filter((p) => !pinned.includes(p)).map((p) => byPath.get(p)).filter((l): l is PaletteLink => !!l).slice(0, 5).map((l) => pageItem(l, "Recent"));
      return [...pins, ...rec, ...(pins.length + rec.length ? [] : links.slice(0, 8).map((l) => pageItem(l, "Pages"))), ...doIt.slice(0, 4), ...actions];
    }
    // Every word must appear in the label or the section: "pay run" finds
    // Payroll Run, "fin rep" finds Financial Reports.
    const words = term.split(/\s+/);
    const match = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const pages = links.filter((l) => match(`${l.label} ${l.section}`)).map((l) => pageItem(l, "Pages"));
    return [...doIt.filter((a) => match(`${a.title} ${a.meta}`)), ...pages, ...hits, ...actions.filter((a) => match(a.title))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, links, hits, pinned, recent, byPath]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[active]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  const groups: string[] = [];
  for (const it of items) if (!groups.includes(it.group)) groups.push(it.group);
  let idx = -1;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-3 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Go to anything">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={close} />
      <div className="relative w-full max-w-xl bg-card border border-border rounded-[20px] shadow-2xl overflow-hidden" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search className="w-[18px] h-[18px] text-muted-foreground flex-shrink-0" strokeWidth={1.75} />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Go to a page, client, guard or invoice…"
            className="flex-1 bg-transparent py-4 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            aria-label="Search"
          />
          {busy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          <kbd className="hidden sm:inline text-[11px] text-muted-foreground border border-border rounded-md px-1.5 py-0.5">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-2">
          {items.length === 0 && !busy && (
            <p className="px-5 py-6 text-sm text-muted-foreground">Nothing matches “{q.trim()}”. Try a client's name, a guard code or an invoice number.</p>
          )}
          {groups.map((g) => (
            <div key={g} className="pb-1">
              <p className="lbl px-5 pt-2 pb-1 flex items-center gap-1.5">
                {g === "Pinned" && <Star className="w-3 h-3" />}{g === "Recent" && <Clock className="w-3 h-3" />}{g}
              </p>
              {items.filter((it) => it.group === g).map((it) => {
                idx += 1;
                const i = idx;
                const isActive = i === active;
                const Icon = it.icon;
                const isPinned = it.pinPath ? pinned.includes(it.pinPath) : false;
                return (
                  <div
                    key={it.key}
                    data-idx={i}
                    onMouseMove={() => setActive(i)}
                    className={`group mx-2 flex items-center gap-3 rounded-xl px-3 py-2 cursor-pointer ${isActive ? "bg-muted" : ""}`}
                    onClick={it.run}
                  >
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isActive ? "bg-brand-500 text-on-brand" : "bg-muted text-muted-foreground"}`}>
                      <Icon className="w-4 h-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground truncate">{it.title}</span>
                      {it.meta && <span className="block text-xs text-muted-foreground truncate">{it.meta}</span>}
                    </span>
                    {it.pinPath && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); togglePin(it.pinPath!); }}
                        title={isPinned ? "Unpin from the rail" : "Pin to the rail"}
                        className={`p-1.5 rounded-md ${isPinned ? "text-brand-500" : "text-muted-foreground opacity-0 group-hover:opacity-100"} hover:bg-card`}
                      >
                        <Pin className="w-3.5 h-3.5" fill={isPinned ? "currentColor" : "none"} />
                      </button>
                    )}
                    {isActive && <CornerDownLeft className="w-3.5 h-3.5 text-muted-foreground" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="border-t border-border bg-muted/50 px-4 py-2 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span><kbd className="font-sans">↑↓</kbd> move</span>
          <span><kbd className="font-sans">↵</kbd> open</span>
          <span className="flex items-center gap-1"><Pin className="w-3 h-3" /> pins a page to the rail</span>
          <span className="ml-auto">⌘K anywhere</span>
        </div>
      </div>
    </div>
  );
}
