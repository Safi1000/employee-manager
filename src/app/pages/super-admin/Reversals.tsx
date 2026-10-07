// Reversals — one place to undo a recorded action (0502-0506).
//
// Two tabs. "Reversible actions" lists what can be reversed, newest first,
// from reversible_actions() under the caller's own RLS; each row opens the
// shared ReversalDialog, which previews through the same database function
// that performs the reversal. "History" lists every reversal made, with who,
// when, why and what it did.

import { useCallback, useEffect, useMemo, useState } from "react";
import { History, Loader2, RotateCcw, ShieldAlert, Undo2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Badge from "../../components/Badge";
import Tabs from "../../components/Tabs";
import StatCard from "../../components/StatCard";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import ResponsiveTable, { type Column } from "../../components/ResponsiveTable";
import ReversalDialog, { REVERSAL_KINDS, kindLabel } from "../../components/ReversalDialog";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { formatDate } from "../../lib/date";
import { usePageState } from "../../lib/pageState";
import { ModalFooter, Notice, PageBody, Panel, SearchBox, SubjectCard, inputCls, money } from "./_assetsKit";

type Action = {
  kind: string;
  source_id: string;
  occurred_at: string;
  title: string;
  detail: string | null;
  amount: number | null;
  employee_id: string | null;
  client_id: string | null;
  reversal_id: string | null;
  reversed_at: string | null;
};

type ReversalRow = {
  id: string;
  kind: string;
  source_id: string;
  title: string | null;
  mode: "error" | "recover";
  reason: string;
  reversed_by_name: string | null;
  reversed_at: string;
  effects: string[];
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const GROUPS = ["Payroll & staff", "Money", "Operations"] as const;

export default function Reversals() {
  const [tab, setTab] = usePageState<"actions" | "history">("Reversals.tab", "actions");
  const [kind, setKind] = usePageState<string>("Reversals.kind", "");
  const [from, setFrom] = usePageState<string>("Reversals.from", daysAgo(60));
  const [q, setQ] = usePageState<string>("Reversals.q", "");
  const [actions, setActions] = useState<Action[]>([]);
  const [history, setHistory] = useState<ReversalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<{ kind: string; id: string } | null>(null);
  const [viewing, setViewing] = useState<ReversalRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const [a, h] = await Promise.all([
      supabase.rpc("reversible_actions", {
        p_kind: kind || null, p_from: from || null, p_search: q.trim() || null, p_limit: 500,
      }),
      supabase.from("reversals").select("id, kind, source_id, title, mode, reason, reversed_by_name, reversed_at, effects")
        .order("reversed_at", { ascending: false }).limit(300),
    ]);
    if (a.error) setErr(friendlyDbError(a.error));
    if (h.error) setErr(friendlyDbError(h.error));
    setActions((a.data ?? []) as Action[]);
    setHistory((h.data ?? []) as ReversalRow[]);
    setLoading(false);
  }, [kind, from, q]);

  // Search is typed, so wait for a pause before asking the database.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  const open30 = useMemo(() => history.filter((h) => Date.parse(h.reversed_at) > Date.now() - 30 * 86400000).length, [history]);
  const reversible = actions.filter((a) => !a.reversal_id).length;

  const actionCols: Column<Action>[] = [
    { key: "what", header: "What", primary: true, cell: (a) => (
      <div className="min-w-0">
        <div className="font-medium break-words">{a.title}</div>
        {a.detail && <div className="text-[11px] text-muted-foreground break-words">{a.detail}</div>}
      </div>
    ) },
    { key: "type", header: "Type", cell: (a) => <Badge tone="neutral">{kindLabel(a.kind)}</Badge> },
    { key: "when", header: "Recorded", cell: (a) => <span className="whitespace-nowrap">{formatDate(a.occurred_at)}</span> },
    { key: "amount", header: "Amount", className: "text-right tabular-nums", cell: (a) =>
      a.amount != null ? `PKR ${money(a.amount)}` : <span className="text-muted-foreground">—</span> },
    { key: "status", header: "Status", cell: (a) => a.reversal_id
      ? <Badge tone="warning">Reversed {a.reversed_at ? formatDate(a.reversed_at) : ""}</Badge>
      : <Badge tone="success">Standing</Badge> },
  ];

  const historyCols: Column<ReversalRow>[] = [
    { key: "what", header: "What was reversed", primary: true, cell: (r) => (
      <div className="min-w-0">
        <div className="font-medium break-words">{r.title ?? kindLabel(r.kind)}</div>
        <div className="text-[11px] text-muted-foreground break-words">“{r.reason}”</div>
      </div>
    ) },
    { key: "type", header: "Type", cell: (r) => (
      <div className="flex flex-wrap gap-1">
        <Badge tone="neutral">{kindLabel(r.kind)}</Badge>
        {r.mode === "recover" && <Badge tone="warning">Recovered</Badge>}
      </div>
    ) },
    { key: "by", header: "By", cell: (r) => r.reversed_by_name ?? "—" },
    { key: "when", header: "When", cell: (r) => <span className="whitespace-nowrap">{formatDate(r.reversed_at)}</span> },
  ];

  return (
    <>
      <Header title="Reversals" subtitle="Undo a recorded action — the opposite entry is posted and the reason kept" />

      <PageBody>
        {err && <Notice kind="error" onClose={() => setErr(null)}>{err}</Notice>}
        {notice && <Notice kind="success" onClose={() => setNotice(null)}>{notice}</Notice>}

        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
          <StatCard title="Reversible in view" value={reversible} icon={Undo2} tone="brand" />
          <StatCard title="Reversed (last 30 days)" value={open30} icon={RotateCcw} tone="warning" />
          <StatCard title="Reversals on record" value={history.length} icon={History} tone="neutral" />
        </div>

        <Tabs<"actions" | "history">
          value={tab}
          onChange={setTab}
          items={[
            { value: "actions", label: "Reversible actions", count: reversible },
            { value: "history", label: "History", count: history.length },
          ]}
        />

        {tab === "actions" && (
          <Panel
            icon={ShieldAlert}
            tone="warning"
            title="Recorded actions"
            description="Pick the one that was wrong. The popup shows exactly what reversing it will do — and what is in the way, if anything — before anything changes."
            flush
          >
            <div className="flex flex-col lg:flex-row lg:items-center gap-3 px-4 md:px-5 py-3 border-b border-border">
              <SearchBox value={q} onChange={setQ} placeholder="Search name, invoice, description…" />
              <div className="w-full lg:w-72">
                <ThemedSelect className="w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">All types</option>
                  {GROUPS.flatMap((g) => [
                    <option key={`g-${g}`} value={`__${g}`} disabled>— {g} —</option>,
                    ...Object.entries(REVERSAL_KINDS).filter(([, v]) => v.group === g)
                      .map(([k, v]) => <option key={k} value={k}>{v.label}</option>),
                  ])}
                </ThemedSelect>
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                Since
                <input type="date" className={inputCls + " w-auto"} value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
            </div>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (
              <div className="p-3 md:p-2">
                <ResponsiveTable
                  columns={actionCols}
                  rows={actions}
                  rowKey={(a) => `${a.kind}:${a.source_id}`}
                  empty="Nothing recorded in this range matches."
                  actions={(a) => a.reversal_id ? null : (
                    <Button variant="secondary" size="sm" onClick={() => setOpen({ kind: a.kind, id: a.source_id })}>
                      <RotateCcw className="w-3.5 h-3.5" /> Reverse
                    </Button>
                  )}
                />
              </div>
            )}
          </Panel>
        )}

        {tab === "history" && (
          <Panel icon={History} title="Reversals made" description="Every reversal, newest first. Open one to see exactly what it did." flush>
            <div className="p-3 md:p-2">
              <ResponsiveTable
                columns={historyCols}
                rows={history}
                rowKey={(r) => r.id}
                onRowClick={setViewing}
                empty="Nothing has been reversed yet."
              />
            </div>
          </Panel>
        )}
      </PageBody>

      {open && (
        <ReversalDialog
          kind={open.kind}
          id={open.id}
          onClose={() => { setOpen(null); void load(); }}
          onDone={(r) => setNotice(`Reversed: ${r.title}`)}
        />
      )}

      {viewing && (
        <Modal
          isOpen
          onClose={() => setViewing(null)}
          title="Reversal"
          size="md"
          footer={<ModalFooter><Button onClick={() => setViewing(null)}>Close</Button></ModalFooter>}
        >
          <div className="space-y-4">
            <SubjectCard
              title={viewing.title ?? kindLabel(viewing.kind)}
              meta={`${kindLabel(viewing.kind)} · ${formatDate(viewing.reversed_at)} · ${viewing.reversed_by_name ?? "—"}`}
              aside={viewing.mode === "recover" ? <Badge tone="warning">Recovered</Badge> : undefined}
            />
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Reason</div>
              <p className="text-sm">{viewing.reason}</p>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">What it did</div>
              <ul className="space-y-1.5">
                {(viewing.effects ?? []).map((e, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-brand-500 flex-shrink-0" />
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
