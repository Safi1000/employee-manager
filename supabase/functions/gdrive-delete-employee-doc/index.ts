// Retired 2026-10-08 (security audit). Superseded by gdrive-upload /
// gdrive-delete, which check the caller's company; nothing in the web or
// mobile app calls this any more, and the old body accepted any bearer token,
// the public anon key included.
Deno.serve(() =>
  new Response(JSON.stringify({ error: "gone" }), { status: 410, headers: { "Content-Type": "application/json" } })
);
