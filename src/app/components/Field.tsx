import type { ReactNode } from "react";

/** Read-only label/value pair used by the detail (View) modals. */
export default function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-slate-900">{children}</div>
    </div>
  );
}
