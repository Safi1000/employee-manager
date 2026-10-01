// Pure formatters, lifted in spirit from the web app's lib/date.ts + money helpers.

export const pkr = (n: number | null | undefined, opts: { sign?: boolean; compact?: boolean } = {}) => {
  const v = Number(n ?? 0);
  const abs = Math.abs(v);
  let body: string;
  if (opts.compact && abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  else if (opts.compact && abs >= 100_000) body = `${(abs / 1000).toFixed(0)}K`;
  else body = Math.round(abs).toLocaleString("en-US");
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  return `${sign}PKR ${body}`;
};

export const num = (n: number | null | undefined) => Math.round(Number(n ?? 0)).toLocaleString("en-US");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const parse = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};

export const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};

export const fmtDate = (s?: string | null) => {
  if (!s) return "—";
  const d = parse(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

export const fmtShort = (s?: string | null) => {
  if (!s) return "—";
  const d = parse(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

export const fmtDay = (s: string) => {
  const d = parse(s);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

export const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

export const fmtTime = (s: string) => {
  const d = new Date(s);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);

export const daysInMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function words(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? "-" + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + words(n % 100) : "");
  if (n < 100_000) return words(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + words(n % 1000) : "");
  if (n < 10_000_000) return words(Math.floor(n / 100_000)) + " lakh" + (n % 100_000 ? " " + words(n % 100_000) : "");
  return words(Math.floor(n / 10_000_000)) + " crore" + (n % 10_000_000 ? " " + words(n % 10_000_000) : "");
}

/** The web app's <AmountInWords/>: renders nothing for blank / 0 / NaN. */
export const amountInWords = (v: string | number) => {
  const n = Math.floor(Number(v));
  if (!n || Number.isNaN(n) || n < 0) return "";
  const w = words(n);
  return `Rupees ${w} only`.replace(/^./, (c) => c.toUpperCase());
};
