import FieldOps from "./FieldOps";

// Consolidation: Field Operations repurposed → Daily Reports. The Daily Reports
// tab now supports date-wise per-post reporting with a branded PDF export
// (see the "Download PDF" action). Automatic archival of each generated report
// as a stored record is a possible later enhancement.
export default function DailyReports() {
  return <FieldOps />;
}
