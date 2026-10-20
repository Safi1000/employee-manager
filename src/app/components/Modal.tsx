import { ReactNode, useEffect } from "react";
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
  // Escape closes the modal.
  //
  // Declared before the isOpen early-return would be a hook-order violation, so
  // the guard lives inside the effect instead.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sizeStyles = {
    sm: "max-w-md",
    md: "max-w-2xl",
    lg: "max-w-4xl",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-[#191a10]/55 backdrop-blur-[2px]" onClick={onClose} />
      {/* Three regions in a bounded flex column: header (fixed), body (the only
          scroller), footer (fixed). min-h-0 lets the body actually shrink and
          scroll instead of pushing the footer off-screen. */}
      {/* dvh, not vh: on mobile browsers and WebViews `vh` is the tallest the
          viewport ever gets, so a 90vh sheet is taller than the visible area
          once the URL bar or keyboard is showing — which pushes the footer,
          and its Save button, off the bottom of the screen. */}
      <div
        style={{ marginTop: "var(--safe-top, 0px)", marginBottom: "var(--safe-bottom, 0px)" }}
        className={`relative bg-card border border-border rounded-2xl md:rounded-[20px] shadow-[0_24px_60px_rgba(25,26,16,0.28)] ${sizeStyles[size]} w-full mx-3 md:mx-4 max-h-[90dvh] flex flex-col`}
      >
        <div className="flex items-center justify-between gap-3 px-4 md:px-6 py-4 md:py-5 border-b border-border flex-shrink-0">
          <h3 className="font-display text-lg md:text-xl font-bold tracking-tight text-foreground truncate pr-2">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-xl border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>
        <div className="p-4 md:p-6 overflow-y-auto flex-1 min-h-0">
          {error && (
            <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm text-danger-700 dark:text-danger-500">
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
          <div className="px-4 md:px-6 py-3.5 border-t border-border flex-shrink-0 bg-muted/40 rounded-b-2xl md:rounded-b-[20px]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
