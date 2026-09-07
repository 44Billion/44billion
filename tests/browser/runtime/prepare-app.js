import esbuild from 'esbuild'
import NMMR from 'nmmr'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from 'libp2r2p/base16'
import { encode } from 'libp2r2p/base93'
import { finalizeEvent } from 'libp2r2p/event'
import { generateSecretKey } from 'libp2r2p/key'
import { appEncode } from 'libp2r2p/nip19'
import { DRAFT_SITE_MANIFEST } from 'libp2r2p/kind'
import { APP_FILE_CHUNK_BYTES } from '../../../src/constants/app-file.js'
import { launcherRoot } from '../../../bin/dev-runtime.js'

export async function prepareTestApp (files, { identifier = 'test-app', name = 'Test app' } = {}) {
  const chunks = []
  const tags = [['d', identifier], ['name', name]]
  for (const { name, bytes } of files) {
    if (name === '.well-known/napp.json') continue
    const root = bytesToBase16(sha256(bytes))
    tags.push(['path', `/${name}`, root])
    const total = Math.max(1, Math.ceil(bytes.length / APP_FILE_CHUNK_BYTES))
    const events = []
    for (let index = 0; index < total; index++) {
      events.push({
        kind: 34601,
        tags: [['d', NMMR.deriveChunkId(root, index)], ['mmr', String(index), String(total), '']],
        content: encode(bytes.slice(index * APP_FILE_CHUNK_BYTES, (index + 1) * APP_FILE_CHUNK_BYTES))
      })
    }
    chunks.push({ root, events })
  }
  const manifest = finalizeEvent({ kind: DRAFT_SITE_MANIFEST, created_at: Math.floor(Date.now() / 1000), content: '', tags }, generateSecretKey())
  const result = await esbuild.build({
    absWorkingDir: launcherRoot, entryPoints: ['tests/browser/runtime/install-app.js'],
    bundle: true, write: false, format: 'esm',
    define: { IS_DEVELOPMENT: 'true', IS_PRODUCTION: 'false' }, logLevel: 'silent'
  })
  esbuild.stop()
  return {
    manifest,
    app: appEncode({ kind: manifest.kind, pubkey: manifest.pubkey, dTag: identifier }),
    installExpression: `import(${JSON.stringify('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))}).then(module => module.cacheTestApp(${JSON.stringify({ manifest, chunks })}))`
  }
}
