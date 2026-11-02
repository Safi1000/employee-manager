import Header from "../../components/Header";
import FinanceReport from "../../components/FinanceReport";

// Finance report (0632): everything entered since the last export, and where
// things stand — nothing typed by hand.
export default function FinanceReportPage() {
  return (
    <>
      <Header title="Finance Report" subtitle="Everything entered since the last report — received, invoiced, spent, salaries, receivables and what is waiting" />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        <FinanceReport />
      </div>
    </>
  );
}
