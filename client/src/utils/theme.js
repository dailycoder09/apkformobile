// Runtime OKLCH color-theming engine. Ported from a TypeScript/Radix reference app to
// plain JS for this codebase - same functions, same math, no framework dependency.
//
// applyTheme() writes CSS custom properties directly on document.documentElement so that
// the Tailwind-scoped screens (Dashboard, HomeScreen, BottomNav) that consume tokens like
// --color-gold / --chart-1 from client/src/tailwind.css's @theme block re-color instantly,
// with zero changes needed in those components. Every property name set below matches an
// existing token name in tailwind.css exactly (the --color-* Tailwind-facing form). Bare
// aliases used by raw SVG/Recharts code (--chart-1..5, --muted-foreground, --popover,
// --chart-border) are also kept in sync so charts re-theme too.
//
// NamazTracker and TransactionPanel (and Finance/Khatabook's shared index.css styling) are
// NOT Tailwind-scoped - they're plain CSS driven by their own --namaz-*/--txn-* variable
// blocks in index.css. applyTheme() re-themes those too (gold/rose accents below, plus the
// neutral --namaz-muted/--txn-ink/--txn-muted "body text" roles) by writing the same
// property names index.css already declares as static fallbacks, exactly the way the
// Tailwind side of this file overrides tailwind.css's @theme fallbacks.

export const clampHue = (h) => ((Math.round(h) % 360) + 360) % 360;
export const clampChroma = (c) => Math.min(0.24, Math.max(0.02, c));

export const swatch = (h, c) => [
  `oklch(0.82 ${(c * 0.88).toFixed(3)} ${h})`,
  `oklch(0.72 ${c.toFixed(3)} ${h})`,
  `oklch(0.6 ${(c * 1.05).toFixed(3)} ${h})`,
  `oklch(0.95 ${(c * 0.4).toFixed(3)} ${h})`,
];

export function accentColor(hue, chroma) {
  return `oklch(0.72 ${chroma.toFixed(3)} ${hue})`;
}

function preset(name, hue, chroma) {
  return { name, hue, chroma, swatch: swatch(hue, chroma) };
}

export const PRESETS = [
  preset('Sand Gold', 86, 0.125), preset('Olive', 120, 0.11), preset('Emerald', 158, 0.13),
  preset('Mint', 172, 0.1), preset('Teal', 195, 0.12), preset('Sky', 215, 0.13),
  preset('Ocean', 235, 0.13), preset('Indigo', 275, 0.15), preset('Violet', 300, 0.14),
  preset('Orchid', 320, 0.14), preset('Magenta', 340, 0.15), preset('Rose', 15, 0.15),
  preset('Coral', 40, 0.15), preset('Amber', 65, 0.14), preset('Slate', 250, 0.04), preset('Mono', 90, 0.02),
];

export const DEFAULT_THEME = { hue: 86, chroma: 0.125, mode: 'light' };

export function harmonies(hue) {
  return [
    { label: 'Complementary', hue: clampHue(hue + 180) },
    { label: 'Analogous', hue: clampHue(hue + 30) },
    { label: 'Triadic', hue: clampHue(hue + 120) },
    { label: 'Split', hue: clampHue(hue - 150) },
  ];
}

export function randomTheme(mode) {
  return { hue: Math.round(Math.random() * 359), chroma: clampChroma(0.05 + Math.random() * 0.15), mode };
}

const THEME_KEY = 'meeee-theme';
const CUSTOM_KEY = 'meeee-custom-themes';

function normalise(t) {
  if (!t || typeof t !== 'object') return null;
  const hue = clampHue(Number(t.hue));
  const chroma = clampChroma(Number(t.chroma));
  const mode = t.mode === 'dark' ? 'dark' : 'light';
  if (Number.isNaN(hue) || Number.isNaN(chroma)) return null;
  return { hue, chroma, mode };
}

