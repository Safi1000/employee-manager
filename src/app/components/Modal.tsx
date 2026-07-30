import { ReactNode } from "react";
import { X, AlertCircle } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  // When provided, renders as a fixed footer OUTSIDE the scrollable body, so
  // submit/cancel actions stay pinned at the bottom regardless of scroll. Put
  // action buttons here rather than at the end of `children`.
  footer?: ReactNode;
  // Validation/submission error to show INLINE, pinned at the top of the modal
  // body (inside the overlay, so it can never render behind the modal). Pass the
  // modal's own error state here instead of a page-level banner. `onDismissError`
  // adds a close (×) affordance when supplied.
  error?: string | null;
  onDismissError?: () => void;
}

export default function Modal({ isOpen, onClose, title, children, size = "md", footer, error, onDismissError }: ModalProps) {
  if (!isOpen) return null;

  const sizeStyles = {
    sm: "max-w-md",
    md: "max-w-2xl",
    lg: "max-w-4xl",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      {/* Three regions in a bounded flex column: header (fixed), body (the only
          scroller), footer (fixed). min-h-0 lets the body actually shrink and
          scroll instead of pushing the footer off-screen. */}
      <div className={`relative bg-white rounded-lg shadow-lg ${sizeStyles[size]} w-full mx-3 md:mx-4 max-h-[90vh] flex flex-col`}>
        <div className="flex items-center justify-between p-4 md:p-6 border-b border-slate-200 flex-shrink-0">
          <h3 className="text-base md:text-lg text-slate-900 truncate pr-2">{title}</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0"
          >
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>
        <div className="p-4 md:p-6 overflow-y-auto flex-1 min-h-0">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
              <span className="flex-1 break-words">{error}</span>
              {onDismissError && (
                <button
                  onClick={onDismissError}
                  className="text-danger-400 hover:text-danger-600 transition-colors flex-shrink-0"
                  aria-label="Dismiss error"
                >
                  <X className="w-4 h-4" strokeWidth={2} />
                </button>
              )}
            </div>
          )}
          {children}
        </div>
        {footer && (
          <div className="px-4 md:px-6 py-3 border-t border-slate-200 flex-shrink-0 bg-white rounded-b-lg">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
