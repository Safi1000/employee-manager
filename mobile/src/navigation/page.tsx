import React from "react";
import { Gate } from "../components/Screen";
import { navFor } from "./registry";

/** Wrap a screen in the same gate its web route has (RequirePermission / RequireAuth roles). */
export function page(href: string, Comp: React.ComponentType) {
  function Page() {
    const n = navFor(href);
    return (
      <Gate perms={n.perms} roles={n.roles} title={n.title}>
        <Comp />
      </Gate>
    );
  }
  Page.displayName = `Page(${href})`;
  return Page;
}
