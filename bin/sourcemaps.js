import path from 'node:path'
import { createHash } from 'node:crypto'

export const sourceMapPrefix = '/~~sourcemaps/'

// One collector per outer build; nested builds contribute their injected maps.
export function createSourceMaps ({ enabled, root }) {
  const injected = new Map()
  const register = (text, directory, destination) => {
    const map = JSON.parse(text)
    map.sources = map.sources.map(source => {
      // esbuild namespaces can prefix absolute paths in plugin-generated maps.
      source = source.replace(/^[a-z-]+:(?=\/)/, '')
      return path.relative(root, path.resolve(directory, map.sourceRoot || '', source)).split(path.sep).join('/')
    })
    delete map.sourceRoot
    delete map.file
    const bytes = Buffer.from(JSON.stringify(map))
    const url = sourceMapPrefix + createHash('sha256').update(bytes).digest('hex') + '.map'
    destination.set(url, bytes)
    return url
  }
  return {
    enabled,
    begin () { injected.clear() },
    injected (text, directory) { return register(text, directory, injected) },
    finish (files, outdir) {
      const output = new Map(injected)
      const maps = new Map()
      for (const file of files) {
        if (enabled && file.path.endsWith('.map')) maps.set(file.path.slice(0, -4), register(file.text, path.dirname(file.path), output))
      }
      for (const file of files) {
        if (file.path.endsWith('.map')) continue
        const url = '/' + path.relative(outdir, file.path).split(path.sep).join('/')
        const map = maps.get(file.path)
        output.set(url, map ? Buffer.from(file.text + `\n//# sourceMappingURL=${map}\n`) : Buffer.from(file.contents))
      }
      return output
    }
  }
}
