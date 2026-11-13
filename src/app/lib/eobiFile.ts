/**
 * EOBI bulk upload file — the CSV the EOBI website takes for a month's
 * contribution (studied 13 Nov 2026 from GGS's own FAA04781FS_BULK.csv).
 *
 * Exactly as EOBI's file reads:
 *  - header: EMP_AREA_CODE,EMP_REG_SERIAL_NO,EMP_SUB_AREA_CODE, EMP_SUB_SERIAL_NO,NAME,EOBI_NO,CNIC,NIC,DOB,DOJ,DOE,NO_OF_DAYS_WORKED,From_Date,To_Date
 *    (note the space before EMP_SUB_SERIAL_NO — it is in EOBI's own header);
 *  - per row: area code (letters of the registration), serial (its number,
 *    no leading zeros), sub-area " " (one space), sub-serial 0, name, EOBI no,
 *    CNIC 00000-0000000-0, NIC empty, DOB, DOJ, DOE (exit date, only when he
 *    left during the month), days worked, month's first and last day;
 *  - dates DD-Mon-YY (01-Oct-26); lines end CRLF, last line too.
 *
 * Pure: builds the text. The screen (EobiChallan) chooses who goes in.
 */
export type EobiFileRow = {
  name: string;
  eobiNo: string;
  cnic: string;
  dob: string | null;      // yyyy-mm-dd
  doj: string | null;      // EOBI date of joining, else join date
  exit: string | null;     // last working day when it falls in or before the month
};

export const EOBI_HEADER =
  "EMP_AREA_CODE,EMP_REG_SERIAL_NO,EMP_SUB_AREA_CODE, EMP_SUB_SERIAL_NO,NAME,EOBI_NO,CNIC,NIC,DOB,DOJ,DOE,NO_OF_DAYS_WORKED,From_Date,To_Date";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** yyyy-mm-dd → DD-Mon-YY, the way EOBI writes dates. */
export function eobiDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  return `${String(d).padStart(2, "0")}-${MON[m - 1]}-${String(y % 100).padStart(2, "0")}`;
}

/** 13 digits → 00000-0000000-0; anything else is returned as typed. */
export function eobiCnic(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length === 13 ? `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}` : raw.trim();
}

/** 'FAA04781' → { area: 'FAA', serial: '4781' }. */
export function splitEobiRegistration(reg: string): { area: string; serial: string } | null {
  const m = reg.trim().toUpperCase().match(/^([A-Z]+)\s*0*(\d+)$/);
  return m ? { area: m[1], serial: m[2] } : null;
}

const clean = (s: string) => s.replace(/[,\r\n"]/g, " ").replace(/\s+/g, " ").trim();

/** The month's file text. `month` is yyyy-mm(-dd). */
export function buildEobiFile(registration: string, month: string, rows: EobiFileRow[]): string {
  const reg = splitEobiRegistration(registration);
  if (!reg) throw new Error(`The company's EOBI registration "${registration}" is not in the form FAA04781.`);
  const [y, m] = month.slice(0, 7).split("-").map(Number);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const last = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const lines = rows.map((r) => {
    // DOE only when he left DURING the month. Ticking someone who left earlier
    // means paying his month in full — EOBI's own October file carries three
    // such guards with no DOE and the whole month.
    const exit = r.exit && r.exit >= first && r.exit <= last ? r.exit : null;
    const days = exit ? Number(exit.slice(8, 10)) : lastDay;
    return [
      reg.area, reg.serial, " ", "0",
      clean(r.name), clean(r.eobiNo).toUpperCase(), eobiCnic(r.cnic), "",
      eobiDate(r.dob), eobiDate(r.doj), eobiDate(exit),
      String(days), eobiDate(first), eobiDate(last),
    ].join(",");
  });
  return [EOBI_HEADER, ...lines].join("\r\n") + "\r\n";
}

export const eobiFileName = (registration: string) => `${registration.trim().toUpperCase()}FS_BULK.csv`;
