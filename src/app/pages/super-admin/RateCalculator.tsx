import { useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { usePageState } from "../../lib/pageState";

/**
 * RATE CALCULATOR (3 Nov 2026 audit) — what a guard costs a month and what to
 * charge for one, and which live contracts stop covering their guards when the
 * wage rises. A pricing tool: it saves nothing and posts nothing.
 *
 * Every figure is an ASSUMPTION the user sets (the statutory rates included —
 * they change, and which apply depends on the province); nothing here is
 * accounting policy. The wage starts at the median base salary on the active
 * roster.
 */
type Inputs = {
  wage: number; eobiPct: number; socialPct: number; reliefPct: number; kitYear: number;
  supervisionPct: number; overheadPct: number; marginPct: number; guards: number;
};
const DEFAULTS: Inputs = { wage: 40000, eobiPct: 5, socialPct: 6, reliefPct: 16.7, kitYear: 12000, supervisionPct: 4, overheadPct: 8, marginPct: 12, guards: 10 };

function cost(i: Inputs) {
  const eobi = (i.wage * i.eobiPct) / 100;
  const social = (i.wage * i.socialPct) / 100;
  const relief = ((i.wage + eobi + social) * i.reliefPct) / 100;
  const kit = i.kitYear / 12;
  const direct = i.wage + eobi + social + relief + kit;
  const supervision = (direct * i.supervisionPct) / 100;
  const overhead = ((direct + supervision) * i.overheadPct) / 100;
  const total = direct + supervision + overhead;
  // Margin on the selling price: rate = cost / (1 − margin).
  const rate = i.marginPct < 100 ? total / (1 - i.marginPct / 100) : total;
  return { eobi, social, relief, kit, direct, supervision, overhead, total, rate, profit: rate - total };
}
const pk = (n: number) => Math.round(n).toLocaleString("en-US");

function Num({ label, value, onChange, suffix, help }: { label: string; value: number; onChange: (v: number) => void; suffix?: string; help?: string }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        <input type="number" value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Number(e.target.value))}
          className="w-full px-3 py-2 rounded-lg border border-border bg-card font-ledger text-sm" />
        {suffix && <span className="text-xs text-muted-foreground w-10">{suffix}</span>}
      </span>
      {help && <span className="text-[11px] text-muted-foreground">{help}</span>}
    </label>
  );
}

