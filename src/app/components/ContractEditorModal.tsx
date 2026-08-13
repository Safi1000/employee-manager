import ThemedSelect from "./ThemedSelect";
import { useEffect, useState } from "react";
import { Plus, Loader2, AlertCircle, X, Trash2, FileText, Upload } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import AddendumTable from "./AddendumTable";
import ClientFilterSelect from "./ClientFilterSelect";
import { useAuth, hasPermission } from "../lib/auth";
import { formatDate } from "../lib/date";
import { hasInjectionPattern } from "../lib/validation";
import {
  supabase,
  CONTRACT_TYPE_LABEL,
  CONTRACT_STATUS_LABEL,
  CONTRACT_LINE_CATEGORY_LABEL,
  isPersonnelCategory,
  type Site,
  CONTRACT_TYPE_LINE_CATEGORIES,
  ADDENDUM_CHANGE_TYPE_LABEL,
  ADDENDUM_SOURCE_LABEL,
  contractLinesValue,
  contractLinesCommitted,
  type Client,
  type Contract,
  type ContractLine,
  type ContractLineCategory,
  type ContractAddendum,
  type AddendumChangeType,
  type AddendumSource,
  type ContractStatus,
  type ContractType,
} from "../lib/supabase";

type ContractFormState = {
  client_id: string;
  contract_type: ContractType;
  start_date: string;
  end_date: string;
  is_infinite: boolean;
  notice_period_days: string;
  // Main's per-shift guard counts — kept as informational SHIFT DETAIL only
  // (the guard count/rate now lives in Contract Lines below).
  day_guards: string;
  night_guards: string;
  evening_guards: string;
  allowed_leaves_per_month: string;
  eobi_deduction: boolean;
  eobi_amount: string;
  annual_escalation_pct: string;
  renewal_terms: string;
  status: ContractStatus;
};

// One editable row in a site's Contract Lines table.
type LineDraft = {
  id?: string; // existing contract_lines.id — absent for new rows
  /** Which SiteDraft this line belongs to. "" = contract-wide (no site). */
  site_key: string;
  /** The shift this line staffs. Blank for hardware lines, which nobody works. */
  shift_code: string;
  category: ContractLineCategory;
  label: string;
  location: string;
  committed_count: string;
  unit_rate: string;
  taxable: boolean;
};

/**
 * A site being edited. `key` is a client-side identity so brand-new sites can own
 * lines before they have a database id.
 */
type SiteDraft = {
  key: string;
  id?: string;
  name: string;
  location: string;
  is_default: boolean;
};

/** Shifts a line can staff. Hardware lines carry none. */
const SHIFT_CODES = ["day", "evening", "night"] as const;
const SHIFT_LABEL: Record<string, string> = {
  day: "Day",
  evening: "Evening",
  night: "Night",
};

/** Lines with no site of their own — kept so older contracts keep working. */
const NO_SITE = "";

let siteKeySeq = 0;
const nextSiteKey = () => `site-${++siteKeySeq}`;

const blankForm = (clientId: string): ContractFormState => ({
  client_id: clientId,
  contract_type: "guard_deployment",
  start_date: new Date().toISOString().slice(0, 10),
  end_date: "",
  is_infinite: false,
  notice_period_days: "",
  day_guards: "0",
  night_guards: "0",
  evening_guards: "0",
  allowed_leaves_per_month: "",
  eobi_deduction: false,
  eobi_amount: "",
  annual_escalation_pct: "",
  renewal_terms: "",
  status: "active",
});

const fromContract = (c: Contract): ContractFormState => ({
  client_id: c.client_id,
  contract_type: c.contract_type,
  start_date: c.start_date,
  end_date: c.end_date ?? "",
  is_infinite: !!c.is_infinite,
  notice_period_days: c.notice_period_days != null ? String(c.notice_period_days) : "",
  day_guards: String(c.day_guards ?? 0),
  night_guards: String(c.night_guards ?? 0),
  evening_guards: String(c.evening_guards ?? 0),
  allowed_leaves_per_month: c.allowed_leaves_per_month != null ? String(c.allowed_leaves_per_month) : "",
  eobi_deduction: c.eobi_deduction,
  eobi_amount: c.eobi_amount != null ? String(c.eobi_amount) : "",
  annual_escalation_pct: c.annual_escalation_pct != null ? String(c.annual_escalation_pct) : "",
  renewal_terms: c.renewal_terms ?? "",
  status: c.status,
});

// The category a fresh line starts on, given the contract's type.
const defaultCategoryFor = (type: ContractType): ContractLineCategory =>
  CONTRACT_TYPE_LINE_CATEGORIES[type][0];

// A blank draft row for a category, belonging to a site.
const blankLine = (category: ContractLineCategory, siteKey = NO_SITE): LineDraft => ({
  site_key: siteKey,
  shift_code: isPersonnelCategory(category) ? "day" : "",
  category,
  label: CONTRACT_LINE_CATEGORY_LABEL[category],
  location: "",
  committed_count: "0",
  unit_rate: "0",
  taxable: true,
});

// Show exactly the lines the contract actually has. A new contract starts with a
// single blank row — pre-seeding all seven categories with zeros only produced
// clutter that the user had to clear out. Further rows come from "+ Add Line".
const seedLines = (
  existing: ContractLine[],
  type: ContractType,
  siteKeyById: Map<string, string>,
): LineDraft[] => {
  if (!existing.length) return [blankLine(defaultCategoryFor(type))];
  return existing.map((l) => ({
    id: l.id,
    site_key: l.site_id ? siteKeyById.get(l.site_id) ?? NO_SITE : NO_SITE,
    shift_code: l.shift_code ?? (isPersonnelCategory(l.category) ? "day" : ""),
    category: l.category,
    label: l.label ?? CONTRACT_LINE_CATEGORY_LABEL[l.category],
    location: l.location ?? "",
    committed_count: String(l.committed_count),
    unit_rate: String(l.unit_rate),
    taxable: l.taxable,
  }));
};

/**
 * The shift window stamped on a shift_definition created from a contract line.
 * start_time, end_time, duration_hours and crosses_midnight are all NOT NULL on
 * the table, so every one of them has to be supplied. These match the standard
 * 12-hour day/night pattern seeded in migration 0116; the times can be edited
 * per site afterwards.
 */
const DEFAULT_SHIFT_WINDOW: Record<
  string,
  { start_time: string; end_time: string; duration_hours: number; crosses_midnight: boolean }
> = {
  day: { start_time: "08:00", end_time: "20:00", duration_hours: 12, crosses_midnight: false },
  evening: { start_time: "16:00", end_time: "00:00", duration_hours: 8, crosses_midnight: true },
  night: { start_time: "20:00", end_time: "08:00", duration_hours: 12, crosses_midnight: true },
};

