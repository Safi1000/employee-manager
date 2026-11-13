# EOBI bulk upload file — format

The CSV the EOBI website takes for a month's contribution. Studied 13 Nov 2026
from GGS's own October 2026 file (`FAA04781FS_BULK.csv`, 100 rows); Bastion's
builder (`src/app/lib/eobiFile.ts`) rebuilt that file from its own rows and
matched it byte for byte (EOBI's copy had a stray trailing space after a few
names — harmless).

Built on **Expenses → Statutory → EOBI → EOBI challan → "EOBI file"**.

## File

- Name: `<employer registration>FS_BULK.csv`, e.g. `FAA04781FS_BULK.csv`
- Plain text, comma-separated, **CRLF** line endings, last line ends CRLF too
- No quoting; commas are removed from names
- One header line, then one line per insured person

## Header (exactly — note the space before `EMP_SUB_SERIAL_NO`)

```
EMP_AREA_CODE,EMP_REG_SERIAL_NO,EMP_SUB_AREA_CODE, EMP_SUB_SERIAL_NO,NAME,EOBI_NO,CNIC,NIC,DOB,DOJ,DOE,NO_OF_DAYS_WORKED,From_Date,To_Date
```

## Columns

| # | Column | Value | Bastion source |
|---|---|---|---|
| 1 | EMP_AREA_CODE | letters of the employer registration — `FAA` | `companies.eobi_registration_no` (0669) |
| 2 | EMP_REG_SERIAL_NO | its number, no leading zeros — `4781` | same |
| 3 | EMP_SUB_AREA_CODE | one space ` ` | fixed |
| 4 | EMP_SUB_SERIAL_NO | `0` | fixed |
| 5 | NAME | full name | `employees.full_name` |
| 6 | EOBI_NO | e.g. `4700J721939` (upper case) | `employees.eobi_registration_number` |
| 7 | CNIC | `00000-0000000-0` | `employees.cnic_number` (13 digits, re-dashed) |
| 8 | NIC | empty (old NIC) | — |
| 9 | DOB | `DD-Mon-YY` | `employees.date_of_birth` |
| 10 | DOJ | `DD-Mon-YY` — date of joining **as registered with EOBI** | `employees.eobi_join_date` (0669), else `join_date` |
| 11 | DOE | `DD-Mon-YY` only when the person left **during** the month; else empty | `employees.last_working_day` |
| 12 | NO_OF_DAYS_WORKED | days in the month, or the exit day when he left in it | computed |
| 13 | From_Date | first day of the month, `01-Oct-26` | the challan month |
| 14 | To_Date | last day of the month, `31-Oct-26` | the challan month |

Dates are `DD-Mon-YY` with English month abbreviations: `01-Oct-26`, `27-Nov-66`.

## Example line

```
FAA,4781, ,0,<Name>,<EOBI no>,<CNIC>,,27-Nov-66,01-Mar-26,,31,01-Oct-26,31-Oct-26
```

## Rules learned from GGS's own file

- People who left **before** the month but are still paid for appear with **no
  DOE and the full month** (three such guards in October 2026). Ticking someone
  on the challan means paying his month in full.
- DOJ is EOBI's own date (most GGS registrations read `01-Aug-26`), not the
  guard's real joining date — hence the separate `eobi_join_date`.
- A row needs a valid 13-digit CNIC; a missing EOBI number is allowed (new
  registrations), and the screen flags it.

## Not in this file

The contribution amounts. EOBI's payment slip (PR-03) carries them: employee
share 407 and employer share 2,035 a head from October 2026 (`statutory_rates`),
e.g. 100 insured → 40,700 + 203,500 = 244,200.
