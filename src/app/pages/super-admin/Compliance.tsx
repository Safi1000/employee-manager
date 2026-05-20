import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Bell,
  Calendar as CalendarIcon,
  AlertCircle,
  Loader2,
  X,
  Trash2,
  Pencil,
  RotateCcw,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  COMPLIANCE_CATEGORIES,
  type ComplianceCategory,
  type CompliancePriority,
  type ImportantDate,
  type RecurringAlert,
  type RecurringFrequency,
} from "../../lib/supabase";

type DateForm = {
  title: string;
  due_date: string;
  category: ComplianceCategory;
  priority: CompliancePriority;
  advance_notice_days: string;
  notes: string;
};

type RecurringForm = {
  name: string;
  category: ComplianceCategory;
  frequency: RecurringFrequency;
  trigger_day: string;
  advance_notice_days: string;
  notes: string;
  active: boolean;
};

const todayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const emptyDateForm = (): DateForm => ({
  title: "",
  due_date: todayStr(),
  category: "License",
  priority: "medium",
  advance_notice_days: "30",
  notes: "",
});

const emptyRecurringForm = (): RecurringForm => ({
  name: "",
  category: "Operations",
  frequency: "Monthly",
  trigger_day: "1",
  advance_notice_days: "0",
  notes: "",
  active: true,
});

const dayDiff = (iso: string) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
};

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const priorityRank = (p: CompliancePriority) =>
  p === "critical" ? 4 : p === "high" ? 3 : p === "medium" ? 2 : 1;

const triggerDayHelp = (f: RecurringFrequency) => {
  if (f === "Daily") return "Time tag (e.g. 'Every day' or '09:00')";
  if (f === "Weekly") return "Weekday (Mon, Tue, Wed, Thu, Fri, Sat, Sun)";
  if (f === "Monthly") return "Day of month (1–31, or 'Last')";
  return "MM-DD (e.g. 03-15)";
};

type ContractEndAlert = {
  id: string;
  client_id: string;
  client_name: string;
  due_date: string;
  daysRemaining: number;
  priority: CompliancePriority;
};

