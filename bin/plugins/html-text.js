import path from 'node:path'
import { readFile } from 'node:fs/promises'

export default {
  name: 'html-text',
  setup (build) {
    // This plugin handles .txt.html files, loading them as text.
    // Other .html files will be handled by esbuild's built-in copy loader.
    build.onResolve({ filter: /\.txt\.html$/ }, args => {
      // Resolve the path and assign a namespace to handle it in the onLoad callback
      return {
        path: path.join(args.resolveDir, args.path),
        namespace: 'html-text-namespace'
      }
    })

    // The onLoad callback for our namespace. It reads the file and returns the content as text.
    build.onLoad({ filter: /.*/, namespace: 'html-text-namespace' }, async (args) => {
      try {
        const content = await readFile(args.path, 'utf8')
        return {
          contents: content,
          loader: 'text'
        }
      } catch (e) {
        return {
          errors: [{
            text: `Could not read file: ${args.path}`,
            detail: e.message
          }]
        }
      }
    })
  }
}
