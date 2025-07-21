import esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'

// https://github.com/evanw/esbuild/issues/2609#issuecomment-1279867125
export default {
  name: 'css-text',
  setup (build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const f = await readFile(args.path)
      const css = await esbuild.transform(f, { loader: 'css', minify: true })
      return { loader: 'text', contents: css.code }
    })
  }
}
