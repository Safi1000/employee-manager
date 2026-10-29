// Edge function: ai-chat — retired 29 Oct 2026. Shayan: "the Ai in bastion i
// hardly ever need that im thinking to remove it". The widget is gone from the
// app; this stub answers every call with 410 so nothing can reach the old one.

Deno.serve(() =>
  new Response(JSON.stringify({ error: "gone" }), { status: 410, headers: { "Content-Type": "application/json" } })
);
