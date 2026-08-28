import { formatDate } from "./date";

// ── The one place that decides whether a date is markable for a guard ────────
// Attendance may only be marked while the guard is actually employed AND their
// contract is running. This mirrors the DB rules in migration 0152
// (attendance_gate + the enforce_attendance_window trigger) so the UI can grey
// a day out before the write is attempted; the DB remains the authority and
// rejects anything that slips past — including bulk paths.
//
// Separation semantics: `last_working_day` is the final day actually worked, so
// it stays markable. `termination_date` is the day the separation takes effect
// ("the date the employee is fired") and is NOT markable — the Fire flow writes
// both to the same date, so firing on the 10th makes the 10th unmarkable.

// Every lifecycle state that means "no longer employed". The DB enum carries
// both the original 'terminated'/'left' and the Phase-3A 'fired'/'absconded'
// values, and separations land on different ones depending on the reason:
//   termination_misconduct / termination_performance → fired
//   absconded                                        → absconded
//   resignation and everything else                  → left
export const SEPARATED_LIFECYCLE_STATES = [
  "terminated",
  "fired",
  "left",
  "absconded",
] as const;

export const isSeparatedState = (state: string | null | undefined): boolean =>
  SEPARATED_LIFECYCLE_STATES.includes(String(state ?? "") as (typeof SEPARATED_LIFECYCLE_STATES)[number]);

/**
 * The human status for a badge. A separated employee reads as Fired / Resigned /
 * Absconded by separation type, but as "Terminated" when they were left
 * ineligible for rehire — a hard exit. Non-separated employees keep their live
 * status (Active / On Leave / Inactive).
 *
 * Shared so every screen says the same word about the same person: the legacy
 * `status` column only knows "Inactive", which is why Payroll used to label a
 * fired guard the same as anyone else who wasn't currently active.
 */
export const lifecycleStatusLabel = (e: {
  lifecycle_state: string;
  status: string;
  eligible_for_rehire?: boolean | null;
}): string => {
  if (!isSeparatedState(e.lifecycle_state)) return e.status;
  if (e.eligible_for_rehire === false) return "Terminated";
  switch (e.lifecycle_state) {
    case "left":
      return "Resigned";
    case "absconded":
      return "Absconded";
    default:
      return "Fired"; // terminated / fired
  }
};

export type WindowEmployee = {
  join_date?: string | null;
  last_working_day?: string | null;
  termination_date?: string | null;
  /** Written by every exit path, including ones that set no other date. */
  exit_date?: string | null;
  lifecycle_state?: string | null;
};

export type WindowContract = {
  start_date?: string | null;
  end_date?: string | null;
  is_infinite?: boolean | null;
} | null | undefined;

/**
 * Why `date` (YYYY-MM-DD) can't be marked for this guard, or null when it can.
 * Pass the guard's contract when known — a null contract simply skips the
 * contract-window checks (office staff and unassigned guards have none).
 * Does NOT cover the future-date, closed-period or backdate-override rules;
 * those stay where they already live (attendance_gate / the calling screens).
 */
export function attendanceWindowError(
  emp: WindowEmployee,
  contract: WindowContract,
  date: string,
): string | null {
  if (emp.lifecycle_state === "archived") return "Record archived.";

  if (emp.join_date && date < emp.join_date) {
    return `Not employed before ${formatDate(emp.join_date)}.`;
  }
  // The separation date itself is out — see the note above.
  if (emp.termination_date && date >= emp.termination_date) {
    return `Separated on ${formatDate(emp.termination_date)} — that date and later can't be marked.`;
  }
  if (emp.last_working_day && date > emp.last_working_day) {
    return `Employment ended ${formatDate(emp.last_working_day)}.`;
  }
  // A separated guard carrying NEITHER date. The Lifecycle panel's exit used to
  // write only exit_date and leave both of the above null (migration 0183 fixes
  // the function and backfills the records), and with no bound the month export
  // showed such a guard as ordinarily employed all the way through — no X marks,
  // no separation note, months after they left.
  if (isSeparatedState(emp.lifecycle_state) && !emp.termination_date && !emp.last_working_day) {
    if (emp.exit_date && date >= emp.exit_date) {
      return `Separated on ${formatDate(emp.exit_date)} — that date and later can't be marked.`;
    }
    if (!emp.exit_date) return "No longer employed.";
  }

  if (contract) {
    if (contract.start_date && date < contract.start_date) {
      return `Contract starts ${formatDate(contract.start_date)}.`;
    }
    if (!contract.is_infinite && contract.end_date && date > contract.end_date) {
      return `Contract ended ${formatDate(contract.end_date)}.`;
    }
  }
  return null;
}

