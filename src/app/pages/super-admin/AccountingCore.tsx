import TabHub from "./_TabHub";
import OpeningBalances from "./OpeningBalances";
import ChartOfAccounts from "./ChartOfAccounts";
import TrialBalance from "./TrialBalance";
import JournalView from "./JournalView";

// Accounting Core is the accounting spine, one tab per question:
//   what the accounts ARE      — Chart of Accounts
//   what they BALANCE to       — Trial Balance
//   what MOVED, and from where — Journal
// with Opening Balances as the thing that seeds them.
//
// These were previously two levels of tabs: the hub had Opening Balances and
// Chart of Accounts, and Chart of Accounts had its own coa/tb/gl strip inside
// it. That inner strip is gone, not hidden — leaving it beside its replacement
// is how the old browser-side trial balance would have come back.
export default function AccountingCore() {
  return (
    <TabHub
      tabs={[
        { key: "opening", label: "Opening Balances", render: () => <OpeningBalances /> },
        { key: "coa", label: "Chart of Accounts", render: () => <ChartOfAccounts /> },
        { key: "tb", label: "Trial Balance", render: () => <TrialBalance /> },
        { key: "journal", label: "Journal", render: () => <JournalView /> },
      ]}
    />
  );
}
