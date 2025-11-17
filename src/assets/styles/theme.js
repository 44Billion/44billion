function createTheme (obj) {
  const themeCssClass = `theme-${Math.random().toString(36).slice(2)}`
  const cssVars = {}
  const cssString =
`.${themeCssClass} {
${Object.entries(obj).map(([k, v], i, array) => {
  const cssVarName = `--${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`
  cssVars[k] = `var(${cssVarName})`

  return `  ${cssVarName}: ${v};` + ((array.length - 1) === i ? '' : '\n')
}).join('')}
}
`
  return [themeCssClass, cssVars, cssString]
}

// bg (background) = background-color
// mg (midground) = border-color
// fg (foreground) = (font) color
//
// bg2 is a bg layer above bg, e.g. for cards, bg3 is above bg2, etc.
// There are special names such as bg2Lighter that has lighter color
// and, because it starts with "bg2" string, is at the same layer as bg2
//
// mg2 is usually border color for elements on bg2 layer
//
// fg2 is usually font color for elements on bg2 layer
const [defaultThemeCssClass, colorCssVarsObj, defaultThemeCssString] = createTheme({
  bg: 'oklch(0.12 0 256)',
  fg: 'oklch(0.87 0.01 256)',
  bgAvatar: 'oklch(0.25 0.01 256)',
  bg2: 'oklch(0.22 0 256)',
  bg2Lighter: 'oklch(0.25 0 256)',
  mg2: 'oklch(0.35 0 256)',
  fg2: 'oklch(0.79 0 256)',
  bg3: 'oklch(0.35 0 256)',
  bg3Primary: 'oklch(0.44 0.16 291.61)',
  bg3Secondary: 'oklch(0.53 0.13 56.36)',
  fg3: 'oklch(0.71 0.01 256)',
  bg4: 'oklch(0.49 0.01 17.47)',
  bgAccentPrimary: 'oklch(0.56 0.25 302.32)',
  bgAccentSecondary: 'oklch(0.56 0.20 87.32)',
  bgPrimary: 'oklch(0.65 0.20 280)',
  bgSecondary: 'oklch(0.70 0.15 65)',
  fgError: 'oklch(0.55 0.22 25)'
  // bgHeader: 'oklch(0.25 0.01 256)',
  // mgHeader: '#101011', // darker than bg
  // fgHeader: 'oklch(0.72 0 256)',
  // bgSubtle: 'oklch(0.29 0.01 256)', // based on header but lighter
  // fgLogo: 'oklch(0.27 0.20 280)',
  // fgCounter: 'oklch(0.63 0 0)', // it is fgHeader a bit darker but lighter than bg4
})

export const cssStrings = {
  defaultTheme: defaultThemeCssString
}

export const cssClasses = {
  defaultTheme: defaultThemeCssClass
}

export const cssVars = {
  colors: colorCssVarsObj
}

export const jsVars = {
  breakpoints: {
    mobile: '(max-width: 718px)',
    desktop: '(min-width: 719px)'
  }
}
