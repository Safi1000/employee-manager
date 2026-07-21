// Shared, theme-aware Recharts styling so every chart across the app reads as
// one system and works in light + dark. Colors resolve to CSS variables that
// flip with the theme; tooltips/grids/axes use the same tokens as the rest of
// the UI. Recharts animates series on mount by default — we just soften the
// easing/duration for the "landing page" feel.

/** On-brand categorical series colors (amber, emerald, steel, rust, gold…). */
export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--color-info-500)",
  "var(--color-success-600)",
  "var(--color-danger-500)",
];

/** Themed tooltip. Spread onto any <Tooltip {...CHART_TT} />. */
export const CHART_TT = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "0 16px 40px -18px rgba(0,0,0,0.45)",
    color: "var(--foreground)",
    fontSize: 12,
    padding: "8px 12px",
  },
  labelStyle: { color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 4 },
  itemStyle: { color: "var(--foreground)", padding: "1px 0" },
  cursor: { fill: "color-mix(in srgb, var(--color-brand-500) 12%, transparent)", stroke: "var(--border)" },
} as const;

/** Clean horizontal-only grid. Spread onto <CartesianGrid {...CHART_GRID} />. */
export const CHART_GRID = {
  strokeDasharray: "3 3",
  stroke: "var(--border)",
  vertical: false,
} as const;

/** Legend styling. Spread onto <Legend {...CHART_LEGEND} />. */
export const CHART_LEGEND = {
  wrapperStyle: { color: "var(--muted-foreground)", fontSize: 12, paddingTop: 8 },
  iconType: "circle" as const,
};

/** Smooth mount animation props. Spread onto <Line/Bar/Area/Pie {...CHART_ANIM} />. */
export const CHART_ANIM = {
  animationDuration: 900,
  animationEasing: "ease-out" as const,
};
