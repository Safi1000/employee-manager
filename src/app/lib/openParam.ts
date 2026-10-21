import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

/**
 * `?new=<what>` opens a page's own "create" form once (2026-10-21) — how the
 * ⌘K palette's actions ("New expense", "New invoice"…) land on the form rather
 * than the page. The parameter is removed after it is honoured, so a refresh
 * or a back-navigation does not open the form again.
 */
export function useOpenParam(what: string, open: () => void, ready = true) {
  const [params, setParams] = useSearchParams();
  const done = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!ready || done.current || params.get("new") !== what) return;
    done.current = true;
    openRef.current();
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  }, [params, setParams, what, ready]);
}
