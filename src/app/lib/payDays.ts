/**
 * PAY DAYS (Shayan, 6 Nov 2026): present + double duties + leaves up to the
 * allowance. The live payroll row carries it as effective_present_days — the
 * figure salary is earned on (PayrollManagement).
 *
 * A saved payslip does not store it, nor the double duties or the allowance it
 * was built from. But the salary it records was earned as per-day rate × pay
 * days, so on a saved slip it is read back from the money:
 *   (final salary − allowance − bonus) ÷ per-day rate
 * shown only when that is a whole number (± 0.05, the per-day rate is stored
 * rounded). Anything else returns null — a blank, never a guess.
 */
export function payDaysFromSlip(s: {
  final_salary?: number | string | null;
  allowance?: number | string | null;
  bonus?: number | string | null;
  per_day_salary?: number | string | null;
}): number | null {
  const perDay = Number(s.per_day_salary ?? 0);
  if (s.final_salary == null || !(perDay > 0)) return null;
  const earned = Math.round(Number(s.final_salary)) - Math.round(Number(s.allowance ?? 0)) - Math.round(Number(s.bonus ?? 0));
  const days = earned / perDay;
  return Math.abs(days - Math.round(days)) < 0.05 ? Math.round(days) : null;
}
