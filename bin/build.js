import esbuild from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import jsTextPlugin from './plugins/js-text.js'
import cssTextPlugin from './plugins/css-text.js'
import htmlTextPlugin from './plugins/html-text.js'
import swModulePlugin from './plugins/sw-module.js'

const isDev = process.env.NODE_ENV === 'development'
export const esbuildDefineConfig = isDev
  ? { IS_DEVELOPMENT: JSON.stringify(true), IS_PRODUCTION: JSON.stringify(false) } //, 'globalThis._F_SHOULD_RESTORE_STATE_ON_TAB_RELOAD': JSON.stringify(true) }
  : { IS_DEVELOPMENT: JSON.stringify(false), IS_PRODUCTION: JSON.stringify(true) }
const { dirname } = import.meta
const prodOutdir = `${dirname}/../dist/${dirname.split('/').slice(-2, -1)}` // dist/<root dir>
// same as esbuild.build, but reusable
const ctx = await esbuild.context({
  plugins: [jsTextPlugin, cssTextPlugin, htmlTextPlugin, swModulePlugin],
  loader: {
    '.html': 'copy', '.ico': 'copy',
    '.svg': 'text',
    '.webp': 'dataurl'
  },
  define: esbuildDefineConfig,
  entryPoints: [
    `${dirname}/../src/components/app.js`,
    `${dirname}/../src/assets/html/index.html`, // will use "copy" loader
    // `${dirname}/../src/assets/media/favicon.ico` // will use "copy" loader
    // service worker is handled by sw-module plugin
    { in: `${dirname}/../src/service-workers/app/index.js`, out: 'app-sw' } // app-sw.js
  ],
  outdir: isDev
    // .serve({ servedir: `${dirname}/../src/assets/html` }) will serve app.js from memory as if it was there
    // and also index.html that ~~is~~was really there (now its an entrypoint)
    ? `${dirname}/../src/assets/html`
    // .build() will create app.js at `${dirname}/../build
    : prodOutdir,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true, // it didn't work without this explicitly set
  bundle: true,
  platform: 'browser',
  format: 'esm',
  // https://caniuse.com/?search=top%20level%20await
  // edge91 and chrome91 to make signal$?.() work
  target: ['edge91', 'firefox89', 'chrome91', 'safari15'],
  minify: !isDev,
  sourcemap: isDev,
  keepNames: false, // set it to true if the code relies on (function a(){}).name === 'a'
  write: !isDev // serve from memory if isDev
})

if (isDev) {
  await ctx.watch()
  console.log('watching...')

  // esbuild's built-in web server
  const { hosts, port } = await ctx.serve({
    host: '127.0.0.1',
    port: 8080,
    // serve non-built assets from here like /index.html ~~is~~was
    // (now it's at entryPoints and has loader: { '.html': 'copy' } for it)
    // servedir must contain the outdir
    // servedir: `${dirname}/../src/assets/html`,
    // when url matches no file on ${dirname}/../src/assets/html
    fallback: `${dirname}/../src/assets/html/index.html`
  })
  console.log(`serving at http://${hosts.join('|')}:${port}`)

  process.on('SIGINT', async function () {
    console.log('Ctrl-C was pressed')
    await ctx.dispose()
    console.log('stopped watching')
  })
} else {
  const joinedProdOutDir = path.join(prodOutdir)
  // safe checks before deleting build directory
  if (
    joinedProdOutDir.startsWith(path.join(`${dirname}/..`)) &&
    joinedProdOutDir.includes('/dist/') &&
    !joinedProdOutDir.includes('..')
  ) {
    console.log(`Clearing ${joinedProdOutDir}`)
    fs.rmSync(joinedProdOutDir, { recursive: true, force: true })
  }
  console.log(`Building to ${joinedProdOutDir}`)
  ctx.rebuild()
  ctx.dispose()
}
