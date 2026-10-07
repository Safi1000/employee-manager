// Refuse a password that has appeared in a public data breach.
//
// Supabase's own "leaked password protection" needs a Pro plan, and this org is
// on Free (security audit 2026-10-08). Every password the app sets goes through
// create-user, change-password or signup-complete, so the same check, against
// the same HaveIBeenPwned source, lives here instead.
//
// k-anonymity: only the first 5 hex characters of the password's SHA-1 leave
// this function; the password, and its full hash, never do.

/** How many breaches the password appears in; null if the service could not be reached. */
export async function pwnedCount(password: string): Promise<number | null> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const prefix = hex.slice(0, 5);
  const suffix = hex.slice(5);
  try {
    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "bastion-password-check" },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return null;
    for (const line of (await resp.text()).split("\n")) {
      const [s, n] = line.trim().split(":");
      if (s === suffix) return Number(n) || 0;
    }
    return 0;
  } catch {
    return null;
  }
}

/**
 * The error code to return, or null if the password may be used.
 * DECIDED: if the breach service is unreachable the password is ALLOWED (and
 * logged) — an outage at a third party must not lock admins out of creating
 * users or resetting passwords. Length is still enforced by each caller.
 */
export async function breachedPasswordError(password: string, where: string): Promise<string | null> {
  const n = await pwnedCount(password);
  if (n === null) {
    console.warn(`${where}: breached-password check unavailable; allowed`);
    return null;
  }
  return n > 0 ? "password_breached" : null;
}