/**
 * A contract row as the client-coverage builder needs to read it.
 */
export type CoverageContract = {
  client_id?: string | null;
  end_date?: string | null;
  is_infinite?: boolean | null;
  status?: string | null;
};

/**
 * Per-client attendance coverage, keyed by client id.
 *
 * Most guards are attached to a CLIENT but carry no contract_id of their own —
 * on this database, 316 of 535 — so `attendanceWindowError` was handed a null
 * contract for them and skipped the contract window entirely. The client's
 * contract could have ended months ago and their attendance stayed markable.
 * This closes that hole by giving every such guard their client's coverage as a
 * stand-in contract.
 *
 * Deliberately conservative — it only ever supplies an END date:
 *   • A client with no contracts on file is not covered here at all. Absence of
 *     data is not evidence the client's work has stopped.
 *   • One open-ended contract (is_infinite, or simply no end_date recorded)
 *     leaves the client open-ended. Most contracts here have a null end_date,
 *     and reading that as "ended" would lock the whole roster out.
 *   • Draft contracts are ignored — they are not in force yet.
 *   • The LATEST end date across the client's contracts wins, so a renewal on a
 *     second contract row extends coverage rather than fighting the old one.
 * No start date is derived: back-marking a period that predates when contracts
 * were first entered is legitimate, and blocking it would be a regression.
 */
export function buildClientCoverage(
  contracts: CoverageContract[],
): Map<string, WindowContract> {
  // clientId → latest end date, or null once any contract is open-ended.
  const latestEnd = new Map<string, string | null>();
  const openEnded = new Set<string>();

  for (const c of contracts) {
    const clientId = c.client_id;
    if (!clientId) continue;
    if (c.status === "draft") continue;
    if (c.is_infinite || !c.end_date) {
      openEnded.add(clientId);
      continue;
    }
    const prev = latestEnd.get(clientId);
    if (prev === undefined || c.end_date > prev!) latestEnd.set(clientId, c.end_date);
  }

  const coverage = new Map<string, WindowContract>();
  for (const [clientId, end] of latestEnd) {
    if (openEnded.has(clientId) || !end) continue;
    coverage.set(clientId, { start_date: null, end_date: end, is_infinite: false });
  }
  return coverage;
}

/**
 * The contract window to judge a guard's attendance against: their own contract
 * when they have one, otherwise their client's overall coverage. Returns null
 * when neither is known, which `attendanceWindowError` reads as "no contract
 * window to enforce".
 */
export function effectiveWindowContract(
  emp: { contract_id?: string | null; client_id?: string | null },
  contractById: Map<string, WindowContract>,
  clientCoverage: Map<string, WindowContract>,
): WindowContract {
  if (emp.contract_id) {
    const own = contractById.get(emp.contract_id);
    if (own) return own;
  }
  return emp.client_id ? clientCoverage.get(emp.client_id) ?? null : null;
}

/**
 * Whether a separated guard should be dropped from the attendance roster for
 * `date`, rather than shown as a locked row. They disappear from their
 * separation date (the last working day) onward; before it they still appear so
 * their final days can be marked. Non-separated guards are never hidden.
 * The cutoff mirrors the lock boundary in attendanceWindowError.
 */
export function hiddenFromAttendance(emp: WindowEmployee, date: string): boolean {
  if (!isSeparatedState(emp.lifecycle_state)) return false;
  // exit_date is the third rung because the Lifecycle panel's exit used to write
  // ONLY that one — no last_working_day, no termination_date (fixed in migration
  // 0183, which also backfills). Reading it here means a guard separated that way
  // leaves the roster on the correct day even on a database where the backfill
  // has not been applied yet.
  const cutoff = emp.termination_date ?? emp.last_working_day ?? emp.exit_date;
  // No date at all anywhere: the record says separated, so the guard is off the
  // roster. Returning false here — the old behaviour — is what kept guards fired
  // in July on the August board indefinitely. A missing date is bad data, and
  // showing a separated man as deployed is the worse of the two failures.
  return cutoff ? date >= cutoff : true;
}

/** Short marker for the attendance export's day cells (see exportAttendance). */
export const SEPARATION_MARK = "X";
