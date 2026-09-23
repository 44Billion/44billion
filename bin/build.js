import esbuild from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import jsTextPlugin from './plugins/js-text.js'
import cssTextPlugin from './plugins/css-text.js'
import htmlTextPlugin from './plugins/html-text.js'
import swModulePlugin from './plugins/sw-module.js'
import { EMIT_SOURCEMAPS } from './build-settings.js'
import { createSourceMaps } from './sourcemaps.js'
import { createBuildOutput } from './build-output.js'

const { dirname } = import.meta
const isDev = process.env.NODE_ENV === 'development'
const emitSourceMaps = isDev || EMIT_SOURCEMAPS

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

const esbuildDefineConfig = isDev
  ? { IS_DEVELOPMENT: JSON.stringify(true), IS_PRODUCTION: JSON.stringify(false), LAUNCHER_DEPLOY_HASH: JSON.stringify(launcherDeployHash) } //, 'globalThis._F_SHOULD_RESTORE_STATE_ON_TAB_RELOAD': JSON.stringify(true) }
  : { IS_DEVELOPMENT: JSON.stringify(false), IS_PRODUCTION: JSON.stringify(true), LAUNCHER_DEPLOY_HASH: JSON.stringify(launcherDeployHash) }
const prodOutdir = `${dirname}/../dist/${dirname.split('/').slice(-2, -1)}` // dist/<root dir>
const outdir = path.resolve(isDev ? `${dirname}/../src/assets/html` : prodOutdir)
const maps = createSourceMaps({ enabled: emitSourceMaps, root: path.resolve(dirname, '..') })
const output = createBuildOutput(maps, outdir, {
  ready: ok => process.send?.({ type: 'build-end', ok })
})
const ctx = await esbuild.context({
  plugins: [jsTextPlugin(maps), cssTextPlugin, htmlTextPlugin, swModulePlugin, output.plugin],
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
  outdir,
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
  sourcemap: emitSourceMaps ? 'external' : false,
  sourcesContent: true,
  keepNames: false, // set it to true if the code relies on (function a(){}).name === 'a'
  write: false // finalize maps before publishing any output
})

if (isDev) {
  await ctx.watch()
  console.log('watching...')

  const server = await output.serve()
  console.log('serving at http://127.0.0.1:8080')

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await ctx.dispose()
      process.disconnect?.()
    })
  }
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
  try {
    await ctx.rebuild()
    // Write map artifacts first; production serving starts after the build ends.
    for (const [url, bytes] of output.files) {
      const filename = path.join(outdir, url)
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, bytes)
    }
  } finally { await ctx.dispose() }
}
