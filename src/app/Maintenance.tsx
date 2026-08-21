// Temporary full-screen takeover. Flip SHOW_MAINTENANCE in main.tsx back to
// false to restore the real app — no app code was removed.
export default function Maintenance() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#ffffff",
        color: "#000000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "24px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: "clamp(20px, 5vw, 40px)",
        zIndex: 2147483647,
      }}
    >
      fku2
    </div>
  );
}
