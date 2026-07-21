// Per-company brand theming.
//
// The whole app's primary accent (sidebar active state, primary buttons,
// badges, focus rings drawn with `brand-*`) is driven by the Tailwind v4
// `--color-brand-*` theme variables. Tailwind compiles e.g. `bg-brand-600`
// to `background-color: var(--color-brand-600)`, so overriding those shades
// on <html> at runtime re-themes every `brand-*` utility at once — no
// rebuild, no per-component changes.
//
// We only override the accent shades (500/600/700). The soft tints
// (50/100/200) are generated in theme.css via color-mix off the 500 shade
// and the current surface, so they stay correct in both light and dark mode
// no matter which accent a company picks.
//
// Default = Amber (the Bastion identity). A company can pick another from
// Settings → Appearance (SA/SSA only); the choice is stored on
// companies.theme and applied whenever the active company loads.

// Note on "emerald": the DB column defaults every company to the legacy value
// 'emerald'. That value is intentionally NOT a key below, so resolveTheme()
// falls back to the Amber default — i.e. the whole app is amber (like the
// login page) unless a company explicitly picks a palette in Settings. Green
// is still offered, under the "green" key.
export type ThemeKey = "amber" | "green" | "steel";

type BrandScale = {
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

// Order here is the order shown in the picker. Amber first = default.
export const THEME_OPTIONS: ThemeOption[] = [
  {
    key: "amber",
    label: "Amber",
    description: "Warm gold — the Bastion signature.",
    scale: { 500: "#e9a73c", 600: "#cf8f28", 700: "#9a6414" },
  },
  {
    key: "green",
    label: "Emerald",
    description: "Fresh green, calm and positive.",
    scale: { 500: "#4faa84", 600: "#3f8e6d", 700: "#2f6f55" },
  },
  {
    key: "steel",
    label: "Steel Blue",
    description: "Corporate, quiet and trustworthy.",
    scale: { 500: "#5f86a8", 600: "#4d6f8d", 700: "#3c5670" },
  },
];

export const DEFAULT_THEME: ThemeKey = "amber";

const BY_KEY = new Map(THEME_OPTIONS.map((o) => [o.key, o]));

export function isThemeKey(v: unknown): v is ThemeKey {
  return typeof v === "string" && BY_KEY.has(v as ThemeKey);
}

export function resolveTheme(v: string | null | undefined): ThemeOption {
  return (v && BY_KEY.get(v as ThemeKey)) || BY_KEY.get(DEFAULT_THEME)!;
}

// Override the accent shades on <html>. Inline style on the root element beats
// the stylesheet's rule by cascade, so this wins over the compiled defaults.
// Passing null/unknown resets to the default (amber) palette.
const BRAND_SHADES = [500, 600, 700] as const;

export function applyTheme(theme: string | null | undefined): void {
  const { scale } = resolveTheme(theme);
  const root = document.documentElement;
  for (const shade of BRAND_SHADES) {
    root.style.setProperty(`--color-brand-${shade}`, scale[shade]);
  }
}
