# Askari iNet bulk upload file — what Bastion has to produce

Studied 11 Nov 2026 from three files Shayan uploaded to iNet for October 2026
salaries (EMAAR Askari→Askari, HMC Askari→Askari, HMC Askari→other banks).
Bastion is to generate these from an initiated batch from November onwards.
Single instructions (one-off transfers) are keyed into iNet by hand and need no
file.

## One layout for both kinds

`.xlsx`, one sheet named `Sheet1`, row 1 is the header, one row per payee, no
total row, no blank rows. Thirteen columns, spelled exactly as iNet's template
spells them (including `ReferenceFeild`):

| Col | Header | Askari → Askari | Askari → other bank |
|---|---|---|---|
| A | `S.No` | 1, 2, 3… | same |
| B | `Transaction Date` | Excel date (shown m/d/yy), the same for every row | same |
| C | `Beneficiary Bank Code` | the **first 3 digits of the 13-digit Askari account** (341, 247, 189, 047…) | the bank's iBFT code — see the open question below |
| D | `Beneficiary Bank Name` | `Askari Bank Limited` | the bank's name (`Habib Bank Limited`, `Allied Bank Limited`, `MCB Bank`…) |
| E | `Beneficiary Name` | account title | same |
| F | `Beneficiary Account No` | the 13-digit Askari account, as a number | the **IBAN** as text (`PK..` 24 characters) |
| G | `Amount` | rupees | same |
| H | `Product Type Code` | `FT` | `IBFT1` |
| I | `ReferenceFeild1` | client short name (`EMAAR`, `HMC`) | same |
| J–M | `ReferenceFeild2`, `ReferenceFeild3`, `BeneficiaryMobile`, `BeneficiaryEmail` | empty | empty |

## What the hand-made files get wrong, which Bastion will not

- **Fractions in Amount.** The EMAAR file carries unrounded figures
  (52,528.35, 50,836.887…): it sums to 2,729,637.80 while the whole rupees sum
  to 2,729,628. iNet rounds each row, which is where small differences against
  Bastion come from (the Rs 3 Askari case of 11 Nov). Bastion writes the
  payslip's net in whole rupees, so the file total is exactly the batch total.
- **Leading zeros lost.** Askari accounts that start with 0 were stored as
  numbers, so `0470590007047` became `470590007047` and its code `47`.
  Bastion keeps the account as text, 13 digits, and takes the code from it.
- **Bank code and bank name out of step with the IBAN.** In the HMC iBFT file
  the IBAN's bank (HABB = HBL, ABPA = Allied, NBPA = NBP…) and columns C/D
  disagree on about a quarter of the rows — HBL IBANs labelled Allied, coded
  106/107/113; UBL and Meezan both coded 116. Bastion derives C and D from the
  IBAN's four-letter bank identifier, so they cannot disagree.
- **Blank bank names** on some Askari rows. Bastion always fills D.

## Bastion's source fields

`employees.bank_name`, `bank_account`, `iban`, `account_title`. For Askari the
account is normalised to 13 digits (non-digits removed; a 14-digit number with a
leading 0 loses it; a 12-digit one gains it). `bank_branch_code` is NOT used:
it is inconsistent (`0247`, `2470`, `3410` for the same branches), while the
account number carries the code itself.

## What iNet actually rejects (learned 11 Nov 2026)

Six rows of the HMC iBFT file were rejected in the first batch and paid
separately. They are exactly the six rows where the **bank name does not
match the IBAN**, and no others:

- five HBL IBANs (`..HABB..`) labelled `Allied Bank Limited`;
- one HBL row whose column F held the bare account number
  (`2467900077103`) instead of the IBAN (Bastion has the IBAN for him).

Rows with a wrong **code** but the right **name** (HBL coded 106, 107 or 113;
UBL and Meezan both 116) went through. So iNet checks column D against the
IBAN and needs a real IBAN in column F; column C is not what it matches on.

Rules Bastion follows for other banks, therefore:

1. Column F is always the IBAN. A payee with no valid IBAN (`PK` + 2 digits +
   4-letter bank id + 16 characters) is refused at initiate, by name, before
   any file exists.
2. Column D comes from the IBAN's bank id, spelled as it was accepted:

   | IBAN id | Column D (accepted spelling) | Column C used |
   |---|---|---|
   | HABB | Habib Bank Limited | 111 |
   | ABPA | Allied Bank Limited | 106 |
   | NBPA | National Bank of Pakistan | 113 |
   | MUCB | MCB Bank | 107 |
   | MEZN | Meezan Bank Limited | 116 |
   | UNIL | United Bank Limited | 116 (as accepted; UBL's own code may differ) |
   | ALFH | Bank Alfalah Limited | 109 |
   | BAHL | Bank Al Habib Limited | 106 (as accepted) |

   Column C is the code most often used for that bank in rows that went
   through. A bank id not in this table is refused at initiate with its
   name, so a new bank is added here deliberately, not guessed.