const num = (s: string) => Number(s) || 0;
const isMeaningful = (l: LineDraft) => num(l.committed_count) > 0 || num(l.unit_rate) > 0;

// New-addendum form (Edit Contract only).
type AddendumForm = {
  target: string; // a contract_lines.id, or "__new__" for a brand-new line
  category: ContractLineCategory; // used when target = "__new__"
  change_type: AddendumChangeType;
  count_delta: string;
  new_rate: string;
  new_end_date: string; // EXTEND_END_DATE: the new contract end date
  new_is_infinite: boolean; // EXTEND_END_DATE: renew to open-ended
  effective_from: string;
  source: AddendumSource;
  reference: string;
};

const blankAddendum = (): AddendumForm => ({
  target: "__new__",
  category: "GUARD",
  change_type: "ADD_HEADCOUNT",
  count_delta: "0",
  new_rate: "",
  new_end_date: "",
  new_is_infinite: false,
  effective_from: new Date().toISOString().slice(0, 10),
  source: "SIGNED_CONTRACT",
  reference: "",
});

/**
 * Shared add/edit contract modal (Phase 1). Used from both the Clients page
 * (client fixed) and the Contracts page (client picked from `clients`). The
 * per-category "Guards per Shift" / "Rates per Guard Type" fields are replaced
 * by a single unified Contract Lines table: one row per category with a
 * committed count and a monthly rate. Contract value = Σ(count × rate).
 */
// §23 lock styling: greys out every disabled control inside a locked fieldset so
// it's clear at a glance the field is locked (not just empty). Reset fieldset
// chrome + keep the form's vertical rhythm inside.
const LOCK_CLS =
  "min-w-0 border-0 p-0 m-0 space-y-3 " +
  "[&_input:disabled]:bg-slate-100 [&_input:disabled]:text-slate-500 [&_input:disabled]:cursor-not-allowed " +
  "[&_textarea:disabled]:bg-slate-100 [&_textarea:disabled]:text-slate-500 [&_textarea:disabled]:cursor-not-allowed " +
  "[&_button:disabled]:bg-slate-100 [&_button:disabled]:text-slate-500 [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-100";

