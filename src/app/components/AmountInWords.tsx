import { amountInWords } from "../lib/supabase";

/**
 * The small italic grey "Rupees … Only" line shown under a monetary amount,
 * matching the Invoice Total Due treatment. Renders nothing for a blank / zero /
 * non-numeric value so an empty input stays clean.
 */
export default function AmountInWords({ value, className = "" }: { value: number | string | null | undefined; className?: string }) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(n) || n === 0) return null;
  return (
    <p className={`text-[11px] italic text-muted-foreground mt-1 ${className}`}>{amountInWords(n)}</p>
  );
}
