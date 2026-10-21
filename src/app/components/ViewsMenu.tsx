import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { Bookmark, Check, Link2, Trash2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { encodeView, snapshotPage, type PageSnapshot } from "../lib/pageState";

/**
 * SAVED VIEWS (2026-10-22). A view is the page's remembered state — tabs,
 * filters, searches, sorts — taken as one snapshot (pageState.tsx). Saved per
 * person in this browser, under a name; applied by reopening the page on it;
 * shared as a link that opens the same view for whoever follows it (their own
 * permissions still decide what they see).
 *
 * DEFERRED: views follow the person in this browser only. If they should
 * follow the person to every device, the change is a saved_views table keyed
 * by user and path, read here instead of localStorage.
 */

type Saved = { name: string; snap: PageSnapshot; savedAt: string };
const MAX_LINK = 3500;   // characters of encoded view a link will carry

function storeKey(userId: string, pathname: string) { return `savedViews:${userId}:${pathname}`; }
function readSaved(key: string): Saved[] {
  try { const v = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeSaved(key: string, list: Saved[]) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* storage full or blocked */ }
}

export default function ViewsMenu() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Saved[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [current, setCurrent] = useState<PageSnapshot>({});
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  // The band clips its content, so the menu is drawn on the page body, under the button.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const key = profile?.id ? storeKey(profile.id, pathname) : null;

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open || !key) return;
    setList(readSaved(key));
    setCurrent(snapshotPage(pathname));
    setNote(null);
    setName("");
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - 296)) });
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open, key, pathname]);

  if (!key) return null;
  const empty = Object.keys(current).length === 0;

  const save = () => {
    const n = name.trim();
    if (!n || empty) return;
    const next = [...list.filter((v) => v.name !== n), { name: n, snap: current, savedAt: new Date().toISOString() }]
      .sort((a, b) => a.name.localeCompare(b.name));
    writeSaved(key, next);
    setList(next);
    setName("");
    setNote(`Saved "${n}".`);
  };
  const apply = (v: Saved) => {
    setOpen(false);
    navigate(`${pathname}?view=${encodeView(v.snap)}`);
  };
  const remove = (v: Saved) => {
    const next = list.filter((x) => x.name !== v.name);
    writeSaved(key, next);
    setList(next);
  };
  const copyLink = async (snap: PageSnapshot) => {
    const code = encodeView(snap);
    if (code.length > MAX_LINK) { setNote("This view is too large to carry in a link. Save it instead."); return; }
    const url = `${window.location.origin}${pathname}?view=${code}`;
    try { await navigator.clipboard.writeText(url); setNote("Link copied — it opens this page on this view."); }
    catch { setNote(url); }
  };

  return (
    <div className="relative flex-shrink-0">
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog"
        title="Saved views for this page"
        className="ml-1 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:border-brand-500/60">
        <Bookmark className="w-3 h-3" /> Views{list.length > 0 ? ` · ${list.length}` : ""}
      </button>
      {open && at && createPortal(
        <div ref={box} role="dialog" aria-label="Saved views" style={{ top: at.top, left: at.left }}
          className="fixed z-50 w-72 rounded-xl border border-border bg-card text-foreground shadow-lg p-3 flex flex-col gap-2.5">
          <div>
            <p className="text-xs font-semibold">Saved views</p>
            <p className="text-[11px] text-muted-foreground">This page&rsquo;s tabs, filters, searches and sorts, under a name. Kept in this browser.</p>
          </div>
          {list.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">None saved for this page yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
              {list.map((v) => (
                <li key={v.name} className="flex items-center gap-1 rounded-lg hover:bg-muted px-1.5 py-1">
                  <button type="button" className="flex-1 min-w-0 text-left text-sm truncate" onClick={() => apply(v)} title={`Open this page on "${v.name}"`}>{v.name}</button>
                  <button type="button" className="text-muted-foreground hover:text-foreground p-1" onClick={() => void copyLink(v.snap)} title="Copy a link to this view"><Link2 className="w-3.5 h-3.5" /></button>
                  <button type="button" className="text-muted-foreground hover:text-danger-700 p-1" onClick={() => remove(v)} title="Delete this saved view"><Trash2 className="w-3.5 h-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-border pt-2.5 flex flex-col gap-1.5">
            {empty ? (
              <p className="text-[11px] text-muted-foreground">This page is on its defaults — change a tab, filter or sort, then save it here.</p>
            ) : (
              <>
                <div className="flex gap-1.5">
                  <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }}
                    placeholder="Name this view" maxLength={60}
                    className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2 py-1 text-sm" />
                  <button type="button" onClick={save} disabled={!name.trim()}
                    className="inline-flex items-center gap-1 rounded-lg bg-brand-500 text-on-brand px-2.5 text-xs font-semibold disabled:opacity-50">
                    <Check className="w-3.5 h-3.5" /> Save
                  </button>
                </div>
                <button type="button" onClick={() => void copyLink(current)} className="self-start inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <Link2 className="w-3.5 h-3.5" /> Copy a link to what I see now
                </button>
              </>
            )}
            {note && <p className="text-[11px] text-muted-foreground break-all">{note}</p>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