export default function ContractEditorModal({
  isOpen,
  clientId,
  clientName,
  clients,
  contract,
  enableDocument = true,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  /** Fixed client (Clients page). Omit and pass `clients` to show a picker. */
  clientId?: string;
  clientName?: string;
  /** When provided (Contracts page), a client picker is shown in add mode. */
  clients?: Client[];
  contract: Contract | null;
  /** Show the contract-document upload row. Default true. */
  enableDocument?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { profile, company } = useAuth();
  const [form, setForm] = useState<ContractFormState>(blankForm(clientId ?? ""));
  const [lines, setLines] = useState<LineDraft[]>(seedLines([], "guard_deployment", new Map()));
  const [sites, setSites] = useState<SiteDraft[]>([]);
  /**
   * Whether this contract splits its lines across sites. Derived on open from
   * whether its lines actually point at one, so it needs no column of its own and
   * can never drift from the data. Toggling to No moves the lines back to
   * contract-wide; it never deletes the client's sites, which other contracts
   * may still be using.
   */
  const [hasSites, setHasSites] = useState(false);
  /** Site ids present when the modal opened — anything missing now gets deleted. */
  const [loadedSiteIds, setLoadedSiteIds] = useState<string[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [loadingLines, setLoadingLines] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Item 2f: how many contracts the chosen client already has. Non-null means the
  // duplicate-contract confirmation is showing and submission is paused.
  const [duplicateCount, setDuplicateCount] = useState<number | null>(null);

  // Phase 2 — addendums (Edit Contract only).
  const [addendums, setAddendums] = useState<ContractAddendum[]>([]);
  const [addForm, setAddForm] = useState<AddendumForm>(blankAddendum());
  const [addFile, setAddFile] = useState<File | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  // §23 contract lock: existing contracts were originally read-only (changes via
  // addendums only). Per owner request, holders of contracts.edit (super_admin/SSA
  // implicitly) may now edit an existing contract's terms & lines directly; everyone
  // else still sees it locked. Creating a new contract is always fully editable.
  const canEditContracts = hasPermission(profile, "contracts.edit");
  const locked = !!contract && !canEditContracts;

  const loadAddendums = (contractId: string) =>
    supabase
      .from("contract_addendums")
      .select("*")
      .eq("contract_id", contractId)
      .order("effective_from", { ascending: false })
      .then(({ data }) => setAddendums((data ?? []) as ContractAddendum[]));

  useEffect(() => {
    if (!isOpen) return;
    const initial = contract ? fromContract(contract) : blankForm(clientId ?? "");
    setForm(initial);
    setPendingFile(null);
    setError(null);
    setAddForm(blankAddendum());
    setAddFile(null);
    setAddendums([]);
    setDuplicateCount(null);
    // Sites belong to the CLIENT, not the contract, so they load for both add and
    // edit as soon as a client is known — a second contract for the same client
    // edits the same sites.
    const effClient = initial.client_id;
    setLoadingLines(true);
    (async () => {
      const siteRes = effClient
        ? await supabase.from("sites").select("*").eq("client_id", effClient).order("name")
        : { data: [] as Site[], error: null };
      if (siteRes.error) setError(siteRes.error.message);
      const siteRows = (siteRes.data ?? []) as Site[];
      const drafts: SiteDraft[] = siteRows.map((r) => ({
        key: nextSiteKey(),
        id: r.id,
        name: r.name,
        location: r.location ?? "",
        is_default: r.is_default,
      }));
      const keyById = new Map(drafts.map((d) => [d.id!, d.key]));
      setSites(drafts);
      setLoadedSiteIds(siteRows.map((r) => r.id));

      if (contract) {
        const { data, error: err } = await supabase
          .from("contract_lines")
          .select("*")
          .eq("contract_id", contract.id)
          .order("created_at", { ascending: true });
        if (err) setError(err.message);
        const rows = (data ?? []) as ContractLine[];
        let seeded = seedLines(rows, initial.contract_type, keyById);
        const splitBySite = initial.contract_type !== "services" && rows.some((l) => !!l.site_id);
        // Mixed data — some lines sited, some not — would otherwise render a
        // contract-wide block alongside the sites. Adopt the orphans into the
        // first site so "split by site" means exactly that.
        if (splitBySite && drafts.length > 0) {
          const firstKey = drafts[0].key;
          seeded = seeded.map((l) => (l.site_key === NO_SITE ? { ...l, site_key: firstKey } : l));
        }
        setLines(seeded);
        setHasSites(splitBySite);
        loadAddendums(contract.id);
      } else {
        setLines(seedLines([], initial.contract_type, keyById));
        setHasSites(false);
      }
      setLoadingLines(false);
    })();
  }, [isOpen, contract, clientId]);

  // Categories valid for the current contract type (2d). Weapon/Equipment for
  // Services, personnel categories for Guard Deployment — never both.
  const allowedCategories = CONTRACT_TYPE_LINE_CATEGORIES[form.contract_type];

  // Addendums resolve their category through the saved lines, so build the lookup from
  // the drafts that carry an id (unsaved rows can't be an addendum target yet).
  const categoryByLineId = new Map(
    lines.filter((l) => l.id).map((l) => [l.id!, l.category] as const),
  );

  // Switching contract type invalidates any line whose category belongs to the other
  // type, so move those lines onto the new type's default category rather than leaving
  // a select showing a value it no longer offers.
  const onContractTypeChange = (next: ContractType) => {
    const valid = CONTRACT_TYPE_LINE_CATEGORIES[next];
    // Zero the shift split when moving to Services — the section is hidden there,
    // and a stale "8 day guards" left behind on a weapons contract is exactly the
    // kind of figure that later gets reported as real.
    setForm((f) => ({
      ...f,
      contract_type: next,
      ...(next === "services" ? { day_guards: "0", night_guards: "0", evening_guards: "0" } : {}),
    }));
    if (next === "services") setHasSites(false);
    setLines((prev) =>
      prev.map((l) => {
        const base =
          next === "services"
            ? { ...l, site_key: NO_SITE, shift_code: "" }
            : l;
        if (valid.includes(base.category)) return base;
        const cat = valid[0];
        return {
          ...base,
          category: cat,
          shift_code: isPersonnelCategory(cat) ? base.shift_code || "day" : "",
          // Preserve a hand-written label; replace an auto-generated one.
          label:
            base.label === CONTRACT_LINE_CATEGORY_LABEL[base.category]
              ? CONTRACT_LINE_CATEGORY_LABEL[cat]
              : base.label,
        };
      }),
    );
    setAddForm((a) => (valid.includes(a.category) ? a : { ...a, category: valid[0] }));
  };

  const totalCommitted = contractLinesCommitted(
    lines.map((l) => ({ committed_count: num(l.committed_count) })),
  );
  const totalValue = contractLinesValue(
    lines.map((l) => ({ committed_count: num(l.committed_count), unit_rate: num(l.unit_rate) })),
  );

  const updateLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const addLine = (siteKey: string = NO_SITE) =>
    setLines((prev) => [...prev, blankLine(defaultCategoryFor(form.contract_type), siteKey)]);
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  // Sites hang off the client, so nothing can be added before one is chosen.
  const effectiveClientId = form.client_id || clientId || "";

  const isServices = form.contract_type === "services";

  const setUsesSites = (next: boolean) => {
    setHasSites(next);
    if (!next) {
      // Back to one contract-wide set. A line pointing at a site the form no
      // longer shows would save invisibly.
      setLines((prev) => prev.map((l) => ({ ...l, site_key: NO_SITE })));
      return;
    }
    // Split by site means every line sits under a site — there is no
    // contract-wide remainder to fall back on. Any existing lines move to the
    // first site, creating one if the client has none yet, so nothing is
    // stranded where the form can no longer show it.
    setSites((prevSites) => {
      const target =
        prevSites.length > 0
          ? prevSites
          : [{ key: nextSiteKey(), name: "", location: "", is_default: true }];
      const firstKey = target[0].key;
      setLines((prev) =>
        prev.map((l) => (l.site_key === NO_SITE ? { ...l, site_key: firstKey } : l)),
      );
      return target;
    });
  };

  const addSite = () =>
    setSites((prev) => [
      ...prev,
      {
        key: nextSiteKey(),
        name: "",
        location: "",
        // The first site a client gets is the default one postings fall back to.
        is_default: prev.length === 0,
      },
    ]);
  const updateSite = (key: string, patch: Partial<SiteDraft>) =>
    setSites((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  /** Drops the site AND its lines — a line cannot outlive the site it staffs. */
  const removeSite = (key: string) => {
    setSites((prev) => prev.filter((x) => x.key !== key));
    setLines((prev) => prev.filter((l) => l.site_key !== key));
  };

  const linesForSite = (key: string) => lines.filter((l) => l.site_key === key);
  /** A site's shift detail: committed personnel per shift, summed from its lines. */
  const shiftDetailFor = (key: string) => {
    const per: Record<string, number> = { day: 0, evening: 0, night: 0 };
    for (const l of lines) {
      if (l.site_key !== key) continue;
      if (!isPersonnelCategory(l.category)) continue;
      if (!l.shift_code) continue;
      per[l.shift_code] = (per[l.shift_code] ?? 0) + Math.max(0, Math.floor(num(l.committed_count)));
    }
    return per;
  };
  /** Contract-wide per-shift totals — the legacy columns the board still reads. */
  const shiftTotals = (() => {
    const per: Record<string, number> = { day: 0, evening: 0, night: 0 };
    for (const l of lines) {
      if (!isPersonnelCategory(l.category) || !l.shift_code) continue;
      per[l.shift_code] = (per[l.shift_code] ?? 0) + Math.max(0, Math.floor(num(l.committed_count)));
    }
    return per;
  })();

  // Legacy scalar columns are still read by a few display spots; keep them in
  // sync with the lines so nothing downstream shows stale numbers.
  const legacyGuardRate = (() => {
    const guard = lines.find((l) => l.category === "GUARD" && isMeaningful(l));
    const firstMeaningful = lines.find((l) => isMeaningful(l));
    return num((guard ?? firstMeaningful)?.unit_rate ?? "0");
  })();

  const buildContractPayload = (effClientId: string) => ({
    client_id: effClientId,
    contract_type: form.contract_type,
    start_date: form.start_date,
    // An infinite contract has no end date, and only an infinite contract carries a
    // notice period — the DB check constraint enforces the same pairing.
    end_date: form.is_infinite ? null : form.end_date || null,
    is_infinite: form.is_infinite,
    notice_period_days:
      form.is_infinite && form.notice_period_days !== ""
        ? Math.max(1, Math.floor(num(form.notice_period_days)))
        : null,
    // number_of_guards/rate_per_guard_per_month kept in sync for legacy readers;
    // the source of truth is contract_lines. guard_rates is deprecated (0065) and
    // deliberately NOT written here.
    number_of_guards: totalCommitted,
    // Rolled up from the per-site lines rather than typed in twice. The
    // attendance board reads these to decide which shifts a client runs.
    day_guards: shiftTotals.day,
    night_guards: shiftTotals.night,
    evening_guards: shiftTotals.evening,
    rate_per_guard_per_month: legacyGuardRate,
    allowed_leaves_per_month:
      form.allowed_leaves_per_month === "" ? null : Math.max(0, Math.floor(num(form.allowed_leaves_per_month))),
    eobi_deduction: form.eobi_deduction,
    eobi_amount: form.eobi_deduction && form.eobi_amount !== "" ? Number(form.eobi_amount) : null,
    annual_escalation_pct: form.annual_escalation_pct === "" ? null : Number(form.annual_escalation_pct),
    renewal_terms: form.renewal_terms.trim() || null,
    status: form.status,
  });

  /**
   * Save the client's sites, returning draft-key -> saved-site-id so the lines
   * that follow can point at them. Runs before persistLines for that reason.
   *
   * A site with no name is skipped rather than saved blank: it is an empty row
   * the user added and never filled in.
   */
  const persistSites = async (effClientId: string): Promise<Map<string, string>> => {
    // Not a site-based contract: leave the client's sites completely alone. They
    // belong to the client, and another contract may well be using them.
    if (!hasSites) return new Map();
    const named = sites.filter((x) => x.name.trim());
    const keyToId = new Map<string, string>();

    for (const x of named) {
      const payload = {
        client_id: effClientId,
        name: x.name.trim(),
        location: x.location.trim() || null,
        is_default: x.is_default,
      };
      if (x.id) {
        const { error: upErr } = await supabase.from("sites").update(payload).eq("id", x.id);
        if (upErr) throw upErr;
        keyToId.set(x.key, x.id);
      } else {
        const { data, error: insErr } = await supabase
          .from("sites").insert(payload).select("id").single();
        if (insErr) throw insErr;
        keyToId.set(x.key, (data as { id: string }).id);
      }
    }

    // Sites the user removed. Postings and attendance reference a site, so the
    // delete is allowed to fail loudly rather than cascade someone's history away.
    const keptIds = new Set([...keyToId.values()]);
    const goneIds = loadedSiteIds.filter((id) => !keptIds.has(id));
    if (goneIds.length) {
      const { error: delErr } = await supabase.from("sites").delete().in("id", goneIds);
      if (delErr) {
        throw new Error(
          `A site could not be removed because guards are still posted to it. ` +
            `Move them to another site first. (${delErr.message})`,
        );
      }
    }
    return keyToId;
  };

  /**
   * Which shifts each site runs, derived from that site's personnel lines. The
   * attendance board reads shift_definitions to know what a site can be marked
   * for, so a shift that has lines must have a definition and one that lost its
   * lines must lose the definition.
   */
  const persistShiftDefinitions = async (keyToId: Map<string, string>) => {
    if (!hasSites) return;
    for (const [key, siteId] of keyToId) {
      const wanted = new Set(
        lines
          .filter((l) => l.site_key === key && isPersonnelCategory(l.category) && l.shift_code)
          .filter(isMeaningful)
          .map((l) => l.shift_code),
      );
      const { data: existing, error: exErr } = await supabase
        .from("shift_definitions").select("id, shift_code").eq("site_id", siteId);
      if (exErr) throw exErr;
      const have = new Map(
        ((existing ?? []) as { id: string; shift_code: string }[]).map((r) => [r.shift_code, r.id]),
      );

      const toAdd = [...wanted].filter((c) => !have.has(c));
      if (toAdd.length) {
        const { error: insErr } = await supabase.from("shift_definitions").insert(
          toAdd.map((shift_code) => ({
            site_id: siteId,
            shift_code,
            ...(DEFAULT_SHIFT_WINDOW[shift_code] ?? DEFAULT_SHIFT_WINDOW.day),
          })),
        );
        if (insErr) throw insErr;
      }
      const toDrop = [...have].filter(([code]) => !wanted.has(code)).map(([, id]) => id);
      if (toDrop.length) {
        const { error: delErr } = await supabase.from("shift_definitions").delete().in("id", toDrop);
        if (delErr) throw delErr;
      }
    }
  };

  // Reconcile the draft lines against what's stored: insert new meaningful
  // rows, update changed ones, delete rows that became empty.
  const persistLines = async (
    contractId: string,
    existingIds: string[],
    keyToId: Map<string, string>,
  ) => {
    // A line whose site was added but left unnamed has nowhere to live.
    const meaningful = lines.filter(
      (l) => isMeaningful(l) && (l.site_key === NO_SITE || keyToId.has(l.site_key)),
    );
    const keptIds = new Set(meaningful.map((l) => l.id).filter(Boolean) as string[]);
    const rowFor = (l: LineDraft) => ({
      site_id: l.site_key === NO_SITE ? null : keyToId.get(l.site_key) ?? null,
      shift_code: isPersonnelCategory(l.category) ? l.shift_code || null : null,
      category: l.category,
      label: l.label.trim() || CONTRACT_LINE_CATEGORY_LABEL[l.category],
      location: l.location.trim() || null,
      committed_count: Math.max(0, Math.floor(num(l.committed_count))),
      unit_rate: Math.max(0, num(l.unit_rate)),
      taxable: l.taxable,
    });

    const toInsert = meaningful
      .filter((l) => !l.id)
      .map((l) => ({ contract_id: contractId, ...rowFor(l) }));
    if (toInsert.length) {
      const { error: insErr } = await supabase.from("contract_lines").insert(toInsert);
      if (insErr) throw insErr;
    }

    for (const l of meaningful.filter((x) => x.id)) {
      const { error: upErr } = await supabase
        .from("contract_lines")
        .update(rowFor(l))
        .eq("id", l.id!);
      if (upErr) throw upErr;
    }

    const toDelete = existingIds.filter((id) => !keptIds.has(id));
    if (toDelete.length) {
      const { error: delErr } = await supabase.from("contract_lines").delete().in("id", toDelete);
      if (delErr) throw delErr;
    }
  };

  // Upload a file under the contract's Drive folder; returns Drive metadata.
  const uploadToDrive = async (contractId: string, contractCode: string, file: File) => {
    const effectiveCompanyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) throw new Error("Company not loaded — refresh and try again.");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("category", "contracts");
    fd.append("company_id", effectiveCompanyId);
    fd.append("company_name", company.name);
    fd.append("entity_id", contractId);
    fd.append("entity_code", contractCode);
    fd.append("entity_name", contractCode);
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: fd,
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error ?? "Upload failed");
    return json as { drive_file_id: string; drive_view_url: string; file_name?: string };
  };

  const deleteFromDrive = async (driveFileId: string) => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ drive_file_id: driveFileId }),
    });
  };

  const uploadDocument = async (contractId: string, contractCode: string, file: File, existingDriveFileId: string | null) => {
    const json = await uploadToDrive(contractId, contractCode, file);
    if (existingDriveFileId) await deleteFromDrive(existingDriveFileId);
    await supabase
      .from("contracts")
      .update({ drive_file_id: json.drive_file_id, drive_view_url: json.drive_view_url, contract_file_name: json.file_name ?? file.name })
      .eq("id", contractId);
  };

  const handleAddAddendum = async () => {
    if (!contract) return;
    if (hasInjectionPattern(addForm.reference)) {
      setError("Special characters are not allowed in the addendum reference.");
      return;
    }
    setAddSubmitting(true);
    setError(null);
    try {
      const isRenewal = addForm.change_type === "EXTEND_END_DATE";
      const isRate = addForm.change_type === "RATE_CHANGE";
      // A renewal is contract-level (no line/category); validate its target end.
      if (isRenewal && !addForm.new_is_infinite && !addForm.new_end_date) {
        setError("Set a new end date for the renewal, or tick “no end date”.");
        setAddSubmitting(false);
        return;
      }
      const isNewLine = !isRenewal && addForm.target === "__new__";
      const payload: Record<string, unknown> = {
        contract_id: contract.id,
        contract_line_id: isRenewal || isNewLine ? null : addForm.target,
        category: isNewLine ? addForm.category : null,
        change_type: addForm.change_type,
        count_delta: isRate || isRenewal ? 0 : Math.abs(Math.floor(num(addForm.count_delta))),
        new_rate: isRate && addForm.new_rate !== "" ? num(addForm.new_rate) : null,
        new_end_date: isRenewal && !addForm.new_is_infinite ? addForm.new_end_date : null,
        new_is_infinite: isRenewal ? addForm.new_is_infinite : false,
        effective_from: addForm.effective_from,
        source: addForm.source,
        reference: addForm.reference.trim() || null,
      };
      const { data: ins, error: insErr } = await supabase
        .from("contract_addendums")
        .insert(payload)
        .select()
        .single();
      if (insErr) throw insErr;
      if (addFile) {
        const json = await uploadToDrive(contract.id, contract.contract_code, addFile);
        await supabase
          .from("contract_addendums")
          .update({
            drive_file_id: json.drive_file_id,
            drive_view_url: json.drive_view_url,
            reference_file_name: json.file_name ?? addFile.name,
          })
          .eq("id", (ins as ContractAddendum).id);
      }
      setAddForm(blankAddendum());
      setAddFile(null);
      await loadAddendums(contract.id);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Locked contract: the terms & lines are read-only and the only write path is
    // the Addendum form's own "Add Addendum" button. "Save Changes" must never
    // re-write the locked fields — just refresh the parent and close.
    if (locked) {
      onSaved();
      onClose();
      return;
    }
    const effClientId = clientId ?? form.client_id;
    if (!effClientId) {
      setError("Select a client.");
      return;
    }
    // Reject injection-shaped input in the free-text fields (renewal terms +
    // each contract line's label/notes).
    if (hasInjectionPattern(form.renewal_terms)) {
      setError("Special characters are not allowed in Renewal Terms.");
      return;
    }
    const badLine = lines.find((l) => hasInjectionPattern(l.label) || hasInjectionPattern(l.location));
    if (badLine) {
      setError("Special characters are not allowed in contract line label/notes.");
      return;
    }
    if (hasSites) {
      const badSite = sites.find(
        (x) => hasInjectionPattern(x.name) || hasInjectionPattern(x.location),
      );
      if (badSite) {
        setError("Special characters are not allowed in a site name or location.");
        return;
      }
      // An unnamed site cannot be saved, so its lines would be dropped without a
      // word. Say so instead of losing them.
      const unnamedWithLines = sites.find(
        (x) => !x.name.trim() && lines.some((l) => l.site_key === x.key && isMeaningful(l)),
      );
      if (unnamedWithLines) {
        setError("Name every site — a site with no name cannot be saved, and its lines would be lost.");
        return;
      }
      const orphanLines = lines.some((l) => l.site_key === NO_SITE && isMeaningful(l));
      if (orphanLines) {
        setError("Every contract line must sit under a site while “Split by site” is Yes.");
        return;
      }
    }
    // 2f: adding a second contract for a client is legitimate but rarely intended,
    // so make it explicit. Only ask once — a confirmed submit comes straight here.
    if (!contract && duplicateCount === null) {
      const { count, error: cntErr } = await supabase
        .from("contracts")
        .select("id", { count: "exact", head: true })
        .eq("client_id", effClientId);
      if (cntErr) {
        setError(cntErr.message);
        return;
      }
      if ((count ?? 0) > 0) {
        setDuplicateCount(count ?? 0);
        return;
      }
    }
    await persistContract(effClientId);
  };

  const persistContract = async (effClientId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      // Sites first: the lines that follow point at them.
      const keyToId = await persistSites(effClientId);
      if (contract) {
        const { error: upErr } = await supabase.from("contracts").update(buildContractPayload(effClientId)).eq("id", contract.id);
        if (upErr) throw upErr;
        const { data: existing } = await supabase.from("contract_lines").select("id").eq("contract_id", contract.id);
        await persistLines(contract.id, ((existing ?? []) as { id: string }[]).map((r) => r.id), keyToId);
        await persistShiftDefinitions(keyToId);
        if (pendingFile) await uploadDocument(contract.id, contract.contract_code, pendingFile, contract.drive_file_id);
      } else {
        const { data, error: insErr } = await supabase
          .from("contracts")
          .insert(buildContractPayload(effClientId))
          .select()
          .single();
        if (insErr) throw insErr;
        const inserted = data as Contract;
        await persistLines(inserted.id, [], keyToId);
        await persistShiftDefinitions(keyToId);
        if (pendingFile) await uploadDocument(inserted.id, inserted.contract_code, pendingFile, null);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const showClientPicker = !clientId && !!clients && !contract;
  const title = contract
    ? `Edit ${contract.contract_code}`
    : `Add Contract${clientName ? ` — ${clientName}` : ""}`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            form="contract-editor-form"
            variant="primary"
            size="md"
            disabled={submitting}
            className="flex-1"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
            {submitting ? "Saving…" : contract ? "Save Changes" : "Add Contract"}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <form id="contract-editor-form" className="space-y-3" onSubmit={handleSubmit}>
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button type="button" onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <fieldset disabled={locked} className={LOCK_CLS}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {showClientPicker && (
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Client *</label>
              {/* Searchable — the client list runs long. An empty selection is
               * caught by the "Select a client." check in handleSubmit, which is
               * why the native `required` isn't needed here. */}
              <ClientFilterSelect
                clients={clients!}
                value={form.client_id}
                onChange={(v) => setForm({ ...form, client_id: v })}
                allValue=""
                allLabel="— Select client —"
                buttonClassName=""
              />
            </div>
          )}

          <div>
            <label className="block text-sm text-slate-700 mb-1">Contract Type *</label>
            <ThemedSelect
              required
              value={form.contract_type}
              onChange={(e) => onContractTypeChange(e.target.value as ContractType)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              {(["guard_deployment", "services"] as const).map((t) => (
                <option key={t} value={t}>{CONTRACT_TYPE_LABEL[t]}</option>
              ))}
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Status</label>
            <ThemedSelect
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as ContractStatus })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              {(["active", "expired", "terminated", "draft"] as const).map((s) => (
                <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>
              ))}
            </ThemedSelect>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Start Date *</label>
            <input
              required
              type="date"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            {form.is_infinite ? (
              <>
                <label className="block text-sm text-slate-700 mb-1">Notice Period (days) *</label>
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={form.notice_period_days}
                  onChange={(e) => setForm({ ...form, notice_period_days: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                  placeholder="e.g. 30"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Advance notice the client must give to end this contract.
                </p>
              </>
            ) : (
              <>
                <label className="block text-sm text-slate-700 mb-1">End Date</label>
                <input
                  type="date"
                  value={form.end_date}
                  onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                />
              </>
            )}
          </div>

          <div className="col-span-2 -mt-1">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.is_infinite}
                onChange={(e) =>
                  setForm({
                    ...form,
                    is_infinite: e.target.checked,
                    // Entering infinite mode clears the end date; leaving it clears the
                    // notice period. Keeping either would let a stale value be saved.
                    end_date: e.target.checked ? "" : form.end_date,
                    notice_period_days: e.target.checked ? form.notice_period_days : "",
                  })
                }
              />
              No end date / Infinite
            </label>
            <p className="text-[11px] text-slate-500 mt-1 ml-6">
              {form.is_infinite
                ? "Runs indefinitely — still worth reviewing at the 1-year mark, but it will not expire on its own."
                : "Contracts are typically reviewed at the 1-year mark."}
            </p>
          </div>
        </div>

        {/* Shift detail & contract lines.

            A Services contract bills for weapons and equipment: it keeps its
            lines, but nobody staffs them and they sit at no site, so the shift
            column, the shift totals, the sites question and Add Site are all
            hidden for one.

            Otherwise the contract either runs from one place (lines are
            contract-wide) or splits across sites — a mall's gates, a bank's
            branches — which rarely staff identically. Shift detail is never typed
            in separately: it is the per-shift sum of the personnel lines beneath
            it, so the two cannot disagree. */}
        <div className="border border-slate-200 rounded-md overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
            <div>
              <span className="text-sm font-medium text-slate-700">
                {isServices
                  ? "Contract Lines"
                  : hasSites
                    ? "Sites, Shift Detail & Contract Lines"
                    : "Shift Detail & Contract Lines"}
              </span>
              <span className="block text-[11px] text-slate-500">
                {isServices
                  ? "Weapons and equipment — nothing to staff."
                  : hasSites
                    ? "Each site carries its own shifts and lines."
                    : "One set of shifts and lines for the whole contract."}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {!isServices && (
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <span>Split by site?</span>
                <ThemedSelect
                  value={hasSites ? "yes" : "no"}
                  onChange={(e) => setUsesSites(e.target.value === "yes")}
                  className="px-2 py-1.5 border border-slate-200 rounded text-sm"
                >
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </ThemedSelect>
              </label>
              )}
              {!isServices && hasSites && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!effectiveClientId}
                  title={effectiveClientId ? "Add a site under this client" : "Select a client first"}
                  onClick={() => addSite()}
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Site
                </Button>
              )}
            </div>
          </div>

          {hasSites && !effectiveClientId && (
            <p className="px-3 py-4 text-sm text-slate-500">
              Select a client above to add sites.
            </p>
          )}

          {loadingLines ? (
            <div className="px-3 py-6 text-center text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" /> Loading sites &amp; lines…
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {/* Not split by site: one plain block, which is also where legacy
                  lines with no site_id live. */}
              {!hasSites && (
                <SiteLinesBlock
                  title={isServices ? "Lines" : "Shift detail & contract lines"}
                  subtitle=""
                  siteKey={NO_SITE}
                  lines={linesForSite(NO_SITE)}
                  allLines={lines}
                  allowedCategories={allowedCategories}
                  contractType={form.contract_type}
                  shiftDetail={shiftDetailFor(NO_SITE)}
                  onAddLine={() => addLine(NO_SITE)}
                  onUpdateLine={updateLine}
                  onRemoveLine={removeLine}
                />
              )}

              {hasSites && sites.map((site) => (
                <div key={site.key} className="p-3 space-y-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex-1 min-w-48">
                      <label className="block text-xs text-slate-500 mb-1">Site name *</label>
                      <input
                        type="text"
                        value={site.name}
                        onChange={(e) => updateSite(site.key, { name: e.target.value })}
                        placeholder="e.g. Main Gate"
                        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                      />
                    </div>
                    <div className="flex-1 min-w-48">
                      <label className="block text-xs text-slate-500 mb-1">Location</label>
                      <input
                        type="text"
                        value={site.location}
                        onChange={(e) => updateSite(site.key, { location: e.target.value })}
                        placeholder="Optional"
                        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600 pb-2.5" title="Postings made without naming a site land here">
                      <input
                        type="checkbox"
                        checked={site.is_default}
                        onChange={(e) =>
                          setSites((prev) =>
                            prev.map((x) => ({
                              ...x,
                              // Exactly one default per client.
                              is_default: e.target.checked ? x.key === site.key : x.key === site.key ? false : x.is_default,
                            })),
                          )
                        }
                      />
                      Default
                    </label>
                    <button
                      type="button"
                      onClick={() => removeSite(site.key)}
                      className="p-2 rounded text-danger-600 hover:bg-danger-50 mb-1"
                      title="Remove site and its lines"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <SiteLinesBlock
                    title={site.name.trim() || "Unnamed site"}
                    subtitle=""
                    siteKey={site.key}
                    lines={linesForSite(site.key)}
                    allLines={lines}
                    allowedCategories={allowedCategories}
                    contractType={form.contract_type}
                    shiftDetail={shiftDetailFor(site.key)}
                    onAddLine={() => addLine(site.key)}
                    onUpdateLine={updateLine}
                    onRemoveLine={removeLine}
                  />
                </div>
              ))}

              {hasSites && sites.length === 0 && effectiveClientId && (
                <p className="px-3 py-4 text-sm text-slate-500">
                  No sites yet. Add one to record what this contract staffs.
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-t border-slate-200 text-sm">
            <span className="text-slate-600">
              {!isServices && (
                <>
                  Day {shiftTotals.day} · Evening {shiftTotals.evening} · Night {shiftTotals.night}
                  <span className="text-slate-400"> · </span>
                </>
              )}
              {totalCommitted} committed
            </span>
            <span className="font-medium text-slate-800 tabular-nums">
              PKR {totalValue.toLocaleString()}
            </span>
          </div>
          <p className="px-3 py-2 text-[11px] text-slate-500">
            Contract value = Σ (committed count × rate). Only rows with a count or rate are saved.
          </p>
        </div>
        </fieldset>

        {/* Addendums — only for existing contracts (can't addend what isn't created) */}
        {contract && (
          <div className="border border-slate-200 rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
              <span className="text-sm font-medium text-slate-700">Addendums</span>
              <span className="text-[11px] text-slate-500 ml-2">
                Dated changes to committed count / rate — the contract's base lines are never altered.
              </span>
            </div>

            {addendums.length > 0 && (
              <AddendumTable addendums={addendums} categoryByLineId={categoryByLineId} />
            )}

            {/* Add-addendum form */}
            <div className="p-3 border-t border-slate-200 bg-slate-50/50 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-slate-600 mb-1">Applies to</label>
                <ThemedSelect
                  value={addForm.change_type === "EXTEND_END_DATE" ? "__contract__" : addForm.target}
                  disabled={addForm.change_type === "EXTEND_END_DATE"}
                  onChange={(e) => setAddForm({ ...addForm, target: e.target.value })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm disabled:bg-slate-100 disabled:text-slate-500"
                >
                  {addForm.change_type === "EXTEND_END_DATE" ? (
                    <option value="__contract__">Whole contract</option>
                  ) : (
                    <>
                      <option value="__new__">New line…</option>
                      {lines
                        .filter((l) => l.id)
                        .map((l) => (
                          <option key={l.id} value={l.id!}>
                            {CONTRACT_LINE_CATEGORY_LABEL[l.category]}
                            {l.location ? ` — ${l.location}` : ""}
                          </option>
                        ))}
                    </>
                  )}
                </ThemedSelect>
              </div>
              {addForm.change_type !== "EXTEND_END_DATE" && addForm.target === "__new__" && (
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">New line category</label>
                  <ThemedSelect
                    value={addForm.category}
                    onChange={(e) => setAddForm({ ...addForm, category: e.target.value as ContractLineCategory })}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                  >
                    {allowedCategories.map((cat) => (
                      <option key={cat} value={cat}>{CONTRACT_LINE_CATEGORY_LABEL[cat]}</option>
                    ))}
                  </ThemedSelect>
                </div>
              )}
              <div>
                <label className="block text-[11px] text-slate-600 mb-1">Change type</label>
                <ThemedSelect
                  value={addForm.change_type}
                  onChange={(e) => setAddForm({ ...addForm, change_type: e.target.value as AddendumChangeType })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                >
                  {(["ADD_HEADCOUNT", "REDUCE_HEADCOUNT", "RATE_CHANGE", "EXTEND_END_DATE"] as const).map((t) => (
                    <option key={t} value={t}>{ADDENDUM_CHANGE_TYPE_LABEL[t]}</option>
                  ))}
                </ThemedSelect>
              </div>
              {addForm.change_type === "EXTEND_END_DATE" ? (
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">New end date</label>
                  <input
                    type="date"
                    value={addForm.new_end_date}
                    disabled={addForm.new_is_infinite}
                    onChange={(e) => setAddForm({ ...addForm, new_end_date: e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm disabled:bg-slate-100 disabled:text-slate-500"
                  />
                  <label className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addForm.new_is_infinite}
                      onChange={(e) => setAddForm({ ...addForm, new_is_infinite: e.target.checked })}
                    />
                    No end date (open-ended)
                  </label>
                </div>
              ) : addForm.change_type === "RATE_CHANGE" ? (
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">New rate / month</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={addForm.new_rate}
                    onChange={(e) => setAddForm({ ...addForm, new_rate: e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">Headcount delta</label>
                  <input
                    type="number"
                    min="0"
                    value={addForm.count_delta}
                    onChange={(e) => setAddForm({ ...addForm, count_delta: e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                  />
                </div>
              )}
              <div>
                <label className="block text-[11px] text-slate-600 mb-1">Effective from</label>
                <input
                  type="date"
                  value={addForm.effective_from}
                  onChange={(e) => setAddForm({ ...addForm, effective_from: e.target.value })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-600 mb-1">Source</label>
                <ThemedSelect
                  value={addForm.source}
                  onChange={(e) => setAddForm({ ...addForm, source: e.target.value as AddendumSource })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                >
                  {(["SIGNED_CONTRACT", "EMAIL", "VERBAL", "OTHER"] as const).map((s) => (
                    <option key={s} value={s}>{ADDENDUM_SOURCE_LABEL[s]}</option>
                  ))}
                </ThemedSelect>
              </div>
              <div className="col-span-2">
                <label className="block text-[11px] text-slate-600 mb-1">Reference (text)</label>
                <input
                  type="text"
                  value={addForm.reference}
                  onChange={(e) => setAddForm({ ...addForm, reference: e.target.value })}
                  placeholder="e.g. Email dated 2026-05-01, or note"
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                />
              </div>
              <div className="col-span-2 flex items-center justify-between gap-2">
                <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 text-xs border border-dashed border-slate-300 rounded hover:bg-slate-50">
                  <Upload className="w-3.5 h-3.5" />
                  {addFile ? addFile.name : "Attach reference document (optional)"}
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setAddFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <Button type="button" variant="secondary" size="sm" disabled={addSubmitting} onClick={handleAddAddendum}>
                  {addSubmitting ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
                  Add Addendum
                </Button>
              </div>
            </div>
          </div>
        )}

        <fieldset disabled={locked} className={LOCK_CLS}>
        {/* Contract terms — leave allowance and EOBI are the values payroll and
            attendance read for every employee on this contract. */}
        <div className="border border-slate-200 rounded-md p-3">
          <div className="text-sm font-medium text-slate-700 mb-2">Contract terms</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Allowed Leaves / month</label>
              <input
                type="number"
                min="0"
                value={form.allowed_leaves_per_month}
                onChange={(e) => setForm({ ...form, allowed_leaves_per_month: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="Inherits client default if blank"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Annual Escalation %</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.annual_escalation_pct}
                onChange={(e) => setForm({ ...form, annual_escalation_pct: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="e.g. 10"
              />
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm text-slate-700 mb-1">
                <input
                  type="checkbox"
                  checked={form.eobi_deduction}
                  onChange={(e) => setForm({ ...form, eobi_deduction: e.target.checked })}
                />
                EOBI deduction
              </label>
              {form.eobi_deduction && (
                <input
                  type="number"
                  min="0"
                  value={form.eobi_amount}
                  onChange={(e) => setForm({ ...form, eobi_amount: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                  placeholder="Per-employee EOBI"
                />
              )}
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Renewal Terms</label>
              <textarea
                value={form.renewal_terms}
                onChange={(e) => setForm({ ...form, renewal_terms: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="Free text for special clauses"
              />
            </div>
          </div>
        </div>

        {enableDocument && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Contract Document</label>
            {contract?.drive_view_url && !pendingFile ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2 border border-slate-200 rounded-md">
                <a
                  href={contract.drive_view_url}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
                >
                  <FileText className="w-4 h-4" />
                  {contract.contract_file_name ?? "Current document"}
                </a>
                <label className="cursor-pointer px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50">
                  Replace
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setPendingFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            ) : (
              <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-2 text-sm border border-dashed border-slate-300 rounded hover:bg-slate-50 w-full">
                <Upload className="w-4 h-4" />
                {pendingFile ? pendingFile.name : "Choose scanned contract (uploads to Drive on Save)"}
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setPendingFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
        )}
        </fieldset>

      </form>

      {/* 2f: this client already has a contract — confirm before adding another. */}
      <Modal
        isOpen={duplicateCount !== null}
        onClose={() => setDuplicateCount(null)}
        title="This client already has a contract"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {clientName ?? "This client"} already has {duplicateCount}{" "}
            {duplicateCount === 1 ? "contract" : "contracts"}. Adding another is allowed —
            confirm that this is a genuinely separate contract and not a duplicate.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="md" onClick={() => setDuplicateCount(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={submitting}
              onClick={() => persistContract(clientId ?? form.client_id)}
            >
              {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Add anyway
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
}


/**
 * One site's contract lines, with its shift detail shown above them. The detail
 * is derived from the lines rather than entered, so the two can never disagree —
 * which is exactly what went wrong when shift counts lived on the contract and
 * the lines lived separately.
 */
function SiteLinesBlock({
  title, subtitle, siteKey, lines, allLines, allowedCategories, contractType,
  shiftDetail, onAddLine, onUpdateLine, onRemoveLine,
}: {
  title: string;
  subtitle: string;
  siteKey: string;
  lines: LineDraft[];
  allLines: LineDraft[];
  allowedCategories: ContractLineCategory[];
  contractType: ContractType;
  shiftDetail: Record<string, number>;
  onAddLine: () => void;
  onUpdateLine: (idx: number, patch: Partial<LineDraft>) => void;
  onRemoveLine: (idx: number) => void;
}) {
  // Row indices are into the FLAT draft list, which is what the mutators expect.
  const indexOf = (l: LineDraft) => allLines.indexOf(l);
  const showShifts = contractType !== "services";

  return (
    <div className="border border-slate-200 rounded-md overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
        <div className="min-w-0">
          <span className="text-sm font-medium text-slate-700">{title}</span>
          {subtitle && <span className="text-[11px] text-slate-500 ml-2">{subtitle}</span>}
          {showShifts && (
            <span className="block text-[11px] text-slate-500">
              Shift detail — Day {shiftDetail.day ?? 0} · Evening {shiftDetail.evening ?? 0} · Night{" "}
              {shiftDetail.night ?? 0}
            </span>
          )}
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onAddLine}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Add Line
        </Button>
      </div>

      {lines.length === 0 ? (
        <p className="px-3 py-4 text-sm text-slate-500">No lines yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase border-b border-slate-200">
                <th className="text-left px-3 py-2">Category</th>
                {showShifts && <th className="text-left px-3 py-2 w-32">Shift</th>}
                <th className="text-left px-3 py-2">Notes</th>
                <th className="text-right px-3 py-2 w-28">Committed</th>
                <th className="text-right px-3 py-2 w-36">Rate / month</th>
                <th className="text-right px-3 py-2 w-32">Line value</th>
                <th className="px-2 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l) => {
                const idx = indexOf(l);
                const personnel = isPersonnelCategory(l.category);
                return (
                  <tr key={l.id ?? `${siteKey}-${idx}`}>
                    <td className="px-3 py-1.5">
                      <ThemedSelect
                        value={l.category}
                        onChange={(e) => {
                          const cat = e.target.value as ContractLineCategory;
                          onUpdateLine(idx, {
                            category: cat,
                            label:
                              l.label === CONTRACT_LINE_CATEGORY_LABEL[l.category]
                                ? CONTRACT_LINE_CATEGORY_LABEL[cat]
                                : l.label,
                            // Hardware is not staffed, so it carries no shift.
                            shift_code: isPersonnelCategory(cat) ? l.shift_code || "day" : "",
                          });
                        }}
                        className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                      >
                        {allowedCategories.map((cat) => (
                          <option key={cat} value={cat}>{CONTRACT_LINE_CATEGORY_LABEL[cat]}</option>
                        ))}
                      </ThemedSelect>
                    </td>
                    {showShifts && (
                      <td className="px-3 py-1.5">
                        {personnel ? (
                          <ThemedSelect
                            value={l.shift_code}
                            onChange={(e) => onUpdateLine(idx, { shift_code: e.target.value })}
                            className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                          >
                            {SHIFT_CODES.map((c) => (
                              <option key={c} value={c}>{SHIFT_LABEL[c]}</option>
                            ))}
                          </ThemedSelect>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-1.5">
                      <input
                        type="text"
                        value={l.location}
                        onChange={(e) => onUpdateLine(idx, { location: e.target.value })}
                        className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        type="number"
                        min="0"
                        value={l.committed_count}
                        onChange={(e) => onUpdateLine(idx, { committed_count: e.target.value })}
                        className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={l.unit_rate}
                        onChange={(e) => onUpdateLine(idx, { unit_rate: e.target.value })}
                        className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-600 tabular-nums">
                      {(num(l.committed_count) * num(l.unit_rate)).toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => onRemoveLine(idx)}
                        className="p-1 rounded text-danger-600 hover:bg-danger-50"
                        title="Remove line"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