export default function RateCalculator() {
  const { company } = useAuth();
  const [inp, setInp] = usePageState<Inputs>("RateCalculator.inputs", DEFAULTS);
  const set = (k: keyof Inputs) => (v: number) => setInp({ ...inp, [k]: v });
  const [newWage, setNewWage] = usePageState<number>("RateCalculator.newWage", 0);
  const [contracts, setContracts] = useState<{ client: string; code: string; guards: number; rate: number }[]>([]);

  // The roster's median base salary, as a starting wage.
  useEffect(() => {
    if (!company?.id) return;
    void supabase.from("employees").select("base_salary").eq("company_id", company.id).eq("lifecycle_state", "active").gt("base_salary", 0)
      .then(({ data }) => {
        const xs = ((data ?? []) as { base_salary: number }[]).map((r) => Number(r.base_salary)).sort((a, b) => a - b);
        if (!xs.length) return;
        const med = xs[Math.floor(xs.length / 2)];
        if (inp.wage === DEFAULTS.wage && med !== DEFAULTS.wage) setInp({ ...inp, wage: med });
        if (!newWage) setNewWage(med);
      });
    void supabase.from("contracts").select("contract_code, number_of_guards, rate_per_guard_per_month, contract_type, clients(name)")
      .eq("company_id", company.id).eq("status", "active").eq("contract_type", "guard_deployment")
      .then(({ data }) => setContracts(((data ?? []) as any[])
        .filter((c) => Number(c.rate_per_guard_per_month) > 0)
        .map((c) => ({ client: c.clients?.name ?? "", code: c.contract_code, guards: Number(c.number_of_guards ?? 0), rate: Number(c.rate_per_guard_per_month) }))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id]);

  const c = useMemo(() => cost(inp), [inp]);
  const atNew = useMemo(() => cost({ ...inp, wage: newWage || inp.wage }), [inp, newWage]);
  const lines: [string, number][] = [["Wage", inp.wage], ["EOBI (employer)", c.eobi], ["Social security (employer)", c.social], ["Relief cover", c.relief], ["Uniform & kit", c.kit],
    ["Supervision", c.supervision], ["Head-office overhead", c.overhead]];

  return (
    <>
      <Header title="Rate Calculator" subtitle="What a guard costs a month, what to charge, and which contracts a wage rise would put under water" />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-6">
        <div className="grid lg:grid-cols-[1fr_380px] gap-6">
          <section className="rounded-2xl border border-border bg-card p-4 md:p-5 space-y-4">
            <h2 className="font-semibold text-foreground">Assumptions — set them to the case you're pricing</h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Num label="Guard's monthly wage" value={inp.wage} onChange={set("wage")} suffix="PKR" help="Starts at the roster's median base salary" />
              <Num label="EOBI, employer share" value={inp.eobiPct} onChange={set("eobiPct")} suffix="% wage" help="Check the current notified rate" />
              <Num label="Social security (PESSI/IESSI)" value={inp.socialPct} onChange={set("socialPct")} suffix="% wage" help="Depends on the province" />
              <Num label="Relief cover" value={inp.reliefPct} onChange={set("reliefPct")} suffix="%" help="Leave and absence cover; 1 reliever per 6 ≈ 16.7%" />
              <Num label="Uniform & kit a year" value={inp.kitYear} onChange={set("kitYear")} suffix="PKR" help="Per guard, spread over 12 months" />
              <Num label="Supervision" value={inp.supervisionPct} onChange={set("supervisionPct")} suffix="%" help="Supervisors, visits, patrol" />
              <Num label="Head-office overhead" value={inp.overheadPct} onChange={set("overheadPct")} suffix="%" />
              <Num label="Margin wanted" value={inp.marginPct} onChange={set("marginPct")} suffix="% of rate" />
              <Num label="Guards on the contract" value={inp.guards} onChange={set("guards")} />
            </div>
            <button type="button" onClick={() => setInp(DEFAULTS)} className="text-xs text-muted-foreground hover:underline">Reset the assumptions</button>
          </section>

          <section className="rounded-2xl border border-border bg-card p-4 md:p-5">
            <h2 className="font-semibold text-foreground mb-3">Per guard, per month</h2>
            <table className="w-full text-sm">
              <tbody>
                {lines.map(([k, v]) => (
                  <tr key={k} className="border-b border-border"><td className="py-1.5 text-muted-foreground">{k}</td><td className="py-1.5 text-right font-ledger">{pk(v)}</td></tr>
                ))}
                <tr className="border-b-2 border-border font-semibold"><td className="py-2">Cost</td><td className="py-2 text-right font-ledger">{pk(c.total)}</td></tr>
                <tr className="font-semibold text-up"><td className="py-2">Rate to charge</td><td className="py-2 text-right font-ledger text-lg">{pk(c.rate)}</td></tr>
                <tr><td className="py-1 text-muted-foreground">Profit per guard</td><td className="py-1 text-right font-ledger">{pk(c.profit)}</td></tr>
              </tbody>
            </table>
            <div className="mt-4 rounded-xl bg-muted/50 px-3 py-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Contract a month ({inp.guards} guards)</span><span className="font-ledger font-semibold">{pk(c.rate * inp.guards)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Profit a month</span><span className="font-ledger">{pk(c.profit * inp.guards)}</span></div>
              <p className="text-[11px] text-muted-foreground mt-1">Before sales tax and any tax the client withholds.</p>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-border bg-card p-4 md:p-5 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <h2 className="font-semibold text-foreground">If the wage goes up</h2>
              <p className="text-xs text-muted-foreground">Each live guard contract's rate per guard against the cost of a guard at the new wage, with the assumptions above. Contracts with no rate per guard recorded are left out.</p>
            </div>
            <div className="w-56 ml-auto"><Num label="New monthly wage" value={newWage} onChange={setNewWage} suffix="PKR" /></div>
          </div>
          <p className="text-sm">Cost of a guard at {pk(newWage || inp.wage)}: <span className="font-ledger font-semibold">{pk(atNew.total)}</span></p>
          {contracts.length === 0 ? <p className="text-sm text-muted-foreground italic">No live guard contract has a rate per guard recorded.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Client</th><th>Contract</th><th className="text-right">Guards</th><th className="text-right">Rate / guard</th><th className="text-right">Margin at new wage</th></tr></thead>
              <tbody>{[...contracts].sort((a, b) => (a.rate - atNew.total) - (b.rate - atNew.total)).map((k) => {
                const m = k.rate - atNew.total;
                return (
                  <tr key={k.code} className="border-t border-border">
                    <td className="py-1.5">{k.client}</td><td className="font-ledger text-xs">{k.code}</td><td className="text-right font-ledger">{k.guards}</td>
                    <td className="text-right font-ledger">{pk(k.rate)}</td>
                    <td className={`text-right font-ledger font-semibold ${m < 0 ? "text-down" : m < atNew.total * 0.05 ? "text-heed" : "text-up"}`}>{m < 0 ? "−" : ""}{pk(Math.abs(m))} ({k.rate ? Math.round((m / k.rate) * 100) : 0}%)</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </section>
      </div>
    </>
  );
}
