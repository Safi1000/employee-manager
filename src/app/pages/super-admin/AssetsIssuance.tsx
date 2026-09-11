import TabHub from "./_TabHub";
import Assets from "./Assets";
import InventoryStore from "./InventoryStore";
import KitIssuance from "./KitIssuance";
import Clearance from "./Clearance";

// Assets & Issuance, rebuilt.
//
// WHAT WAS REMOVED. The old "Issuance" tab was Inventory.tsx, which read
// `inventory_items` (one row per thing, ONE `unit_value`, free-text item type)
// and `issuances` (an issue row with an optional return date). Both tables were
// EMPTY on production, so nothing was migrated and no user was disturbed. They
// could not carry what this needs:
//
//   · TWO COSTS — actual (paid, the ledger figure, reduced by a bulk discount)
//     and replacement (what one costs to replace, not reduced, what fines read).
//     One column cannot be both, and collapsing them makes every fine wrong by
//     the discount.
//   · A HANDOVER — guard to guard at the same site, which an issue-plus-return
//     cannot express without sending the kit through a store it never visited
//     and charging the client a second time for it.
//
// "Register" is unchanged: fixed assets, vehicles and ammunition counts, whose
// depreciation machinery this build reuses rather than rebuilds.
export default function AssetsIssuance() {
  return (
    <TabHub
      tabs={[
        { key: "store", label: "Store", render: () => <InventoryStore /> },
        { key: "issuance", label: "Issuance", render: () => <KitIssuance /> },
        { key: "clearance", label: "Clearance", render: () => <Clearance /> },
        { key: "register", label: "Register", render: () => <Assets /> },
      ]}
    />
  );
}
