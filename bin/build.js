import esbuild from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import jsTextPlugin from './plugins/js-text.js'
import cssTextPlugin from './plugins/css-text.js'
import htmlTextPlugin from './plugins/html-text.js'
import swModulePlugin from './plugins/sw-module.js'

const { dirname } = import.meta
const isDev = process.env.NODE_ENV === 'development'

async function hashTree (dir, hash) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    hash.update(entry.name)
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) await hashTree(fullPath, hash)
    else hash.update(await readFile(fullPath))
  }
}

// Content hash of the app sources, injected into the launcher service worker
// as LAUNCHER_DEPLOY_HASH: it changes the worker's bytes on every deploy so
// the browser detects a new worker (and shows the update banner) even when
// only app.js/chunks/index.html changed — important for installed PWAs that
// stay open for days. The worker's cache name is NOT derived from this hash,
// so deploys don't churn the runtime cache (immutable chunks stay cached).
const deployHash = createHash('sha256')
await hashTree(path.join(dirname, '..', 'src'), deployHash)
const launcherDeployHash = deployHash.digest('hex').slice(0, 10)

export const esbuildDefineConfig = isDev
  ? { IS_DEVELOPMENT: JSON.stringify(true), IS_PRODUCTION: JSON.stringify(false), LAUNCHER_DEPLOY_HASH: JSON.stringify(launcherDeployHash) } //, 'globalThis._F_SHOULD_RESTORE_STATE_ON_TAB_RELOAD': JSON.stringify(true) }
  : { IS_DEVELOPMENT: JSON.stringify(false), IS_PRODUCTION: JSON.stringify(true), LAUNCHER_DEPLOY_HASH: JSON.stringify(launcherDeployHash) }
const prodOutdir = `${dirname}/../dist/${dirname.split('/').slice(-2, -1)}` // dist/<root dir>
// same as esbuild.build, but reusable
const ctx = await esbuild.context({
  plugins: [jsTextPlugin, cssTextPlugin, htmlTextPlugin, swModulePlugin],
  loader: {
    '.html': 'copy', '.ico': 'copy',
    '.png': 'copy', '.webmanifest': 'copy',
    '.svg': 'text',
    '.webp': 'dataurl'
  },
  define: esbuildDefineConfig,
  entryPoints: [
    `${dirname}/../src/components/app.js`,
    `${dirname}/../src/assets/html/index.html`, // will use "copy" loader
    // Favicon, home-screen icons and web app manifest — copied verbatim to the
    // output root so the launcher can serve them on the root domain.
    `${dirname}/../src/assets/media/favicon.png`,
    `${dirname}/../src/assets/media/apple-touch-icon.png`,
    `${dirname}/../src/assets/media/icon-192.png`,
    `${dirname}/../src/assets/media/icon-512.png`,
    `${dirname}/../src/assets/media/site.webmanifest`,
    // service worker is handled by sw-module plugin
    { in: `${dirname}/../src/service-workers/app/index.js`, out: 'app-sw' }, // app-sw.js (app subdomains)
    { in: `${dirname}/../src/service-workers/launcher/index.js`, out: 'launcher-sw' } // launcher-sw.js (root domain)
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
