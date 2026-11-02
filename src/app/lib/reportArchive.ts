import { supabase } from "./supabase";

/**
 * KEPT REPORTS (0633, DECIDED 2 Nov 2026). Every exported report is also
 * filed — the same PDF, export stamp and all — so the CEO dashboard can show
 * the last one sent. Call AFTER savePdf(), which stamps the pages: the copy
 * kept is then exactly the copy downloaded.
 *
 * Fire-and-forget: a copy that could not be filed never stops the download.
 */
export const REPORTS_BUCKET = "report-exports";
export type ReportKind = "daily" | "attendance" | "daily_attendance" | "finance" | "followup";

export async function keepReport(doc: { output: (t: "blob") => Blob }, opts: {
  companyId: string | null | undefined; kind: ReportKind; reportDate: string; region: string | null; fileName: string;
}): Promise<void> {
  if (!opts.companyId) return;
  try {
    const path = `${opts.companyId}/${opts.kind}/${opts.reportDate}/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from(REPORTS_BUCKET).upload(path, doc.output("blob"), { contentType: "application/pdf" });
    if (upErr) return;
    await supabase.rpc("record_report_export", {
      p_kind: opts.kind, p_report_date: opts.reportDate, p_region_label: opts.region, p_file_path: path, p_file_name: opts.fileName,
    });
  } catch { /* the download already happened; a missed copy is not worth an error */ }
}
