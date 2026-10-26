import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Loader2, Lock, Plus, Settings2, Trash2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import PartnerFormModal from "../../components/PartnerFormModal";
import PartnerDetailModal from "../../components/PartnerDetailModal";
import PartnershipPolicyPanel from "../../components/PartnershipPolicyPanel";
import { supabase, type Branch, type Partner } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";

/**
 * PARTNERSHIP — PARTNERS (rebuilt 2026-10-26, same language as the Months view).
 *
 *   the two pools   — the equity pool (what is left once every region has paid
 *                     its own partner) and each region's pool, each as one bar;
 *   the partners    — one card each: share, which pool, where their account
 *                     stands today (partner_ledger's last line, never
 *                     recomputed), and the three things you do with a partner;
 *   policy          — the company-wide settings (basis, HO exclusion), below.
 * Adding, editing and the ledger/breakdown are the existing dialogs, unchanged.
 */

const acct = (n: number) => { const v = Math.round(Number(n || 0)); return v < 0 ? `(${Math.abs(v).toLocaleString()})` : v.toLocaleString(); };
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const SPLIT = ["bg-brand-500", "bg-up", "bg-heed", "bg-brand-500/50", "bg-up/50", "bg-heed/50"];

export default function PartnershipPartners() {
  const { profile, company } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
  const canEdit = hasPermission(profile, "accounting.edit");

  const [partners, setPartners] = useState<Partner[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [balances, setBalances] = useState<Map<string, number>>(new Map());
  const [basis, setBasis] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [formPartner, setFormPartner] = useState<Partner | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [detail, setDetail] = useState<Partner | null>(null);

  const period = useMemo(() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return monthKey(d); }, []);
  const periodOptions = useMemo(() => {
    const out: string[] = []; const d = new Date(); d.setDate(1);
    for (let i = 0; i < 12; i++) { out.push(monthKey(d)); d.setMonth(d.getMonth() - 1); }
    return out;
  }, []);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setErr(null);
    const [pRes, bRes, fRes] = await Promise.all([
      supabase.from("partners").select("*").eq("company_id", companyId).order("name"),
      supabase.from("branches").select("*").eq("company_id", companyId).order("name"),
      supabase.from("finance_settings").select("partner_remuneration_basis").eq("company_id", companyId).maybeSingle(),
    ]);
    if (pRes.error) setErr(pRes.error.message);
    const list = (pRes.data ?? []) as Partner[];
    setPartners(list);
    setBranches((bRes.data ?? []) as Branch[]);
    setBasis((fRes.data as { partner_remuneration_basis?: string } | null)?.partner_remuneration_basis ?? null);
    // Each partner's account today: the ledger's own last line.
    const m = new Map<string, number>();
    await Promise.all(list.map(async (p) => {
      const { data } = await supabase.rpc("partner_ledger", { p_partner_id: p.id, p_start: null, p_end: null });
      const rows = (data ?? []) as { balance: number }[];
      m.set(p.id, rows.length ? Number(rows[rows.length - 1].balance) : Number(p.opening_balance ?? 0));
    }));
    setBalances(m);
    setLoading(false);
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const equity = partners.filter((p) => p.scope !== "BRANCH");
  const regional = partners.filter((p) => p.scope === "BRANCH");
  const equityTotal = equity.reduce((n, p) => n + Number(p.profit_share_percent), 0);
  const branchName = (id: string | null) => branches.find((b) => b.id === id)?.name ?? "no region";
  const byRegion = useMemo(() => {
    const m = new Map<string, Partner[]>();
    for (const p of regional) { const k = p.branch_id ?? ""; m.set(k, [...(m.get(k) ?? []), p]); }
    return [...m.entries()];
  }, [regional]);

  const remove = async (p: Partner) => {
    if (!window.confirm(`Delete ${p.name}? Their ledger entries and any per-client share overrides go with them.`)) return;
    const { error } = await supabase.from("partners").delete().eq("id", p.id);
    if (error) { setErr(error.message); return; }
    await load();
  };

  const Pool = ({ title, members, note }: { title: string; members: Partner[]; note: string }) => {
    const total = members.reduce((n, p) => n + Number(p.profit_share_percent), 0);
    return (
      <div className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-display text-base font-bold tracking-tight text-foreground">{title}</span>
          <span className="text-xs text-muted-foreground">{note}</span>
          <span className={`ml-auto font-ledger text-sm font-semibold ${total > 100 ? "text-down" : total < 100 ? "text-heed" : "text-up"}`}>
            {total}% {total < 100 ? `· ${100 - total}% unallocated` : total > 100 ? "· over-allocated" : "allocated"}
          </span>
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
          {members.map((p, i) => <div key={p.id} className={SPLIT[i % SPLIT.length]} style={{ width: `${Math.min(100, Number(p.profit_share_percent))}%` }} title={`${p.name} ${Number(p.profit_share_percent)}%`} />)}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          {members.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${SPLIT[i % SPLIT.length]}`} />{p.name} <span className="font-ledger text-foreground">{Number(p.profit_share_percent)}%</span></span>
          ))}
        </div>
      </div>
    );
  };

  const Card = ({ p }: { p: Partner }) => {
    const bal = balances.get(p.id) ?? 0;
    return (
      <article className="rounded-2xl border border-border bg-card overflow-hidden flex flex-col">
        <div className="px-5 py-4 flex items-start gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-display text-lg font-bold text-foreground truncate">{p.name}</span>
              {p.opening_balance_locked && <Lock className="w-3.5 h-3.5 text-muted-foreground" aria-label="Opening locked" />}
            </div>
            <div className="text-xs text-muted-foreground">
              {p.scope === "BRANCH" ? `Regional partner · ${branchName(p.branch_id)}` : "Equity partner · what every region leaves"}
            </div>
          </div>
          <div className="ml-auto text-right">
            <span className="lbl">Share</span>
            <div className="font-ledger text-2xl font-bold">{Number(p.profit_share_percent)}%</div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border bg-muted/30 flex items-end gap-3">
          <div>
            <span className="lbl">Account today</span>
            <div className={`font-ledger text-base font-semibold ${bal < 0 ? "text-down" : ""}`}>{loading ? "…" : acct(bal)}</div>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setDetail(p)}><BookOpen className="w-4 h-4" /> Ledger & clients</Button>
            {canEdit && (
              <>
                <button type="button" onClick={() => { setFormPartner(p); setFormOpen(true); }} className="p-2 rounded-lg hover:bg-muted" title="Edit shares" aria-label={`Edit ${p.name}`}><Settings2 className="w-4 h-4" /></button>
                <button type="button" onClick={() => remove(p)} className="p-2 rounded-lg text-down hover:bg-down/10" title="Delete" aria-label={`Delete ${p.name}`}><Trash2 className="w-4 h-4" /></button>
              </>
            )}
          </div>
        </div>
      </article>
    );
  };

  return (
    <>
      <Header
        title="Partners"
        subtitle={`Who shares in what${basis ? ` · shares are taken on ${basis === "cash" ? "net cash" : "total income"}` : ""}`}
        actions={
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            {canEdit && <Button variant="primary" onClick={() => { setFormPartner(null); setFormOpen(true); }}><Plus className="w-4 h-4" /> Add partner</Button>}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-5">
        {err && <div className="bg-danger-50 border border-danger-200 rounded-lg px-4 py-3 text-sm text-danger-700">{err}</div>}

        <section className="grid gap-4 lg:grid-cols-2">
          <Pool title="Equity pool" members={equity} note="divides what every region leaves" />
          {byRegion.map(([bid, ms]) => <Pool key={bid} title={branchName(bid || null)} members={ms} note="divides this region's own profit" />)}
        </section>

        {equity.length > 0 && (
          <section>
            <h3 className="font-display text-base font-bold tracking-tight text-foreground mb-2 px-1">Equity partners</h3>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{equity.map((p) => <Card key={p.id} p={p} />)}</div>
          </section>
        )}
        {regional.length > 0 && (
          <section>
            <h3 className="font-display text-base font-bold tracking-tight text-foreground mb-2 px-1">Regional partners</h3>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{regional.map((p) => <Card key={p.id} p={p} />)}</div>
          </section>
        )}
        {!loading && partners.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No partners yet.</div>
        )}

        {companyId && (
          <section id="partnership-policy">
            <PartnershipPolicyPanel companyId={companyId} period={period} canEdit={canEdit} onSaved={load} />
          </section>
        )}
        <p className="text-xs text-muted-foreground px-1">
          The equity pool and each region's pool are separate: shares are counted to 100% within a pool, never across them.
        </p>
      </div>

      <PartnerFormModal
        isOpen={formOpen}
        partner={formPartner}
        branches={branches}
        equityShareTotal={equityTotal}
        period={period}
        regionName={formPartner?.branch_id ? branchName(formPartner.branch_id) : null}
        onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); setFormPartner(null); void load(); }}
        onChanged={() => void load()}
        onOpenPolicy={() => {
          setFormOpen(false); setFormPartner(null);
          requestAnimationFrame(() => document.getElementById("partnership-policy")?.scrollIntoView({ behavior: "smooth", block: "center" }));
        }}
      />
      <PartnerDetailModal
        isOpen={detail !== null}
        partner={detail}
        period={period}
        periodOptions={periodOptions}
        regionName={detail?.branch_id ? branchName(detail.branch_id) : null}
        onClose={() => setDetail(null)}
        onChanged={() => void load()}
      />
    </>
  );
}
