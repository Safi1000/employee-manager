import TabHub from "./_TabHub";
import PayrollManagement from "./PayrollManagement";
import PayrollRuns from "./PayrollRuns";

// Consolidation: Payroll + Payroll Runs merged into one Payroll home.
// "Payslips" is the per-employee period view; "Runs" is the batch pipeline
// (Draft → Review → Approve → Disburse → Complete). Tables unchanged.
export default function PayrollHub() {
  return (
    <TabHub
      tabs={[
        { key: "payslips", label: "Payslips", render: () => <PayrollManagement /> },
        { key: "runs", label: "Runs", render: () => <PayrollRuns /> },
      ]}
    />
  );
}
