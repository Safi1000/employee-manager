import { Loader2 } from "lucide-react";

type Props = {
  show: boolean;
  message?: string;
  detail?: string;
};

export default function BusyOverlay({ show, message = "Working…", detail }: Props) {
  if (!show) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-[1px]"
      aria-busy="true"
      role="alert"
    >
      <div className="bg-white rounded-lg shadow-lg border border-slate-200 px-6 py-5 flex items-center gap-3 max-w-sm">
        <Loader2 className="w-6 h-6 animate-spin text-brand-600" strokeWidth={1.5} />
        <div>
          <div className="text-sm text-slate-900">{message}</div>
          {detail && <div className="text-xs text-slate-500 mt-0.5">{detail}</div>}
        </div>
      </div>
    </div>
  );
}
