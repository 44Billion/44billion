/*
 * Theme architecture
 * ------------------
 * This module is the single source of authored UI colors. Components consume
 * cssVars.colors instead of embedding color literals; semantic tokens may in
 * turn derive translucent states from base tokens with relative-color syntax.
 * Intrinsic media pixels (images, video and iframes) are intentionally outside
 * this palette and must not be altered with theme inversion filters.
 *
 * A { light, dark } value becomes light-dark(light, dark), with
 * `color-scheme: light dark` in global.css allowing the browser to follow
 * prefers-color-scheme natively. Each theme is emitted once, as a class with
 * a stable, deterministic name, applied to document.documentElement. Because
 * <html> is the root of the DOM tree, the whole document — including dialogs,
 * popovers and their ::backdrop boxes in the top layer — inherits the same
 * variables through the normal inheritance chain. Adding another theme means
 * registering another class here and swapping the class on <html>.
 *
 * The isolated app-page loader, deterministic app-icon monograms and
 * decorative artwork also keep their palettes here, even though they expose
 * purpose-specific representations.
 */
const colorPair = (light, dark) => Object.freeze({ light, dark })

export const defaultThemeColorValues = Object.freeze({
  bg: colorPair('oklch(0.97 0.005 256)', 'oklch(0.12 0 256)'),
  fg: colorPair('oklch(0.20 0.01 256)', 'oklch(0.87 0.01 256)'),
  bgAvatar: colorPair('oklch(0.90 0.01 256)', 'oklch(0.25 0.01 256)'),
  bgAvatarLoading: colorPair('oklch(0.82 0.01 256)', 'oklch(0.35 0.01 256)'),
  bg2: colorPair('oklch(0.99 0.003 256)', 'oklch(0.22 0 256)'),
  bg2Lighter: colorPair('oklch(1 0 256)', 'oklch(0.25 0 256)'),
  mg2: colorPair('oklch(0.82 0.01 256)', 'oklch(0.35 0 256)'),
  fg2: colorPair('oklch(0.32 0.01 256)', 'oklch(0.79 0 256)'),
  bg3: colorPair('oklch(0.90 0.01 256)', 'oklch(0.35 0 256)'),
  bg3Primary: colorPair('oklch(0.50 0.18 291.61)', 'oklch(0.53 0.16 291.61)'),
  bg3Secondary: colorPair('oklch(0.55 0.14 56.36)', 'oklch(0.53 0.13 56.36)'),
  fg3: colorPair('oklch(0.44 0.01 256)', 'oklch(0.72 0.01 256)'),
  bg4: colorPair('oklch(0.56 0.01 17.47)', 'oklch(0.53 0.01 17.47)'),
  bgAccentPrimary: colorPair('oklch(0.48 0.22 302.32)', 'oklch(0.56 0.25 302.32)'),
  bgAccentSecondary: colorPair('oklch(0.52 0.17 87.32)', 'oklch(0.52 0.20 87.32)'),
  fgAccent: colorPair('oklch(0.98 0.005 256)', 'oklch(0.98 0.005 256)'),
  fg2AccentPrimary: colorPair('oklch(0.43 0.20 302.32)', 'oklch(0.79 0.25 302.32)'),
  bgPrimary: colorPair('oklch(0.52 0.20 280)', 'oklch(0.54 0.20 280)'),
  bgSecondary: colorPair('oklch(0.56 0.15 65)', 'oklch(0.56 0.15 65)'),
  fgSuccess: colorPair('oklch(0.42 0.16 142.32)', 'oklch(0.55 0.22 142.32)'),
  fgError: colorPair('oklch(0.48 0.20 25)', 'oklch(0.60 0.22 25)'),

  fgMuted: colorPair('oklch(0.46 0.01 256)', 'oklch(0.65 0.01 256)'),
  fgOnMedia: colorPair('oklch(0.98 0.005 256)', 'oklch(0.98 0.005 256)'),
  overlayHover: 'oklch(from var(--fg2) l c h / 0.08)',
  overlaySelected: 'oklch(from var(--fg2) l c h / 0.15)',
  scrollbarThumb: 'oklch(from var(--fg2) l c h / 0.20)',
  scrollbarThumbHover: 'oklch(from var(--fg2) l c h / 0.50)',
  toggleThumb: colorPair('oklch(0.44 0 256)', 'oklch(0.98 0 256)'),
  shadow: colorPair('rgb(0 0 0 / 0.15)', 'rgb(0 0 0 / 0.35)'),
  shadowStrong: colorPair('rgb(0 0 0 / 0.30)', 'rgb(0 0 0 / 0.50)'),
  modalBackdrop: colorPair('rgb(0 0 0 / 0.60)', 'rgb(0 0 0 / 0.60)'),
  cachingOverlay: colorPair('rgb(0 0 0 / 0.80)', 'rgb(0 0 0 / 0.80)'),
  cachingProgressTrack: colorPair('rgb(0 0 0 / 0.70)', 'rgb(0 0 0 / 0.70)'),
  cachingProgressAccent: colorPair('oklch(0.62 0.22 297.62 / 0.9)', 'oklch(0.62 0.22 297.62 / 0.9)'),

  artworkPurpleStart: colorPair('#d8b4fe', '#d8b4fe'),
  artworkPurpleMiddle: colorPair('#a855f7', '#a855f7'),
  artworkPurpleEnd: colorPair('#581c87', '#581c87'),
  artworkHighlight: colorPair('rgb(255 255 255 / 0.15)', 'rgb(255 255 255 / 0.15)'),
  artworkShade: colorPair('rgb(0 0 0 / 0.20)', 'rgb(0 0 0 / 0.20)'),
  artworkStroke: colorPair('rgb(255 255 255 / 0.30)', 'rgb(255 255 255 / 0.30)'),
  artworkGlow: colorPair('rgb(168 85 247 / 0.80)', 'rgb(168 85 247 / 0.80)'),
  artworkIceStart: colorPair('oklch(0.97 0.02 245 / 0.42)', 'oklch(0.97 0.02 245 / 0.42)'),
  artworkIceMiddle: colorPair('oklch(0.9 0.04 235 / 0.36)', 'oklch(0.9 0.04 235 / 0.36)'),
  artworkIceEnd: colorPair('oklch(0.8 0.05 225 / 0.3)', 'oklch(0.8 0.05 225 / 0.3)'),
  artworkIceHighlight: colorPair('oklch(1 0 0 / 0.5)', 'oklch(1 0 0 / 0.5)'),
  artworkIceShade: colorPair('oklch(0.72 0.04 235 / 0.34)', 'oklch(0.72 0.04 235 / 0.34)'),
  artworkIceStroke: colorPair('oklch(0.97 0.02 245 / 0.7)', 'oklch(0.97 0.02 245 / 0.7)')
})

