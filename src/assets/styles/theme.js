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

const [defaultThemeCssClass, colorCssVarsObj, defaultThemeCssString] = createTheme({
  bg: 'oklch(0.12 0 256)',
  bgFont: 'oklch(0.87 0.01 256)',
  header: 'oklch(0.25 0.01 256)',
  headerBorder: '#101011', // darker than bg
  headerFont: 'oklch(0.72 0 256)',
  subtleBg: 'oklch(0.29 0.01 256)', // based on header but lighter
  mg: 'oklch(0.22 0 256)',
  mgLighter: 'oklch(0.25 0 256)',
  mgBorder: 'oklch(0.35 0 256)',
  mgFont: 'oklch(0.79 0 256)',
  fg: 'oklch(0.35 0 256)',
  fgPrimary: 'oklch(0.44 0.16 291.61)',
  fgSecondary: 'oklch(0.53 0.13 56.36)',
  fgFont: 'oklch(0.96 0.01 256)',
  ffg: 'oklch(0.49 0.01 17.47)',
  accentPrimary: 'oklch(0.56 0.25 302.32)',
  accentSecondary: 'oklch(0.56 0.20 87.32)',
  primary: 'oklch(0.65 0.20 280)',
  secondary: 'oklch(0.70 0.15 65)',
  logo: 'oklch(0.27 0.20 280)',
  counter: 'oklch(0.63 0 0)', // it is headerFont a bit darker but lighter than ffg
  error: 'oklch(0.55 0.22 25)'
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
