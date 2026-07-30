import TabHub from "./_TabHub";
import UserManagement from "./UserManagement";
import Governance from "./Governance";

// Consolidation: Users & Permissions + Governance merged into one
// "Access & Governance" home. Access control/permissions on one tab; the
// approval-workflow engine, department roles and RMD flag on the other.
export default function AccessGovernance() {
  return (
    <TabHub
      tabs={[
        { key: "users", label: "Users & Permissions", render: () => <UserManagement /> },
        { key: "governance", label: "Governance", render: () => <Governance /> },
      ]}
    />
  );
}
