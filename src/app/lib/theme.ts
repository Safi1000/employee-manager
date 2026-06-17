// Per-company brand theming.
//
// The whole app's primary accent (sidebar active state, primary buttons,
// badges, focus rings drawn with `brand-*`) is driven by the Tailwind v4
// `--color-brand-*` theme variables. Tailwind compiles e.g. `bg-brand-600`
// to `background-color: var(--color-brand-600)`, so overriding those six
// shades on <html> at runtime re-themes every `brand-*` utility at once —
// no rebuild, no per-component changes.
//
// A company picks one of the palettes below (Settings → Appearance, SA/SSA
// only). The choice is stored on companies.theme and applied whenever the
// active company loads (including SSA "view as").

export type ThemeKey = "emerald" | "ocean" | "indigo";

// The exact shades each `brand-*` utility used in the app maps to.
type BrandScale = {
  50: string;
  100: string;
  200: string;
  500: string;
  600: string;
  700: string;
};

export type ThemeOption = {
  key: ThemeKey;
  label: string;
  description: string;
  scale: BrandScale;
};

// Order here is the order shown in the picker. Emerald first = default.
export const THEME_OPTIONS: ThemeOption[] = [
  {
    key: "emerald",
    label: "Emerald",
    description: "Fresh green — the classic look.",
    scale: {
      50: "#ecfdf5",
      100: "#d1fae5",
      200: "#a7f3d0",
      500: "#10b981",
      600: "#059669",
      700: "#047857",
    },
  },
  {
    key: "ocean",
    label: "Ocean Blue",
    description: "Corporate, calm and trustworthy.",
    scale: {
      50: "#eff6ff",
      100: "#dbeafe",
      200: "#bfdbfe",
      500: "#3b82f6",
      600: "#2563eb",
      700: "#1d4ed8",
    },
  },
  {
    key: "indigo",
    label: "Royal Indigo",
    description: "Modern and authoritative.",
    scale: {
      50: "#eef2ff",
      100: "#e0e7ff",
      200: "#c7d2fe",
      500: "#6366f1",
      600: "#4f46e5",
      700: "#4338ca",
    },
  },
];

export const DEFAULT_THEME: ThemeKey = "emerald";

const BY_KEY = new Map(THEME_OPTIONS.map((o) => [o.key, o]));

export function isThemeKey(v: unknown): v is ThemeKey {
  return typeof v === "string" && BY_KEY.has(v as ThemeKey);
}

export function resolveTheme(v: string | null | undefined): ThemeOption {
  return (v && BY_KEY.get(v as ThemeKey)) || BY_KEY.get(DEFAULT_THEME)!;
}

// Override the six brand shades on <html>. Inline style on the root element
// beats the stylesheet's :root rule by cascade, so this wins over the
// compiled defaults. Passing null/unknown resets to the default palette.
const BRAND_SHADES = [50, 100, 200, 500, 600, 700] as const;

export function applyTheme(theme: string | null | undefined): void {
  const { scale } = resolveTheme(theme);
  const root = document.documentElement;
  for (const shade of BRAND_SHADES) {
    root.style.setProperty(`--color-brand-${shade}`, scale[shade]);
  }
}
