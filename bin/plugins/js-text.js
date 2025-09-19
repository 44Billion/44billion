import esbuild from 'esbuild'
import path from 'node:path'
import { esbuildDefineConfig } from '../build.js'

export default {
  name: 'js-text',
  setup (build) {
    // Process files ending with .txt.js
    build.onLoad({ filter: /\.txt\.js$/ }, async (args) => {
      // First bundle/minify the JS file as IIFE
      const result = await esbuild.build({
        entryPoints: [args.path],
        bundle: true,
        minify: true,
        format: 'iife',
        target: build.initialOptions.target,
        define: esbuildDefineConfig,
        globalName: path.basename(args.path, '.txt.js')
          .replace(/[^a-zA-Z0-9_]/g, '_'),
        write: false
      })

      // Return the bundled code as a text module
      return {
        contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
        loader: 'js' // Treat as normal js
      }
    })
  }
}