export function loadTheme() {
  try {
    const parsed = JSON.parse(localStorage.getItem(THEME_KEY) || 'null');
    return normalise(parsed) || DEFAULT_THEME;
  } catch { return DEFAULT_THEME; }
}
export function saveTheme(t) { localStorage.setItem(THEME_KEY, JSON.stringify(t)); }

export function loadCustomThemes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => normalise(t)).map((t) => ({ ...normalise(t), id: t.id, name: t.name || 'Theme' }));
  } catch { return []; }
}
export function saveCustomThemes(list) { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); }

export function applyTheme(theme) {
  const { hue, chroma, mode } = theme;
  const dark = mode === 'dark';
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset.themeMode = mode;
  const c = (l, ch, h = hue) => `oklch(${l} ${ch.toFixed(3)} ${h})`;
  const set = (name, value) => root.style.setProperty(name, value);

  set('--color-gold', c(dark ? 0.78 : 0.72, chroma));
  set('--color-gold-soft', dark ? c(0.32, chroma * 0.45) : c(0.945, chroma * 0.4));
  set('--color-chart-1', c(dark ? 0.78 : 0.72, chroma));
  set('--color-chart-2', c(0.66, chroma * 0.9, clampHue(hue + 180)));
  set('--color-chart-3', c(dark ? 0.7 : 0.62, chroma * 0.75, clampHue(hue + 30)));
  set('--color-chart-4', c(0.7, chroma * 0.8, clampHue(hue + 120)));
  set('--color-chart-5', c(dark ? 0.55 : 0.783, chroma * 0.35));
  // Bare aliases consumed directly by raw SVG / Recharts props.
  set('--chart-1', c(dark ? 0.78 : 0.72, chroma));
  set('--chart-2', c(0.66, chroma * 0.9, clampHue(hue + 180)));
  set('--chart-3', c(dark ? 0.7 : 0.62, chroma * 0.75, clampHue(hue + 30)));
  set('--chart-4', c(0.7, chroma * 0.8, clampHue(hue + 120)));
  set('--chart-5', c(dark ? 0.55 : 0.783, chroma * 0.35));

  set('--namaz-gold', c(dark ? 0.78 : 0.72, chroma));
  set('--namaz-gold-dark', c(dark ? 0.6 : 0.46, chroma * 0.75));
  set('--namaz-gold-pastel', c(dark ? 0.32 : 0.94, chroma * 0.5));

  // Neutral "ink"/"muted" body-text roles for the plain-CSS Namaz screen (index.css's
  // --namaz-* block) - the direct equivalent of --color-foreground / --muted-foreground
  // below, just for a screen that isn't Tailwind-scoped. These carry no semantic meaning
  // (unlike e.g. --namaz-kaza/--namaz-missed, which stay fixed on purpose), so - like
  // foreground/muted-foreground - they should track the live hue instead of sitting at
  // index.css's static fallback forever. None of these legacy screens have a dark-mode
  // background variant, so (unlike the Tailwind neutrals below) there's no `dark ? … : …`
  // branch here - always the light-on-light-card lightness, hue-tinted to match.
  set('--namaz-muted', c(0.545, 0.024));

  set('--txn-gold', c(dark ? 0.78 : 0.72, chroma));
  set('--txn-gold-pastel', c(dark ? 0.32 : 0.94, chroma * 0.5));

  // Finance's PRIMARY/brand accent, despite the "rose" name - the reference app's own
  // finance.tsx uses plain gold for its buttons/active tabs/budget-bar/etc, with no
  // per-module branding at all (confirmed by reading it directly: budget %, filter pills,
  // savings-goal icons are all text-gold / bg-gold there). The handful of truly semantic
  // "this is money going out" displays (negative transaction amounts) are repointed at the
  // fixed --color-destructive token in index.css instead of this variable, the same way
  // Khatabook's own "You gave" toggle is scoped off this retint below.
  set('--txn-rose', c(dark ? 0.78 : 0.72, chroma));
  set('--txn-rose-dark', c(dark ? 0.6 : 0.46, chroma * 0.75));
  set('--txn-rose-pastel', c(dark ? 0.32 : 0.94, chroma * 0.5));

  // Same neutral ink/muted pair as --namaz-muted above, for Finance's --txn-ink/--txn-muted
  // (headings, stat numbers, and secondary labels/captions across TransactionPanel.jsx -
  // .txn-title, .txn-stat-value, .txn-breakdown-val, .txn-budget-label, .txn-stat-sub, chart
  // tick labels, etc). --txn-green* just above stays untouched on purpose (money-received is
  // pinned green, same as --color-success); ink/muted carry no such semantic, so they should
  // track hue the same way --color-foreground/--muted-foreground do.
  set('--txn-ink', c(0.255, 0.019));
  set('--txn-muted', c(0.545, 0.024));

  if (dark) {
    set('--color-background', c(0.17, 0.014)); set('--color-foreground', c(0.965, 0.008));
    set('--color-card', c(0.215, 0.017)); set('--color-popover', c(0.215, 0.017));
    set('--color-card-foreground', c(0.965, 0.008)); set('--color-popover-foreground', c(0.965, 0.008));
    set('--color-secondary', c(0.27, 0.02)); set('--color-secondary-foreground', c(0.95, 0.01));
    set('--color-muted', c(0.265, 0.018)); set('--color-muted-foreground', c(0.72, 0.02));
    set('--color-accent', c(0.3, chroma * 0.35)); set('--color-accent-foreground', c(0.96, 0.01));
    set('--color-sand', c(0.245, 0.018)); set('--color-clay', c(0.42, 0.045));
    set('--color-border', c(0.32, 0.02));
    set('--muted-foreground', c(0.72, 0.02));
    set('--popover', c(0.215, 0.017));
    set('--chart-border', c(0.32, 0.02));
    set('--surface-1', c(0.2, 0.02, clampHue(hue + 6)));
    set('--surface-2', c(0.185, 0.025, clampHue(hue + 2)));
    set('--surface-3', c(0.16, 0.035, clampHue(hue - 10)));
  } else {
    set('--color-background', c(0.981, 0.006)); set('--color-foreground', c(0.255, 0.019));
    set('--color-card', c(0.995, 0.003)); set('--color-popover', c(0.995, 0.003));
    set('--color-card-foreground', c(0.255, 0.019)); set('--color-popover-foreground', c(0.255, 0.019));
    set('--color-secondary', c(0.943, 0.013)); set('--color-secondary-foreground', c(0.36, 0.03));
    set('--color-muted', c(0.947, 0.011)); set('--color-muted-foreground', c(0.545, 0.024));
    set('--color-accent', c(0.925, chroma * 0.24)); set('--color-accent-foreground', c(0.36, 0.03));
    set('--color-sand', c(0.943, 0.013)); set('--color-clay', c(0.783, 0.038));
    set('--color-border', c(0.9, 0.014));
    set('--muted-foreground', c(0.545, 0.024));
    set('--popover', c(0.995, 0.003));
    set('--chart-border', c(0.9, 0.014));
    set('--surface-1', c(0.99, 0.008, clampHue(hue + 6)));
    set('--surface-2', c(0.955, 0.02, clampHue(hue + 2)));
    set('--surface-3', c(0.94, 0.03, clampHue(hue - 10)));
  }

  const g1 = c(dark ? 0.72 : 0.82, chroma * 0.88, clampHue(hue + 6));
  const g2 = c(dark ? 0.56 : 0.66, chroma * 1.04, clampHue(hue - 12));
  set('--gradient-gold', `linear-gradient(135deg, ${g1}, ${g2})`);

  set('--shadow-glow', `0 18px 44px -20px oklch(${dark ? 0.78 : 0.72} ${chroma} ${hue} / 0.65)`);
}
