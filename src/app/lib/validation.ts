// Shared form-field validation (introduced to close the gap that let "1=1" be
// saved into NTN/STRN). Every validator returns an error message string, or
// null when the value is acceptable. Empty values are treated as VALID here —
// required-ness is enforced separately by each form — so optional fields left
// blank never error.
//
// Rules are deliberately PERMISSIVE about legitimate real-world data (13-digit
// NTNs, landlines, international numbers, apostrophes in names like O'Brien) and
// strict only about clearly-malformed or injection-shaped input.

const isBlank = (v: string | null | undefined): boolean => !v || v.trim() === "";
const digitsOnly = (v: string): string => v.replace(/\D/g, "");

// --- Injection detection for free-text fields (names, addresses, notes) -------
// Flags injection-SHAPED input (1=1, <script>, ; DROP, ' OR '1, SQL comments)
// WITHOUT blocking ordinary punctuation: apostrophes (O'Brien), commas, periods,
// #, /, single hyphens, & and parentheses in addresses all pass. English words
// like "update"/"select"/"create" in a note are NOT blocked on their own — only
// when they appear in genuine injection syntax.
const INJECTION_PATTERNS: RegExp[] = [
  /<\s*\/?\s*script/i,                                   // <script> / </script>
  /<[a-z][^>]*>/i,                                       // any HTML tag
  /\bon\w+\s*=\s*["']?/i,                                // onerror= / onclick=
  /(^|\s)--(\s|$)/,                                      // SQL line comment
  /\/\*|\*\//,                                           // SQL block comment
  /\b\d+\s*=\s*\d+\b/,                                   // 1=1
  /['"]\s*(or|and)\s+['"\d]/i,                           // ' or '1  /  ' and 1
  /;\s*(drop|delete|truncate|update|insert|alter|create|exec|execute)\b/i,
  /\b(union\s+select|drop\s+table|insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i,
];

export function hasInjectionPattern(value: string | null | undefined): boolean {
  if (isBlank(value)) return false;
  const s = (value as string).trim();
  return INJECTION_PATTERNS.some((p) => p.test(s));
}

export function validateFreeText(value: string | null | undefined): string | null {
  return hasInjectionPattern(value) ? "Special characters are not allowed here" : null;
}

// --- NTN: digits only, 7–13 digits ------------------------------------------
// Range covers legacy 7-digit company NTNs through 13-digit CNIC-based NTNs.
export function validateNtn(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const d = digitsOnly(value as string);
  const clean = (value as string).trim();
  if (!/^\d+$/.test(clean.replace(/[-\s]/g, "")) || d.length < 7 || d.length > 13) {
    return "Enter a valid NTN (digits only)";
  }
  return null;
}

// --- STRN: digits only, 7–15 digits -----------------------------------------
export function validateStrn(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const d = digitsOnly(value as string);
  const clean = (value as string).trim();
  if (!/^\d+$/.test(clean.replace(/[-\s]/g, "")) || d.length < 7 || d.length > 15) {
    return "Enter a valid STRN (digits only)";
  }
  return null;
}

// --- CNIC: XXXXX-XXXXXXX-X (accepts 13 bare digits too) ----------------------
export function validateCnic(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const clean = (value as string).trim();
  if (/^\d{5}-\d{7}-\d$/.test(clean)) return null;
  if (/^\d{13}$/.test(clean)) return null;
  return "Enter a valid CNIC (e.g. 12345-1234567-1)";
}

// --- Phone: Pakistani mobile/landline + international ------------------------
// Permissive: allows +, leading 0, spaces, dashes, parentheses; requires a
// plausible 10–13 significant digits so landlines and +92 numbers all pass.
export function validatePhone(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const clean = (value as string).trim();
  if (!/^[+0-9()\-\s]+$/.test(clean)) return "Enter a valid phone number";
  const d = digitsOnly(clean);
  if (d.length < 10 || d.length > 13) return "Enter a valid phone number";
  return null;
}

// --- Email -------------------------------------------------------------------
export function validateEmail(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const clean = (value as string).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return "Enter a valid email address";
  return null;
}

// --- IBAN: Pakistani 24-char (PK + 2 check + 4 bank + 16 account) ------------
export function validateIban(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const clean = (value as string).replace(/\s/g, "").toUpperCase();
  if (!/^PK\d{2}[A-Z]{4}\d{16}$/.test(clean)) return "Enter a valid 24-character IBAN";
  return null;
}

// --- Bank account number: digits only, 6–24 (allows spaces/dashes) ----------
export function validateBankAccount(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const clean = (value as string).trim();
  if (!/^[0-9\-\s]+$/.test(clean)) return "Enter a valid account number";
  const d = digitsOnly(clean);
  if (d.length < 6 || d.length > 24) return "Enter a valid account number";
  return null;
}

// --- Invoice number: charset + non-injection (uniqueness checked by caller) --
// Permissive on format so existing INV-0NN and generated INV-FY-CODE-YYYYMM both
// pass; the duplicate check lives in the form (it needs the invoice list).
export function validateInvoiceNumber(value: string | null | undefined): string | null {
  if (isBlank(value)) return "Enter an invoice number";
  const clean = (value as string).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,60}$/.test(clean)) {
    return "Enter a valid invoice number (letters, digits, - / _ only)";
  }
  return null;
}

// --- Non-negative amount -----------------------------------------------------
export function validateAmount(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const n = Number((value as string).trim());
  if (!Number.isFinite(n) || n < 0) return "Enter a valid amount";
  return null;
}

// Convenience: first error across a set of [value, validator] pairs.
export function firstError(
  checks: Array<[string | null | undefined, (v: string | null | undefined) => string | null]>,
): string | null {
  for (const [val, fn] of checks) {
    const e = fn(val);
    if (e) return e;
  }
  return null;
}