export default function Compliance() {
  const [dates, setDates] = useState<ImportantDate[]>([]);
  const [recurring, setRecurring] = useState<RecurringAlert[]>([]);
  const [contractAlerts, setContractAlerts] = useState<ContractEndAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<"dates" | "alerts" | "recurring">("dates");

  const [isDateAddOpen, setIsDateAddOpen] = useState(false);
  const [dateForm, setDateForm] = useState<DateForm>(emptyDateForm());
  const [submittingDate, setSubmittingDate] = useState(false);

  const [editDateId, setEditDateId] = useState<string | null>(null);
  const [isDateEditOpen, setIsDateEditOpen] = useState(false);
  const [editDateForm, setEditDateForm] = useState<DateForm>(emptyDateForm());
  const [editDateSubmitting, setEditDateSubmitting] = useState(false);

  const [isRecAddOpen, setIsRecAddOpen] = useState(false);
  const [recForm, setRecForm] = useState<RecurringForm>(emptyRecurringForm());
  const [submittingRec, setSubmittingRec] = useState(false);

  const [editRecId, setEditRecId] = useState<string | null>(null);
  const [isRecEditOpen, setIsRecEditOpen] = useState(false);
  const [editRecForm, setEditRecForm] = useState<RecurringForm>(emptyRecurringForm());
  const [editRecSubmitting, setEditRecSubmitting] = useState(false);

  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const today = todayStr();
    const in60Iso = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 60);
      return d.toISOString().slice(0, 10);
    })();
    const [dRes, rRes, cRes] = await Promise.all([
      supabase.from("important_dates").select("*").order("due_date"),
      supabase.from("recurring_alerts").select("*").order("created_at", { ascending: false }),
      supabase
        .from("clients")
        .select("id, name, contract_end")
        .not("contract_end", "is", null)
        .gte("contract_end", today)
        .lte("contract_end", in60Iso)
        .order("contract_end"),
    ]);
    if (dRes.error) setError(dRes.error.message);
    if (rRes.error) setError(rRes.error.message);
    if (cRes.error) setError(cRes.error.message);
    setDates((dRes.data ?? []) as ImportantDate[]);
    setRecurring((rRes.data ?? []) as RecurringAlert[]);
    const synth: ContractEndAlert[] = ((cRes.data ?? []) as {
      id: string;
      name: string;
      contract_end: string;
    }[]).map((c) => {
      const daysRemaining = dayDiff(c.contract_end);
      const priority: CompliancePriority =
        daysRemaining <= 7 ? "critical" : daysRemaining <= 30 ? "high" : "medium";
      return {
        id: `contract-${c.id}`,
        client_id: c.id,
        client_name: c.name,
        due_date: c.contract_end,
        daysRemaining,
        priority,
      };
    });
    setContractAlerts(synth);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const datesWithDays = useMemo(
    () =>
      dates
        .map((d) => ({ ...d, daysRemaining: dayDiff(d.due_date) }))
        .sort((a, b) => a.daysRemaining - b.daysRemaining),
    [dates]
  );

  type ActiveAlertItem =
    | {
        kind: "important_date";
        id: string;
        title: string;
        category: string;
        priority: CompliancePriority;
        due_date: string;
        daysRemaining: number;
        notes: string | null;
        source: ImportantDate;
      }
    | {
        kind: "contract_end";
        id: string;
        title: string;
        category: string;
        priority: CompliancePriority;
        due_date: string;
        daysRemaining: number;
        notes: string | null;
        client_id: string;
      };

  const activeAlerts = useMemo<ActiveAlertItem[]>(() => {
    const fromDates: ActiveAlertItem[] = datesWithDays
      .filter((d) => d.daysRemaining >= 0 && d.daysRemaining <= d.advance_notice_days)
      .map((d) => ({
        kind: "important_date",
        id: d.id,
        title: d.title,
        category: d.category,
        priority: d.priority,
        due_date: d.due_date,
        daysRemaining: d.daysRemaining,
        notes: d.notes ?? null,
        source: d,
      }));
    // Contract-end alerts fire at the 60/30/7-day windows.
    const fromContracts: ActiveAlertItem[] = contractAlerts
      .filter(
        (c) =>
          c.daysRemaining >= 0 &&
          (c.daysRemaining <= 7 || c.daysRemaining <= 30 || c.daysRemaining <= 60),
      )
      .map((c) => ({
        kind: "contract_end",
        id: c.id,
        title: `Contract ending: ${c.client_name}`,
        category: "Client",
        priority: c.priority,
        due_date: c.due_date,
        daysRemaining: c.daysRemaining,
        notes:
          c.daysRemaining <= 7
            ? "Critical: contract ends within a week — renew or replace."
            : c.daysRemaining <= 30
              ? "Renew or replace within the next 30 days."
              : "Heads up: contract ends within 60 days.",
        client_id: c.client_id,
      }));
    return [...fromDates, ...fromContracts].sort(
      (a, b) =>
        priorityRank(b.priority) - priorityRank(a.priority) ||
        a.daysRemaining - b.daysRemaining,
    );
  }, [datesWithDays, contractAlerts]);

  const metrics = useMemo(() => {
    const upcomingDates = datesWithDays.filter((d) => d.daysRemaining >= 0).length;
    const upcomingContracts = contractAlerts.filter((c) => c.daysRemaining >= 0).length;
    const critical = activeAlerts.filter((d) => d.priority === "critical").length;
    const high = activeAlerts.filter((d) => d.priority === "high").length;
    return {
      critical,
      high,
      upcoming: upcomingDates + upcomingContracts,
      activeAlerts: activeAlerts.length,
    };
  }, [datesWithDays, contractAlerts, activeAlerts]);

  const validateDate = (f: DateForm): string | null => {
    if (!f.title.trim()) return "Enter a title.";
    if (!f.due_date) return "Pick a date.";
    const adv = Number(f.advance_notice_days);
    if (Number.isNaN(adv) || adv < 0) return "Advance notice must be 0 or more days.";
    return null;
  };

  const validateRec = (f: RecurringForm): string | null => {
    if (!f.name.trim()) return "Enter an alert name.";
    if (!f.trigger_day.trim()) return "Specify the trigger day.";
    const adv = Number(f.advance_notice_days);
    if (Number.isNaN(adv) || adv < 0) return "Advance notice must be 0 or more days.";
    return null;
  };

  const handleAddDate = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateDate(dateForm);
    if (err) {
      setError(err);
      return;
    }
    setSubmittingDate(true);
    setError(null);
    try {
      const { error: insErr } = await supabase.from("important_dates").insert({
        title: dateForm.title.trim(),
        due_date: dateForm.due_date,
        category: dateForm.category,
        priority: dateForm.priority,
        advance_notice_days: Number(dateForm.advance_notice_days),
        notes: dateForm.notes.trim() || null,
      });
      if (insErr) throw insErr;
      setDateForm(emptyDateForm());
      setIsDateAddOpen(false);
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSubmittingDate(false);
    }
  };

  const openEditDate = (row: ImportantDate) => {
    setEditDateId(row.id);
    setEditDateForm({
      title: row.title,
      due_date: row.due_date,
      category: row.category,
      priority: row.priority,
      advance_notice_days: String(row.advance_notice_days),
      notes: row.notes ?? "",
    });
    setIsDateEditOpen(true);
  };

  const handleEditDate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editDateId) return;
    const err = validateDate(editDateForm);
    if (err) {
      setError(err);
      return;
    }
    setEditDateSubmitting(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("important_dates")
        .update({
          title: editDateForm.title.trim(),
          due_date: editDateForm.due_date,
          category: editDateForm.category,
          priority: editDateForm.priority,
          advance_notice_days: Number(editDateForm.advance_notice_days),
          notes: editDateForm.notes.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", editDateId);
      if (upErr) throw upErr;
      setIsDateEditOpen(false);
      setEditDateId(null);
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setEditDateSubmitting(false);
    }
  };

  const handleDeleteDate = async (row: ImportantDate) => {
    if (!window.confirm(`Delete "${row.title}"?`)) return;
    const { error: delErr } = await supabase.from("important_dates").delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const handleAddRec = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateRec(recForm);
    if (err) {
      setError(err);
      return;
    }
    setSubmittingRec(true);
    setError(null);
    try {
      const { error: insErr } = await supabase.from("recurring_alerts").insert({
        name: recForm.name.trim(),
        category: recForm.category,
        frequency: recForm.frequency,
        trigger_day: recForm.trigger_day.trim(),
        advance_notice_days: Number(recForm.advance_notice_days),
        active: recForm.active,
        notes: recForm.notes.trim() || null,
      });
      if (insErr) throw insErr;
      setRecForm(emptyRecurringForm());
      setIsRecAddOpen(false);
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSubmittingRec(false);
    }
  };

  const openEditRec = (row: RecurringAlert) => {
    setEditRecId(row.id);
    setEditRecForm({
      name: row.name,
      category: row.category,
      frequency: row.frequency,
      trigger_day: row.trigger_day,
      advance_notice_days: String(row.advance_notice_days),
      notes: row.notes ?? "",
      active: row.active,
    });
    setIsRecEditOpen(true);
  };

  const handleEditRec = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editRecId) return;
    const err = validateRec(editRecForm);
    if (err) {
      setError(err);
      return;
    }
    setEditRecSubmitting(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("recurring_alerts")
        .update({
          name: editRecForm.name.trim(),
          category: editRecForm.category,
          frequency: editRecForm.frequency,
          trigger_day: editRecForm.trigger_day.trim(),
          advance_notice_days: Number(editRecForm.advance_notice_days),
          active: editRecForm.active,
          notes: editRecForm.notes.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", editRecId);
      if (upErr) throw upErr;
      setIsRecEditOpen(false);
      setEditRecId(null);
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setEditRecSubmitting(false);
    }
  };

  const handleDeleteRec = async (row: RecurringAlert) => {
    if (!window.confirm(`Delete recurring alert "${row.name}"?`)) return;
    const { error: delErr } = await supabase.from("recurring_alerts").delete().eq("id", row.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const toggleRec = async (row: RecurringAlert) => {
    const next = !row.active;
    setRecurring((cur) => cur.map((r) => (r.id === row.id ? { ...r, active: next } : r)));
    const { error: upErr } = await supabase
      .from("recurring_alerts")
      .update({ active: next, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (upErr) {
      setError(upErr.message);
      setRecurring((cur) => cur.map((r) => (r.id === row.id ? { ...r, active: !next } : r)));
    }
  };

  const calendarCells = useMemo(() => {
    const { y, m } = calendarMonth;
    const first = new Date(y, m, 1);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const eventsByDay = new Map<number, ImportantDate[]>();
    for (const d of dates) {
      const [dy, dm, dd] = d.due_date.split("-").map(Number);
      if (dy === y && dm === m + 1) {
        const arr = eventsByDay.get(dd) ?? [];
        arr.push(d);
        eventsByDay.set(dd, arr);
      }
    }
    const cells: { day: number | null; events: ImportantDate[] }[] = [];
    for (let i = 0; i < startWeekday; i += 1) cells.push({ day: null, events: [] });
    for (let i = 1; i <= daysInMonth; i += 1) {
      cells.push({ day: i, events: eventsByDay.get(i) ?? [] });
    }
    while (cells.length % 7 !== 0) cells.push({ day: null, events: [] });
    return cells;
  }, [calendarMonth, dates]);

  const calendarLabel = new Date(calendarMonth.y, calendarMonth.m, 1).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" }
  );

  const headerActions = (
    <div className="flex items-center gap-2">
      {activeTab === "recurring" ? (
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            setRecForm(emptyRecurringForm());
            setIsRecAddOpen(true);
          }}
        >
          <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
          Add Recurring Alert
        </Button>
      ) : (
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            setDateForm(emptyDateForm());
            setIsDateAddOpen(true);
          }}
        >
          <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
          Add Important Date
        </Button>
      )}
    </div>
  );

  const priorityBadge = (p: CompliancePriority) =>
    p === "critical"
      ? "bg-red-100 text-red-700"
      : p === "high"
      ? "bg-amber-100 text-amber-700"
      : p === "medium"
      ? "bg-blue-100 text-blue-700"
      : "bg-slate-100 text-slate-700";

  return (
    <>
      <Header title="Compliance & Alerts" actions={headerActions} />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
          <div className="bg-red-50 p-4 rounded-lg border border-red-200">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-red-700">Critical Alerts</p>
              <AlertCircle className="w-5 h-5 text-red-600" strokeWidth={1.5} />
            </div>
            <p className="text-2xl text-red-900">{metrics.critical}</p>
            <p className="text-[11px] text-red-700/70 mt-1">In advance-notice window</p>
          </div>
          <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-amber-700">High Priority</p>
              <Bell className="w-5 h-5 text-amber-600" strokeWidth={1.5} />
            </div>
            <p className="text-2xl text-amber-900">{metrics.high}</p>
            <p className="text-[11px] text-amber-700/70 mt-1">In advance-notice window</p>
          </div>
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-blue-700">Upcoming Deadlines</p>
              <CalendarIcon className="w-5 h-5 text-blue-600" strokeWidth={1.5} />
            </div>
            <p className="text-2xl text-blue-900">{metrics.upcoming}</p>
            <p className="text-[11px] text-blue-700/70 mt-1">Today or later</p>
          </div>
          <div className="bg-green-50 p-4 rounded-lg border border-green-200">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-green-700">Active Alerts</p>
              <Bell className="w-5 h-5 text-green-600" strokeWidth={1.5} />
            </div>
            <p className="text-2xl text-green-900">{metrics.activeAlerts}</p>
            <p className="text-[11px] text-green-700/70 mt-1">Auto-derived from due dates</p>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex gap-2">
              {([
                { key: "dates", label: "Important Dates" },
                { key: "alerts", label: `Active Alerts (${activeAlerts.length})` },
                { key: "recurring", label: "Recurring Alerts" },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key as typeof activeTab)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab.key
                      ? "bg-blue-600 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {loading && (
            <div className="px-6 py-10 text-center text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
            </div>
          )}

          {!loading && activeTab === "dates" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Title</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Category</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Days Remaining</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Advance Notice</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Priority</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {datesWithDays.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No important dates yet. Click "Add Important Date" to create one.
                      </td>
                    </tr>
                  )}
                  {datesWithDays.map((item) => {
                    const overdue = item.daysRemaining < 0;
                    const inWindow =
                      !overdue && item.daysRemaining <= item.advance_notice_days;
                    return (
                      <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <CalendarIcon
                              className={`w-4 h-4 ${
                                item.priority === "critical"
                                  ? "text-red-600"
                                  : item.priority === "high"
                                  ? "text-amber-600"
                                  : "text-blue-600"
                              }`}
                              strokeWidth={1.5}
                            />
                            <span className="text-sm text-slate-900">{item.title}</span>
                          </div>
                          {item.notes && (
                            <div className="text-xs text-slate-500 mt-1 ml-6">{item.notes}</div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {formatDate(item.due_date)}
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs bg-slate-100 text-slate-700">
                            {item.category}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`text-sm ${
                              overdue
                                ? "text-red-600"
                                : inWindow
                                ? "text-amber-600"
                                : "text-slate-600"
                            }`}
                          >
                            {overdue
                              ? `${Math.abs(item.daysRemaining)} days overdue`
                              : item.daysRemaining === 0
                              ? "Today"
                              : `${item.daysRemaining} days`}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {item.advance_notice_days} days
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs capitalize ${priorityBadge(
                              item.priority
                            )}`}
                          >
                            {item.priority}
                          </span>
                        </td>
                        <td className="px-6 py-4 flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEditDate(item)}>
                            <Pencil className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                            Edit
                          </Button>
                          <button
                            type="button"
                            onClick={() => handleDeleteDate(item)}
                            className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                            title="Delete date"
                          >
                            <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!loading && activeTab === "alerts" && (
            <div className="divide-y divide-slate-200">
              {activeAlerts.length === 0 ? (
                <div className="p-6 text-center text-slate-500 text-sm">
                  No active alerts. Alerts surface automatically when an Important Date enters its
                  advance-notice window.
                </div>
              ) : (
                activeAlerts.map((d) => {
                  const isCritical = d.priority === "critical";
                  return (
                    <div
                      key={d.id}
                      className="p-6 flex items-start gap-4 hover:bg-slate-50 transition-colors"
                    >
                      <div className="flex-shrink-0">
                        {isCritical ? (
                          <AlertCircle className="w-5 h-5 text-red-600" strokeWidth={1.5} />
                        ) : d.priority === "high" ? (
                          <AlertCircle className="w-5 h-5 text-amber-600" strokeWidth={1.5} />
                        ) : (
                          <Bell className="w-5 h-5 text-blue-600" strokeWidth={1.5} />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] capitalize ${priorityBadge(
                              d.priority
                            )}`}
                          >
                            {d.priority}
                          </span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-slate-100 text-slate-700">
                            {d.category}
                          </span>
                          {d.kind === "contract_end" && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700">
                              Auto · Contract
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-900">
                          {d.title}{" "}
                          <span className="text-slate-500">
                            — due {formatDate(d.due_date)}
                            {d.daysRemaining === 0
                              ? " (today)"
                              : ` (${d.daysRemaining} day${d.daysRemaining === 1 ? "" : "s"} away)`}
                          </span>
                        </p>
                        {d.notes && (
                          <p className="text-xs text-slate-500 mt-1">{d.notes}</p>
                        )}
                      </div>
                      {d.kind === "important_date" && (
                        <Button variant="ghost" size="sm" onClick={() => openEditDate(d.source)}>
                          Edit
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {!loading && activeTab === "recurring" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Category</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Frequency</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Trigger Day</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Advance Notice</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {recurring.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No recurring alerts yet. Click "Add Recurring Alert" to create one.
                      </td>
                    </tr>
                  )}
                  {recurring.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-900">
                        {r.name}
                        {r.notes && (
                          <div className="text-xs text-slate-500 mt-1">{r.notes}</div>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs bg-slate-100 text-slate-700">
                          {r.category}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{r.frequency}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{r.trigger_day}</td>
                      <td className="px-6 py-4 text-sm text-blue-600">
                        {r.advance_notice_days === 0
                          ? "Same day"
                          : `${r.advance_notice_days} days before`}
                      </td>
                      <td className="px-6 py-4">
                        <button
                          type="button"
                          onClick={() => toggleRec(r)}
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            r.active
                              ? "bg-green-50 text-green-700 hover:bg-green-100"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}
                        >
                          <RotateCcw className="w-3 h-3 mr-1" strokeWidth={1.5} />
                          {r.active ? "Active" : "Inactive"}
                        </button>
                      </td>
                      <td className="px-6 py-4 flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEditRec(r)}>
                          <Pencil className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                          Edit
                        </Button>
                        <button
                          type="button"
                          onClick={() => handleDeleteRec(r)}
                          className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                          title="Delete recurring alert"
                        >
                          <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mt-6 bg-white rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base text-slate-900">Calendar View</h3>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setCalendarMonth((cur) => {
                    const d = new Date(cur.y, cur.m - 1, 1);
                    return { y: d.getFullYear(), m: d.getMonth() };
                  })
                }
              >
                ←
              </Button>
              <span className="text-sm text-slate-700 min-w-[140px] text-center">
                {calendarLabel}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setCalendarMonth((cur) => {
                    const d = new Date(cur.y, cur.m + 1, 1);
                    return { y: d.getFullYear(), m: d.getMonth() };
                  })
                }
              >
                →
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-2">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <div key={day} className="text-center text-xs text-slate-500 py-2">
                {day}
              </div>
            ))}
            {calendarCells.map((cell, idx) => {
              if (cell.day === null) {
                return <div key={idx} className="aspect-square" />;
              }
              const hasEvents = cell.events.length > 0;
              const hasCritical = cell.events.some((e) => e.priority === "critical");
              const hasHigh = cell.events.some((e) => e.priority === "high");
              return (
                <div
                  key={idx}
                  className={`aspect-square flex flex-col items-center justify-center rounded-md text-sm gap-1 ${
                    hasCritical
                      ? "bg-red-100 text-red-900 border border-red-300"
                      : hasHigh
                      ? "bg-amber-100 text-amber-900 border border-amber-300"
                      : hasEvents
                      ? "bg-blue-50 text-blue-900 border border-blue-200"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                  title={cell.events.map((e) => `${e.title} (${e.priority})`).join("\n") || ""}
                >
                  <span>{cell.day}</span>
                  {hasEvents && (
                    <span className="text-[10px] leading-none">
                      {cell.events.length} item{cell.events.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <Modal
        isOpen={isDateAddOpen}
        onClose={() => {
          setIsDateAddOpen(false);
          setDateForm(emptyDateForm());
        }}
        title="Add Important Date"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleAddDate}>
          {renderDateFields(dateForm, setDateForm)}
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submittingDate}>
              {submittingDate ? "Saving…" : "Add Date"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsDateAddOpen(false);
                setDateForm(emptyDateForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isDateEditOpen}
        onClose={() => {
          setIsDateEditOpen(false);
          setEditDateId(null);
        }}
        title="Edit Important Date"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleEditDate}>
          {renderDateFields(editDateForm, setEditDateForm)}
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={editDateSubmitting}>
              {editDateSubmitting ? "Saving…" : "Update"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsDateEditOpen(false);
                setEditDateId(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isRecAddOpen}
        onClose={() => {
          setIsRecAddOpen(false);
          setRecForm(emptyRecurringForm());
        }}
        title="Add Recurring Alert"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleAddRec}>
          {renderRecFields(recForm, setRecForm)}
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submittingRec}>
              {submittingRec ? "Saving…" : "Add Alert"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsRecAddOpen(false);
                setRecForm(emptyRecurringForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isRecEditOpen}
        onClose={() => {
          setIsRecEditOpen(false);
          setEditRecId(null);
        }}
        title="Edit Recurring Alert"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleEditRec}>
          {renderRecFields(editRecForm, setEditRecForm)}
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={editRecSubmitting}>
              {editRecSubmitting ? "Saving…" : "Update"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsRecEditOpen(false);
                setEditRecId(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function renderDateFields(form: DateForm, setForm: (f: DateForm) => void) {
  return (
    <>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Title *</label>
        <input
          required
          type="text"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          placeholder="e.g., Weapon License Renewal"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Date *</label>
          <input
            required
            type="date"
            value={form.due_date}
            onChange={(e) => setForm({ ...form, due_date: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Advance Notice (days) *</label>
          <input
            required
            type="number"
            min={0}
            value={form.advance_notice_days}
            onChange={(e) => setForm({ ...form, advance_notice_days: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Category *</label>
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as ComplianceCategory })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            {COMPLIANCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Priority *</label>
          <select
            value={form.priority}
            onChange={(e) =>
              setForm({ ...form, priority: e.target.value as CompliancePriority })
            }
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Notes</label>
        <textarea
          rows={2}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          placeholder="Optional notes"
        />
      </div>
    </>
  );
}

function renderRecFields(form: RecurringForm, setForm: (f: RecurringForm) => void) {
  return (
    <>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Alert Name *</label>
        <input
          required
          type="text"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          placeholder="e.g., Monthly Tax Filing Reminder"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Category *</label>
          <select
            value={form.category}
            onChange={(e) =>
              setForm({ ...form, category: e.target.value as ComplianceCategory })
            }
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            {COMPLIANCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Frequency *</label>
          <select
            value={form.frequency}
            onChange={(e) =>
              setForm({ ...form, frequency: e.target.value as RecurringFrequency })
            }
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            <option value="Daily">Daily</option>
            <option value="Weekly">Weekly</option>
            <option value="Monthly">Monthly</option>
            <option value="Yearly">Yearly</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Trigger Day *</label>
          <input
            required
            type="text"
            value={form.trigger_day}
            onChange={(e) => setForm({ ...form, trigger_day: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            placeholder={
              form.frequency === "Daily"
                ? "e.g., 09:00"
                : form.frequency === "Weekly"
                ? "e.g., Mon"
                : form.frequency === "Monthly"
                ? "e.g., 13 or Last"
                : "e.g., 03-15"
            }
          />
          <p className="text-[11px] text-slate-500 mt-1">{triggerDayHelp(form.frequency)}</p>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Advance Notice (days) *</label>
          <input
            required
            type="number"
            min={0}
            value={form.advance_notice_days}
            onChange={(e) => setForm({ ...form, advance_notice_days: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={form.active}
          onChange={(e) => setForm({ ...form, active: e.target.checked })}
          className="rounded border-slate-300"
        />
        Active
      </label>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Notes</label>
        <textarea
          rows={2}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          placeholder="Optional notes"
        />
      </div>
    </>
  );
}
