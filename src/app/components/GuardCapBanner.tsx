import { Link } from "react-router";
import { AlertTriangle } from "lucide-react";
import { guardCapState, useBilling } from "../lib/billing";

// Tells an org where it stands against the guards it paid for, on the screens
// where guards are actually added.
//
// The database refuses an insert past guard_limit + buffer, so this banner is
// not the enforcement — it is the warning that stops the refusal being a
// surprise. Two states are worth showing:
//
//   in the buffer   still working, but on borrowed room. Amber.
//   at the ceiling  the next guard WILL be rejected. Red, with the fix linked.
//
// Silent otherwise, including for companies with no plan at all (created by
// hand by a super-super-admin), where there is nothing to warn about.
export default function GuardCapBanner() {
  const { summary } = useBilling();
  const cap = guardCapState(summary);

  if (cap.uncapped) return null;
  if (!cap.inBuffer && !cap.atHardLimit) return null;

  const hard = cap.atHardLimit;

  return (
    <div
      role="status"
      className={
        "mb-4 flex items-start gap-2 rounded-md border px-3 py-3 text-sm " +
        (hard
          ? "border-danger-200 bg-danger-50 text-danger-700 dark:text-danger-500"
          : "border-warning-200 bg-warning-50 text-warning-700 dark:text-warning-500")
      }
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={2} />
      <div className="flex-1">
        {hard ? (
          <>
            <b>You've reached your guard limit.</b>{" "}
            Your plan covers {cap.limit} guards and you have {cap.used}, which uses up the
            {" "}{cap.buffer}-guard buffer as well. The next guard you add will be refused.
          </>
        ) : (
          <>
            <b>You're over your plan by {cap.used - cap.limit}.</b>{" "}
            Your plan covers {cap.limit} guards and you have {cap.used}. You can keep adding
            up to {cap.limit + cap.buffer} using your buffer — {cap.remaining} left.
          </>
        )}
        {" "}
        <Link to="/super-admin/billing" className="font-semibold underline underline-offset-2">
          Upgrade your plan
        </Link>
      </div>
    </div>
  );
}
