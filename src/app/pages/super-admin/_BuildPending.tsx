// Shared banner for consolidation BUILD/FIX items that have a home in the new
// structure but whose full wiring is deferred to a focused follow-up pass.
export default function BuildPending({ note }: { note: string }) {
  return (
    <div className="mx-4 md:mx-8 mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <span className="font-medium">Build pending.</span> {note}
    </div>
  );
}
