import { useEffect, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import HeadOfficeApportionmentPanel from "../../../components/HeadOfficeApportionmentPanel";
import { supabase } from "../../../lib/supabase";
import { useAuth, hasPermission } from "../../../lib/auth";
import { Panel } from "../_assetsKit";
import { money, monthEnd, monthLabel, monthStart, useCompanyId, useDrill } from "./kit";

/**
 * Head office, on its own view: what the pool holds this month on the chosen
 * basis, and each region's Yes/No with every partner's share before and after
 * (HeadOfficeApportionmentPanel, 0514/0515/0525). It used to sit above the
 * client table, where a setting that moves money between partners read as
 * part of a report.
 */
export default function HeadOfficeTab({ period, basis }: { period: string; basis: "revenue" | "cash" }) {
  const companyId = useCompanyId();
  const { profile } = useAuth();
  const canEdit = hasPermission(profile, "accounting.edit");
  const drill = useDrill();
  const [pool, setPool] = useState<number | null>(null);
  const [hoBranch, setHoBranch] = useState<string | null>(null);
  const start = monthStart(period), end = monthEnd(period);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setPool(null);
    void Promise.all([
      supabase.rpc("ho_pool", { p_company_id: companyId, p_start: start, p_end: end, p_basis: basis === "cash" ? "cash" : "accrual" }),
      supabase.from("branches").select("id").eq("company_id", companyId).eq("is_head_office", true).maybeSingle(),
    ]).then(([p, b]) => {
      if (cancelled) return;
      setPool(Number(p.data ?? 0));
      setHoBranch((b.data as { id: string } | null)?.id ?? null);
    });
    return () => { cancelled = true; };
  }, [companyId, start, end, basis]);

  return (
    <div className="flex flex-col gap-4 md:gap-5">
      <section className="bg-card border border-border rounded-[18px] p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="lbl">Head-office pool · {monthLabel(period)} · {basis === "cash" ? "cash basis" : "accrual"}</p>
          <div className="font-display text-4xl font-extrabold tracking-tight mt-1">
            {pool == null ? <Loader2 className="w-6 h-6 animate-spin" /> : <><span className="cur">PKR</span>{money(Math.round(pool))}</>}
          </div>
          <p className="text-sm text-muted-foreground mt-1 max-w-xl">What head office spent that no client or region carries directly. Income tax, the bonus provision and a partner's share are left out of the pool by design.</p>
        </div>
        {hoBranch && (
          <button type="button" onClick={() => drill({ type: "gl", title: `Head-office expense lines — ${monthLabel(period)}`, start, end, branchId: hoBranch, accountTypes: ["expense"], note: "Every expense line on the head-office region in the month." })}
            className="px-4 py-2.5 rounded-xl bg-foreground text-background text-sm font-semibold hover:opacity-90">
            Open the pool's entries
          </button>
        )}
      </section>
      {companyId && (
        <Panel icon={Building2} title="Charge head office to a region?" description="Yes or No for each region. A region set to No passes its share to the regions set to Yes; every partner's share before and after is shown before anything saves.">
          <HeadOfficeApportionmentPanel bare companyId={companyId} period={period} canEdit={canEdit} />
        </Panel>
      )}
    </div>
  );
}
