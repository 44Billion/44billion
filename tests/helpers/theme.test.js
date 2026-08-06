import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import {
  cssStrings,
  cssVars,
  defaultThemeColorValues
} from '../../src/assets/styles/theme.js'

const sourceRoot = path.resolve(import.meta.dirname, '../../src')
const themeSource = path.join(sourceRoot, 'assets/styles/theme.js')

const normalTextPairs = [
  ['fg', 'bg'],
  ['fg', 'bg2'],
  ['fg2', 'bg2'],
  ['fg2', 'bg2Lighter'],
  ['fg3', 'bgAvatar'],
  ['fgAccent', 'bgAccentPrimary'],
  ['fgAccent', 'bgAccentSecondary'],
  ['fgAccent', 'bgPrimary'],
  ['fg2AccentPrimary', 'bg2'],
  ['fgSuccess', 'bg'],
  ['fgError', 'bg']
]

const graphicalPairs = [
  ['bg4', 'bg2Lighter'],
  ['bg3Primary', 'bg2'],
  ['bg3Secondary', 'bg2']
]

describe('native color themes', () => {
  it('keeps the established CSS-variable API and emits root and class themes', () => {
    for (const key of Object.keys(defaultThemeColorValues)) {
      assert.equal(cssVars.colors[key], `var(--${toKebabCase(key)})`)
    }

    assert.match(cssStrings.defaultTheme, /^\.theme-/)
    assert.match(cssStrings.defaultThemeRoot, /^:root/)
    assert.match(cssStrings.defaultThemeRoot, /--bg: light-dark\(/)
    assert.match(cssStrings.defaultThemeRoot, /--control-highlight: Highlight;/)
  })

  it('keeps every used text pair at WCAG AA contrast in both schemes', () => {
    for (const scheme of ['light', 'dark']) {
      for (const [foreground, background] of normalTextPairs) {
        assert.ok(
          contrastRatio(
            defaultThemeColorValues[foreground][scheme],
            defaultThemeColorValues[background][scheme]
          ) >= 4.5,
          `${scheme} ${foreground}/${background} must reach 4.5:1`
        )
      }
    }
  })

  it('keeps state and control graphics at 3:1 contrast in both schemes', () => {
    for (const scheme of ['light', 'dark']) {
      for (const [foreground, background] of graphicalPairs) {
        assert.ok(
          contrastRatio(
            defaultThemeColorValues[foreground][scheme],
            defaultThemeColorValues[background][scheme]
          ) >= 3,
          `${scheme} ${foreground}/${background} must reach 3:1`
        )
      }
    }
  })

  it('injects the centralized palette into the isolated app loader', async () => {
    const loaderPath = path.join(sourceRoot, 'assets/html/app-page-loader.txt.html')
    const loaderSource = await readFile(loaderPath, 'utf8')
    const themedLoader = loaderSource.replace(
      '/* APP_PAGE_LOADER_THEME */',
      cssStrings.appPageLoaderTheme
    )

    assert.doesNotMatch(themedLoader, /APP_PAGE_LOADER_THEME/)
    assert.match(themedLoader, /--bg-color: light-dark\(/)
    assert.match(themedLoader, /fill="var\(--shape-circle\)"/)
  })

  it('keeps authored color literals and light-theme inversion out of consumers', async () => {
    const files = (await listSourceFiles(sourceRoot))
      .filter(file => file !== themeSource)
    const authoredColorLiteral = /#[\da-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\(/i
    const authoredColorKeyword = /(?:color|background(?:-color)?|border(?:-color)?|fill|stroke)\s*:\s*(?:black|white|Canvas|CanvasText|Highlight|HighlightText)\b/i

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      assert.doesNotMatch(source, authoredColorLiteral, path.relative(sourceRoot, file))
      assert.doesNotMatch(source, authoredColorKeyword, path.relative(sourceRoot, file))
      assert.doesNotMatch(source, /\b(?:hue-revert|do-hue-invert)\b/, path.relative(sourceRoot, file))
      if (!file.endsWith('/assets/styles/reset.css')) {
        assert.doesNotMatch(source, /filter\s*:\s*invert\(/, path.relative(sourceRoot, file))
      }
    }
  })

  it('wraps every interpolated style body in one uhtml interpolation', async () => {
    const files = (await listSourceFiles(sourceRoot))
      .filter(file => file.endsWith('.js'))
    const styleTag = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(styleTag)) {
        const body = match[1]
        if (!body.includes('${')) continue

        const line = source.slice(0, match.index).split('\n').length
        const message = `${path.relative(sourceRoot, file)}:${line}`
        assert.match(body.trimStart(), /^\$\{/, message)
        assert.match(body.trimEnd(), /\}$/, message)
      }
    }
  })
})

async function listSourceFiles (directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(entries.map(entry => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(entryPath)
    return /\.(?:css|html|js)$/.test(entry.name) ? [entryPath] : []
  }))
  return nestedFiles.flat()
}

function toKebabCase (value) {
  return value.replace(/([A-Z])/g, '-$1').toLowerCase()
}

function contrastRatio (foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left)
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance (color) {
  const match = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(color)
  assert.ok(match, `Expected an opaque OKLCH color, received ${color}`)
  const [, lightness, chroma, hue] = match.map(Number)
  const hueRadians = hue * Math.PI / 180
  const a = chroma * Math.cos(hueRadians)
  const b = chroma * Math.sin(hueRadians)
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b
  const l = lRoot ** 3
  const m = mRoot ** 3
  const s = sRoot ** 3
  const [red, green, blue] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map(channel => Math.min(1, Math.max(0, channel)))

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}
