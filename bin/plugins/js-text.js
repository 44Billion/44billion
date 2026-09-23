import esbuild from 'esbuild'
import path from 'node:path'

export default function jsTextPlugin (maps) {
  return {
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
          define: build.initialOptions.define,
          sourcemap: maps.enabled ? 'external' : false,
          sourcesContent: true,
          outfile: args.path + '.compiled.js',
          globalName: path.basename(args.path, '.txt.js')
            .replace(/[^a-zA-Z0-9_]/g, '_'),
          write: false
        })

        let code = result.outputFiles.find(file => file.path.endsWith('.js')).text
        if (maps.enabled) {
          const map = result.outputFiles.find(file => file.path.endsWith('.map'))
          const url = maps.injected(map.text, path.dirname(map.path))
          const name = path.basename(args.path)
          code += `\n//# sourceURL=/~~injected/${name}\n//# sourceMappingURL=${url}\n`
        }
        // Return the bundled code as a text module
        return {
          contents: `export default ${JSON.stringify(code)};`,
          loader: 'js' // Treat as normal js
        }
      })
    }
  }
}
