// 0650: does this person have a base salary on record? The same test the
// database applies (enforce_pay_on_record) before anyone is posted, moved to
// another category, or rehired — so a screen can ask for the salary up front
// instead of letting the database refuse after the operator has filled the form.
//
// The database also accepts a salary-history row (a forward-dated salary lives
// only there). Screens do not read history here, so they ask a little more
// often than the database would refuse; never less.
export const hasPayOnRecord = (e: {
  base_salary?: number | string | null;
  pay_basis?: string | null;
  daily_rate?: number | string | null;
}): boolean =>
  Number(e.base_salary ?? 0) > 0 || (e.pay_basis === "per_day" && Number(e.daily_rate ?? 0) > 0);

/** A typed base salary, or the reason it is not one. */
export const baseSalaryError = (v: string): string | null => {
  if (!v.trim()) return "Base salary is required.";
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "Enter a base salary above zero.";
  return null;
};