export const appIconMonogramPalettes = Object.freeze([
  { lightBg: '#fee2e2', lightFg: '#991b1b', darkBg: '#7f1d1d', darkFg: '#fecaca' },
  { lightBg: '#ffedd5', lightFg: '#9a3412', darkBg: '#7c2d12', darkFg: '#fed7aa' },
  { lightBg: '#fef3c7', lightFg: '#92400e', darkBg: '#78350f', darkFg: '#fde68a' },
  { lightBg: '#dcfce7', lightFg: '#166534', darkBg: '#14532d', darkFg: '#bbf7d0' },
  { lightBg: '#ccfbf1', lightFg: '#115e59', darkBg: '#134e4a', darkFg: '#99f6e4' },
  { lightBg: '#dbeafe', lightFg: '#1e40af', darkBg: '#1e3a8a', darkFg: '#bfdbfe' },
  { lightBg: '#e0e7ff', lightFg: '#3730a3', darkBg: '#312e81', darkFg: '#c7d2fe' },
  { lightBg: '#f3e8ff', lightFg: '#6b21a8', darkBg: '#581c87', darkFg: '#e9d5ff' },
  { lightBg: '#fce7f3', lightFg: '#9d174d', darkBg: '#831843', darkFg: '#fbcfe8' },
  { lightBg: '#e2e8f0', lightFg: '#334155', darkBg: '#334155', darkFg: '#e2e8f0' }
])

const appPageLoaderColorValues = Object.freeze({
  bgColor: colorPair('#f8f8f8', '#1e1e1e'),
  textColor: colorPair('#333333', '#eaeaea'),
  accentColor: colorPair('#7a3ad3', '#b589f9'),
  accentDarkerColor: colorPair('#8242d9', '#a069f6'),
  iconBgColor: colorPair('#e9e9e9', '#3a3a3a'),
  progressBarBg: colorPair('#e9e9e9', '#3a3a3a'),
  pixelOstrichBody: 'var(--accent-color)',
  pixelOstrichBeak: colorPair('#ffa500', '#ffc966'),
  pixelOstrichLeg: colorPair('#8b4513', '#a0522d'),
  pixelOstrichEye: colorPair('#000000', '#ffffff'),
  pixelOstrichAccent: 'var(--accent-darker-color)',
  pulseBg1: colorPair('#f0f0f0', '#000000'),
  pulseBg2: colorPair('#999999', '#1e1e1e'),
  shapeCircle: colorPair('#ff6b6b', '#ff6b6b'),
  shapeTriangle: colorPair('#4ecdc4', '#4ecdc4'),
  shapeSquare: colorPair('#45b7d1', '#45b7d1'),
  shapePlus: colorPair('#f9d423', '#f9d423')
})

function toCssValue (value) {
  if (typeof value === 'string') return value
  return `light-dark(${value.light}, ${value.dark})`
}

function toCssVarName (key) {
  return `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`
}

function createCssDeclarations (colors, cssVars = {}) {
  return Object.entries(colors).map(([key, value]) => {
    const cssVarName = toCssVarName(key)
    cssVars[key] = `var(${cssVarName})`
    return `  ${cssVarName}: ${toCssValue(value)};`
  }).join('\n')
}

function createThemeClass (name, colors) {
  const cssVars = {}
  const declarations = createCssDeclarations(colors, cssVars)
  return Object.freeze({
    name,
    cssClass: name,
    cssVars,
    css: `.${name} {\n${declarations}\n}`
  })
}

const defaultTheme = createThemeClass('theme-default', defaultThemeColorValues)

export const themes = Object.freeze({
  default: defaultTheme
})

const themesByContract = new Map([
  [defaultThemeColorValues, defaultTheme]
])

export function getThemeByContract (colors) {
  return themesByContract.get(colors) ?? null
}

export const cssStrings = {
  defaultTheme: defaultTheme.css,
  appPageLoaderTheme: `:root {\n${createCssDeclarations(appPageLoaderColorValues)}\n}`
}

export const cssClasses = {
  defaultTheme: defaultTheme.cssClass
}

export const cssVars = {
  colors: defaultTheme.cssVars
}

export const jsVars = {
  breakpoints: {
    mobile: '(max-width: 718px)',
    desktop: '(min-width: 719px)'
  }
}
