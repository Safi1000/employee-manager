// Bastion tokens, ported from the web app's src/styles/theme.css.
// Same warm paper / warm obsidian neutrals, same amber-emerald-rust-steel accents,
// so a supervisor moving between phone and desktop sees one product.

export type Tone = "brand" | "success" | "danger" | "warning" | "info" | "neutral";

type Ramp = { 500: string; 600: string; 700: string };

export const accents: Record<Exclude<Tone, "neutral">, Ramp> = {
  brand: { 500: "#e9a73c", 600: "#cf8f28", 700: "#9a6414" },
  success: { 500: "#4faa84", 600: "#3f8e6d", 700: "#2f6f55" },
  danger: { 500: "#d4674a", 600: "#bb5238", 700: "#97402b" },
  warning: { 500: "#e9a73c", 600: "#cf8f28", 700: "#9a6414" },
  info: { 500: "#5f86a8", 600: "#4d6f8d", 700: "#3c5670" },
};

// Per-company brand override, as Settings → Appearance does on web (lib/theme.ts).
export const brandPalettes: Record<string, Ramp> = {
  amber: accents.brand,
  green: { 500: "#4faa84", 600: "#3f8e6d", 700: "#2f6f55" },
  steel: { 500: "#5f86a8", 600: "#4d6f8d", 700: "#3c5670" },
};

export type Palette = {
  dark: boolean;
  bg: string;
  card: string;
  raised: string;
  muted: string;
  border: string;
  borderStrong: string;
  input: string;
  fg: string;
  fgSoft: string;
  mutedFg: string;
  onBrand: string;
  overlay: string;
};

export const light: Palette = {
  dark: false,
  bg: "#f3eee2",
  card: "#fdfaf3",
  raised: "#fffdf8",
  muted: "#efe8d9",
  border: "#e3dcc9",
  borderStrong: "#d2c9b1",
  input: "#fbf7ec",
  fg: "#191a10",
  fgSoft: "#3f3d2f",
  mutedFg: "#837c67",
  onBrand: "#241a06",
  overlay: "rgba(25,26,16,0.45)",
};

export const dark: Palette = {
  dark: true,
  bg: "#0e100b",
  card: "#1b1e17",
  raised: "#20241b",
  muted: "#23261d",
  border: "#2e3125",
  borderStrong: "#3b3f30",
  input: "#14160f",
  fg: "#ece6d6",
  fgSoft: "#c9c3b1",
  mutedFg: "#8a8b76",
  onBrand: "#241a06",
  overlay: "rgba(0,0,0,0.6)",
};

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** color-mix(in srgb, a pct%, b) — how the web app generates its -50/-100/-200 tints. */
export function mix(a: string, b: string, pct: number) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const p = pct / 100;
  const c = (x: number, y: number) => Math.round(x * p + y * (1 - p)).toString(16).padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

export const fonts = {
  display: "BricolageGrotesque_700Bold",
  displayHeavy: "BricolageGrotesque_800ExtraBold",
  body: "HankenGrotesk_400Regular",
  medium: "HankenGrotesk_500Medium",
  semibold: "HankenGrotesk_600SemiBold",
  bold: "HankenGrotesk_700Bold",
  mono: "JetBrainsMono_500Medium",
  monoBold: "JetBrainsMono_700Bold",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 };
export const radius = { sm: 8, md: 10, lg: 12, xl: 16, pill: 999 };
