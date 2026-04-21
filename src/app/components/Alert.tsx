import { AlertCircle, CheckCircle, Info, XCircle } from "lucide-react";

interface AlertProps {
  type: "success" | "error" | "warning" | "info";
  message: string;
  onClose?: () => void;
}

export default function Alert({ type, message, onClose }: AlertProps) {
  const styles = {
    success: "bg-green-50 border-green-200 text-green-800",
    error: "bg-red-50 border-red-200 text-red-800",
    warning: "bg-amber-50 border-amber-200 text-amber-800",
    info: "bg-blue-50 border-blue-200 text-blue-800",
  };

  const icons = {
    success: CheckCircle,
    error: XCircle,
    warning: AlertCircle,
    info: Info,
  };

  const Icon = icons[type];

  return (
    <div className={`flex items-center gap-3 p-4 rounded-lg border ${styles[type]}`}>
      <Icon className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />
      <p className="text-sm flex-1">{message}</p>
      {onClose && (
        <button onClick={onClose} className="text-sm hover:opacity-70">
          Dismiss
        </button>
      )}
    </div>
  );
}
