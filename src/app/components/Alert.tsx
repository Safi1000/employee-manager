import { AlertCircle, CheckCircle, Info, XCircle } from "lucide-react";
import { tone, type Tone } from "../lib/tone";

interface AlertProps {
  type: "success" | "error" | "warning" | "info";
  message: string;
  onClose?: () => void;
}

const typeToTone: Record<AlertProps["type"], Tone> = {
  success: "success",
  error: "danger",
  warning: "warning",
  info: "info",
};

export default function Alert({ type, message, onClose }: AlertProps) {
  const t = tone[typeToTone[type]];
  const Icon = { success: CheckCircle, error: XCircle, warning: AlertCircle, info: Info }[type];

  return (
    <div className={`flex items-center gap-3 p-4 rounded-lg border ${t.softBg} ${t.border} ${t.text}`}>
      <Icon className={`w-5 h-5 flex-shrink-0 ${t.icon}`} strokeWidth={1.5} />
      <p className="text-sm flex-1">{message}</p>
      {onClose && (
        <button onClick={onClose} className="text-sm hover:opacity-70">
          Dismiss
        </button>
      )}
    </div>
  );
}
