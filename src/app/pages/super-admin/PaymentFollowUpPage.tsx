import Header from "../../components/Header";
import PaymentFollowUp from "../../components/PaymentFollowUp";

// Payment follow-up (0628): its own page so a login holding only
// receivables.follow_up reaches the follow-up list and nothing else.
export default function PaymentFollowUpPage() {
  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
      <Header title="Payment Follow-up" subtitle="Who to chase for payment, what they said, and the next step — exported with or without figures" />
      <PaymentFollowUp />
    </div>
  );
}
