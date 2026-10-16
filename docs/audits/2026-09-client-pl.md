# September 2026 — per-client P&L as Bastion holds it (prod, read 2026-10-16)

Source: `client_statement_loaded('2026-09-01','2026-09-30', basis)` on crm-design (mmkfpnshxjcyijhuydgr). Read-only.
**HO now** = net as Bastion computes it today (HO apportioned). **HO held** = net with HO cost held at head office (net + ho_share).
Clients with no activity on either basis are omitted.

| Region | Client | Accr revenue | Accr payroll | Accr expense | Accr net (HO now) | Accr net (HO held) | Cash receipts | Cash payroll | Cash expense | Cash net (HO now) | Cash net (HO held) | Flag |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| ISB/RWP | 68 HS-PCI-PFM | 646,000 | 523,001 | 588 | 67,706 | 88,580 | 646,000 | 530,547 | 588 | 65,999 | 83,556 |  |
| ISB/RWP | AWT | 162,800 | 97,934 | 250 | 50,830 | 56,090 | 148,000 | 91,420 | 250 | 44,015 | 48,440 |  |
| ISB/RWP | Bin Zahid | 12,000 | 0 | 0 | 10,984 | 11,372 | 36,000 | 0 | 0 | 35,092 | 35,418 | income, no cost |
| ISB/RWP | CBR Town | 81,840 | 0 | 15,000 | 59,910 | 62,554 | 428,544 | 0 | 15,000 | 407,353 | 409,578 |  |
| ISB/RWP | Cambridge exclusive school | 21,167 | 0 | 520 | 18,855 | 19,538 | 0 | 27,000 | 520 | -29,121 | -28,546 |  |
| ISB/RWP | DHA Dental Lab | 35,000 | 28,000 | 0 | 4,036 | 5,167 | 35,000 | 28,000 | 0 | 4,352 | 5,304 |  |
| ISB/RWP | Dolmen City | 548,550 | 334,667 | 400 | 167,030 | 184,755 | 510,151 | 334,000 | 400 | 134,256 | 149,165 |  |
| ISB/RWP | Ellysium | 36,000 | 0 | 0 | 32,951 | 34,115 | 36,000 | 0 | 0 | 33,277 | 34,255 | income, no cost |
| ISB/RWP | Emaar DHA ISB | 4,776,650 | 3,719,425 | 227,585 | 425,142 | 579,485 | 4,754,162 | 3,681,732 | 227,585 | 483,519 | 613,344 |  |
| ISB/RWP | HMC Taxila | 5,112,738 | 4,294,366 | 267,000 | 118,413 | 283,615 | 4,629,379 | 4,294,964 | 267,000 | -319,335 | -180,375 |  |
| ISB/RWP | Inklings | 38,000 | 26,133 | 400 | 8,249 | 9,477 | 38,000 | 28,000 | 400 | 6,726 | 7,758 |  |
| ISB/RWP | J Sons - PWD | 38,500 | 28,000 | 0 | 7,240 | 8,484 | 38,500 | 24,000 | 0 | 11,588 | 12,634 |  |
| ISB/RWP | Mr Waseem/ Kaloon Chemicals | 6,000 | 0 | 0 | 5,492 | 5,686 | 24,000 | 0 | 0 | 23,546 | 23,709 | income, no cost |
| ISB/RWP | Mr. Ali Saadat Mandwala Chakri | 72,000 | 50,000 | 0 | 15,903 | 18,229 | 216,000 | 50,000 | 0 | 160,554 | 162,511 |  |
| ISB/RWP | Ms. Yasmin Yousaf | 13,500 | 11,100 | 0 | 1,257 | 1,693 | 0 | 0 | 0 | -1,021 | -654 |  |
| ISB/RWP | Nova Group | 1,899,497 | 52,000 | 142,515 | 1,544,128 | 1,605,504 | 1,900,000 | 920,614 | 142,515 | 693,185 | 744,812 |  |
| ISB/RWP | PRG Scheme 3 | 65,340 | 49,000 | 0 | 10,807 | 12,918 | 65,340 | 47,419 | 0 | 12,978 | 14,754 |  |
| ISB/RWP | Rising Sun Lodges | 90,000 | 80,000 | 0 | 2,379 | 5,287 | 180,000 | 80,000 | 0 | 93,192 | 95,638 |  |
| ISB/RWP | SGC - Guards | 0 | 0 | 0 | 0 | 0 | 745,927 | 467,255 | 0 | 278,672 | 278,672 |  |
| ISB/RWP | SGC - Weapons | 73,830 | 0 | 0 | 67,578 | 69,963 | 68,752 | 0 | 0 | 63,167 | 65,174 | income, no cost |
| ISB/RWP | Sweet Palace | 90,000 | 64,000 | 0 | 18,379 | 21,287 | 0 | 64,000 | 0 | -70,808 | -68,362 |  |
| ISB/RWP | Wusat- Emaar | 264,000 | 205,628 | 0 | 36,016 | 44,546 | 264,000 | 201,084 | 0 | 42,946 | 50,121 |  |
| Kashmir Branch | Bank of AJK | 2,817,003 | 0 | 0 | 2,629,212 | 2,720,235 | 0 | 0 | 0 | -143,819 | -67,256 | income, no cost |
| Kashmir Branch | Innovative | 0 | 0 | 0 | 0 | 0 | 64,342 | 0 | 0 | 64,342 | 64,342 | income, no cost |
| Kashmir Branch | Lexus Tower | 80,000 | 64,000 | 0 | 10,667 | 13,252 | 160,000 | 64,000 | 0 | 91,916 | 94,090 |  |
| Kashmir Branch | MIU | 1,350,500 | 1,115,199 | 0 | 145,272 | 188,909 | 1,246,511 | 1,128,000 | 0 | 49,562 | 86,268 |  |
| Kashmir Branch | Premier Sales | 0 | 50,000 | 0 | -50,000 | -50,000 | 0 | 0 | 0 | 0 | 0 | cost, no income |
| Kashmir Branch | Tiges MZD | 47,800 | 30,000 | 0 | 14,613 | 16,158 | 143,400 | 0 | 0 | 140,960 | 142,259 |  |
| Lahore | AlRabi International (Pvt.) Ltd | 245,800 | 0 | 0 | 237,858 | 245,800 | 0 | 0 | 0 | -6,681 | 0 | income, no cost |
| Lahore | Berger Paints Pakistan Ltd | 806,498 | 0 | 618,985 | 161,454 | 187,513 | 0 | 0 | 618,985 | -640,905 | -618,985 |  |
| Lahore | Madison Square Mall | 486,000 | 0 | 0 | 470,296 | 486,000 | 0 | 0 | 0 | -13,209 | 0 | income, no cost |
| Lahore | Mr Raza Firdous Market | 178,000 | 0 | 0 | 172,248 | 178,000 | 0 | 0 | 0 | -4,838 | 0 | income, no cost |
| Lahore | Popular Brands (Pvt.) Ltd | 102,416 | 0 | 0 | 99,107 | 102,416 | 0 | 0 | 0 | -2,784 | 0 | income, no cost |
| Lahore | Popular Water Tank (Pvt.) Ltd | 122,900 | 0 | 0 | 118,929 | 122,900 | 0 | 0 | 0 | -3,340 | 0 | income, no cost |
| Lahore | Waheed Shahzad Plastic Works (Pvt.) Ltd | 245,800 | 0 | 0 | 237,858 | 245,800 | 0 | 0 | 0 | -6,681 | 0 | income, no cost |
| **Total** | | **20,566,129** | **10,822,453** | **1,273,243** | **6,920,798** | **7,585,328** | **16,378,008** | **12,062,035** | **1,273,243** | **1,698,655** | **2,257,625** | |

Head office cost in these totals: accrual 664,530, cash 558,970. Region-level apportionment (`partnership_allocation`) splits the cash 558,970 as ISB/RWP 371,593 / Kashmir 105,475 / Lahore 81,902; the client-level apportionment above splits the same 558,970 as ISB/RWP 382,775 / Kashmir 116,742 / Lahore 59,453. Same total, two different drivers.
