import TabHub from "./_TabHub";
import OpeningBalances from "./OpeningBalances";
import ChartOfAccounts from "./ChartOfAccounts";

// Consolidation: Accounting Core is the single accounting spine — Opening
// Balances feed the Chart of Accounts, which already hosts the Trial Balance and
// General Ledger drill-down (from the double-entry journal). One continuous
// spine instead of three separate panels. Full GL/TB wiring is tracked as a
// follow-up BUILD item; the structure lives here now.
export default function AccountingCore() {
  return (
    <TabHub
      tabs={[
        { key: "opening", label: "Opening Balances", render: () => <OpeningBalances /> },
        { key: "coa", label: "Chart of Accounts", render: () => <ChartOfAccounts /> },
      ]}
    />
  );
}
