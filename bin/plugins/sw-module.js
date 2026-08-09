import esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

// The injected version line in worker sources (e.g. launcher's VERSION) is
// excluded from the hash so injecting the hash never changes the hash.
const VERSION_LINE = /^const VERSION\s*=/

export default {
  name: 'sw-module',
  setup (build) {
    // Handle the service worker files (app subdomains + launcher root domain)
    build.onResolve({ filter: /service-workers\/(?:app|launcher)\/index\.js$/ }, args => {
      if (args.namespace === 'sw-bundle') {
        return {
          namespace: 'file',
          path: args.path
        }
      }

      return {
        namespace: 'sw-bundle',
        path: args.path
      }
    })

    build.onLoad({ filter: /.*/, namespace: 'sw-bundle' }, async (args) => {
      // Content hash of the worker logic: the launcher's cache name changes
      // exactly when the worker itself changes, while normal deploys that
      // don't touch the worker keep the same cache (and thus their cached
      // immutable chunks).
      const source = await readFile(args.path, 'utf8')
      const version = createHash('sha256')
        .update(source.split('\n').filter(line => !VERSION_LINE.test(line)).join('\n'))
        .digest('hex')
        .slice(0, 10)

      // Bundle the service worker module as IIFE
      const result = await esbuild.build({
        entryPoints: [args.path],
        bundle: true,
        format: 'iife', // Firefox compatibility
        splitting: false, // Firefox compatibility
        write: false,
        plugins: build.initialOptions.plugins.filter(p => p.name !== 'sw-module'), // Avoid recursion
        define: {
          ...build.initialOptions.define,
          LAUNCHER_SW_VERSION: JSON.stringify(version)
        },
        platform: build.initialOptions.platform,
        target: build.initialOptions.target,
        minify: build.initialOptions.minify,
        sourcemap: build.initialOptions.sourcemap,
        keepNames: build.initialOptions.keepNames
      })
      const jsOutput = result.outputFiles.find(file => !file.path.endsWith('.map'))

      return {
        contents: jsOutput.text,
        loader: 'js'
      }
    })
  }
}
