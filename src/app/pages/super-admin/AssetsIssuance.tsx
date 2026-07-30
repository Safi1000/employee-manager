import TabHub from "./_TabHub";
import Assets from "./Assets";
import Inventory from "./Inventory";

// Consolidation: Inventory + Assets merged into one "Assets & Issuance" home.
// "Register" is the fixed-asset / vehicle / ammunition register (Assets);
// "Issuance" is the weapons/uniforms issuance ledger (Inventory). Weapons and
// ammunition are recorded once, not twice. Tables unchanged.
export default function AssetsIssuance() {
  return (
    <TabHub
      tabs={[
        { key: "register", label: "Register", render: () => <Assets /> },
        { key: "issuance", label: "Issuance", render: () => <Inventory /> },
      ]}
    />
  );
}
