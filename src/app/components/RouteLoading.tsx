import { Loader2 } from "lucide-react";

// Shown while a route's chunk is being fetched (routes.tsx lazy-loads every
// screen). Deliberately plain: it is on screen for one network round trip.
export default function RouteLoading() {
  return (
    <div className="flex-1 flex items-center justify-center py-16 text-muted-foreground">
      <Loader2 className="w-5 h-5 animate-spin mr-2" />
      <span className="text-sm">Loading…</span>
    </div>
  );
}
