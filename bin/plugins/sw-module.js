import esbuild from 'esbuild'

export default {
  name: 'sw-module',
  setup (build) {
    // Handle just the service worker file
    build.onResolve({ filter: /service-workers\/app\/index\.js$/ }, args => {
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
      // Bundle the service worker module as IIFE
      const result = await esbuild.build({
        entryPoints: [args.path],
        bundle: true,
        format: 'iife', // Firefox compatibility
        splitting: false, // Firefox compatibility
        write: false,
        plugins: build.initialOptions.plugins.filter(p => p.name !== 'sw-module'), // Avoid recursion
        define: build.initialOptions.define,
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
