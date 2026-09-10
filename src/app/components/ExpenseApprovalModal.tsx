import { AlertTriangle, Lock, Paperclip, Unlock } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { formatDate } from "../lib/date";

// What the dialog needs to show. Deliberately a structural type rather than an
// import of Expenses.tsx's `ExpenseRow`: that type carries forty columns this
// dialog has no interest in, and naming the six it reads is what stops the
// dialog quietly growing a dependency on the screen it was lifted out of.
export type ApprovableExpense = {
  id: string;
  amount: number | string;
  expense_date: string;
  payment_mode: string;
  description?: string | null;
  notes?: string | null;
  category_name?: string | null;
  client_name?: string | null;
  vendor_name?: string | null;
  bank_name?: string | null;
  expense_by_name?: string | null;
  approved_at?: string | null;
  drive_view_url?: string | null;
  receipt_path?: string | null;
  receipt_file_name?: string | null;
};

const money = (v: number | string) =>
  `PKR ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-sm text-foreground text-right break-words">{value}</span>
    </div>
  );
}

/**
 * Approve / unapprove one expense.
 *
 * This replaces a `window.confirm` whose entire text was the amount. Approval
 * is the point after which the row cannot be edited or deleted — a correction
 * costs a reversal — so the one screen where the figures should be in front of
 * the approver was the one that showed them a single number and an OK button.
 * The approver was being asked to confirm something they could not see.
 *
 * The dialog does not fetch. Everything shown is already on the row the board
 * rendered, so what is approved here is exactly what was on screen a moment
 * ago; a re-fetch could only introduce a figure the approver never looked at.
 */
export default function ExpenseApprovalModal({
  expense,
  onClose,
  onConfirm,
  submitting = false,
  error = null,
  onDismissError,
}: {
  /** Null closes the dialog. */
  expense: ApprovableExpense | null;
  onClose: () => void;
  onConfirm: (expense: ApprovableExpense, approving: boolean) => void;
  submitting?: boolean;
  error?: string | null;
  onDismissError?: () => void;
}) {
  const approving = !expense?.approved_at;
  const hasReceipt = !!(expense?.drive_view_url || expense?.receipt_path);

  return (
    <Modal
      isOpen={!!expense}
      onClose={onClose}
      title={approving ? "Approve expense" : "Unapprove expense"}
      size="md"
      error={error}
      onDismissError={onDismissError}
      footer={
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="md"
            className="flex-1"
            disabled={submitting || !expense}
            onClick={() => expense && onConfirm(expense, approving)}
          >
            {submitting
              ? "Saving…"
              : approving
                ? `Approve ${money(expense?.amount ?? 0)}`
                : "Unapprove"}
          </Button>
          <Button variant="secondary" size="md" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
        </div>
      }
    >
      {expense && (
        <div className="space-y-4">
          <div className="text-center py-2">
            <p className="text-2xl text-foreground">{money(expense.amount)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {expense.category_name ?? "Uncategorised"} · {formatDate(expense.expense_date)}
            </p>
          </div>

          <div className="border border-border rounded-md px-3 py-2 divide-y divide-border">
            <Row label="Paid by" value={expense.payment_mode} />
            {expense.bank_name && <Row label="Bank" value={expense.bank_name} />}
            {expense.client_name && <Row label="Client" value={expense.client_name} />}
            {expense.vendor_name && <Row label="Vendor" value={expense.vendor_name} />}
            {expense.expense_by_name && <Row label="Incurred by" value={expense.expense_by_name} />}
            {expense.description && <Row label="Description" value={expense.description} />}
            {expense.notes && <Row label="Notes" value={expense.notes} />}
            <Row
              label="Receipt"
              value={
                hasReceipt ? (
                  <span className="inline-flex items-center gap-1 text-foreground">
                    <Paperclip className="w-3 h-3" strokeWidth={1.5} />
                    {expense.receipt_file_name ?? "Attached"}
                  </span>
                ) : (
                  // Stated rather than hidden. An absent row reads as "not
                  // applicable"; approving an expense with no evidence behind it
                  // is a decision, and the approver should have to make it.
                  <span className="text-warning-700">No receipt attached</span>
                )
              }
            />
          </div>

          {approving ? (
            <div className="flex items-start gap-2 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
              <Lock className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={1.5} />
              <span>
                Approving locks this expense: no further edits and no deletion. A correction
                after this has to be a reversal. You can unapprove it again if you need to.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
              <Unlock className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={1.5} />
              <span>
                Unapproving reopens this expense for editing and deletion. The unapproval is
                recorded against your name.
              </span>
            </div>
          )}

          {approving && !hasReceipt && (
            <div className="flex items-start gap-2 rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={1.5} />
              <span>
                There is no receipt on this expense. Once approved it cannot be edited, so the
                receipt cannot be added afterwards.
              </span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
