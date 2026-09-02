// Drill-down from the ledger to the document that produced it.
//
// Every journal line carries source_table + source_id. The Journal screen links
// with BOTH — `?focus=<id>&focusType=<source_table>` — and this is what a
// destination uses to open on that record instead of on its section.
//
// WHY focusType AND NOT JUST focus. Three destinations serve two source tables
// each: /invoices takes invoices and invoice_payments, /payroll takes payslips
// and advances, /treasury takes cheques and bank_transfers. A bare uuid does
// not say which table it belongs to, so a page that looked up `focus` alone
// would search the wrong table half the time and silently find nothing — the
// same "looks like it worked" failure this replaces.
//
// A destination reads its own source table, so a /invoices page asking for
// "invoice_payments" gets the id only when the link meant a payment.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

/**
 * The record this page was asked to open on, or null.
 *
 * `sourceTable` is what the CALLER handles. Pass the same string that appears
 * in journal_entries.source_table.
 *
 * A link with no focusType is treated as belonging to the first source table
 * that asks — older links did not carry the type, and a page that ignored them
 * would regress the unambiguous destinations.
 */
export function useFocusTarget(sourceTable: string): string | null {
  const [params] = useSearchParams();
  const focus = params.get("focus");
  const type = params.get("focusType");
  if (!focus) return null;
  if (type && type !== sourceTable) return null;
  return focus;
}

/**
 * Scrolls a focused row into view and marks it, once, when it appears.
 *
 * Returns a ref callback to put on the row element. The row may not exist on
 * the first render — the page is usually still loading, or the record is behind
 * a filter the page has yet to widen — so this waits for the element rather
 * than firing on mount and missing it.
 *
 * `onSettled` fires after the row has been reached, so a caller can drop the
 * query parameter and leave a clean URL.
 */
export function useFocusRow(focusId: string | null, onSettled?: () => void) {
  const doneRef = useRef<string | null>(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  return useCallback(
    (el: HTMLElement | null) => {
      if (!el || !focusId || doneRef.current === focusId) return;
      doneRef.current = focusId;
      // Let the row finish laying out before measuring it.
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        settledRef.current?.();
      });
    },
    [focusId],
  );
}

/** The classes that mark a focused row. Kept here so every screen marks it the same. */
export const FOCUS_ROW_CLASS =
  "ring-2 ring-brand-500 ring-inset bg-brand-50/60 animate-[pulse_1.2s_ease-in-out_2]";

/**
 * True once, after the page has had a chance to open on the focused record.
 *
 * A destination that cannot show the record — it was deleted, or it belongs to
 * a region the viewer cannot see — must say so rather than sit on the section
 * page looking like the link worked. Call this with whether the record was
 * found; it returns the message to show, or null.
 */
export function useFocusMiss(
  focusId: string | null,
  loading: boolean,
  found: boolean,
): string | null {
  const [miss, setMiss] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId || loading) {
      setMiss(null);
      return;
    }
    setMiss(
      found
        ? null
        : "The record this ledger entry points at is not on this screen — it may have been deleted, or it may be outside the region you can see.",
    );
  }, [focusId, loading, found]);
  return miss;
}
