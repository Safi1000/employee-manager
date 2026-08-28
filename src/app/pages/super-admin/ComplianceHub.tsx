import TabHub from "./_TabHub";
import Compliance from "./Compliance";
import Licences from "./Licences";
import ContractRenewals from "./ContractRenewals";

// Compliance Calendar is now the single home for everything with an expiry on
// it: the calendar itself, the licence/renewal expiry board that used to sit
// under its own nav entry, and the contract renewal pipeline. They were three
// separate places asking the same question — what runs out next — so they are
// three tabs instead of three destinations.
//
// The old /super-admin/licences route redirects here (?tab=licences), so any
// bookmark still lands on the right panel.
export default function ComplianceHub() {
  return (
    <TabHub
      tabs={[
        { key: "calendar", label: "Compliance Calendar", render: () => <Compliance /> },
        { key: "licences", label: "Licenses & Renewals", render: () => <Licences /> },
        { key: "renewals", label: "Contract Renewals", render: () => <ContractRenewals /> },
      ]}
    />
  );
}
