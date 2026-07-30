import TabHub from "./_TabHub";
import Licences from "./Licences";
import ContractRenewals from "./ContractRenewals";

// Compliance ▸ Licenses & Renewals now also hosts the contract renewal pipeline
// (from the dissolved Client Relationships panel), making it the single
// renewals source per the consolidation map.
export default function LicencesHub() {
  return (
    <TabHub
      tabs={[
        { key: "licences", label: "Licenses & Renewals", render: () => <Licences /> },
        { key: "renewals", label: "Contract Renewals", render: () => <ContractRenewals /> },
      ]}
    />
  );
}
