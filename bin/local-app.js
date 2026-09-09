import { readFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey } from 'libp2r2p/key'
import { finalizeEvent } from 'libp2r2p/event'
import { appEncode } from 'libp2r2p/nip19'
import { addressObjToAppId } from '../src/helpers/app.js'
import mime from 'mime'

// A local publisher never reads or replaces the real uploader's credentials.
export async function localIdentity (projectRoot) {
  const directory = path.join(projectRoot, 'tmp/local-dev')
  const filename = path.join(directory, 'identity.json')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const handle = await open(filename, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ secret: Buffer.from(generateSecretKey()).toString('hex') }) + '\n'); await handle.sync() } finally { await handle.close() }
  } catch (error) { if (error.code !== 'EEXIST') throw error }
  const value = JSON.parse(await readFile(filename, 'utf8'))
  if (!/^[0-9a-f]{64}$/.test(value?.secret ?? '')) throw new Error(`Invalid local development identity: ${filename}`)
  const secret = new Uint8Array(Buffer.from(value.secret, 'hex'))
  getPublicKey(secret)
  return secret
}

// Builds a signed local manifest and immutable files; nothing is published.
export function prepareLocalApp (files, { secret, identifier = 'test-app', name = 'Test app', createdAt = Math.floor(Date.now() / 1000) } = {}) {
  const metadataFile = files.find(file => file.name === '.well-known/napp.json')
  const metadata = metadataFile ? JSON.parse(new TextDecoder().decode(metadataFile.bytes)) : {}
  const assets = []
  const names = new Set()
  const add = (name, bytes, type = mime.getType(name) || 'application/octet-stream') => {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid local asset path')
    if (names.has(name)) throw new Error(`Duplicate local asset: ${name}`)
    names.add(name)
    const body = Buffer.from(bytes)
    const asset = { name, root: createHash('sha256').update(body).digest('hex'), size: body.length, mimeType: type, body: body.toString('base64') }
    assets.push(asset)
    return asset
  }
  for (const file of files) if (file.name !== '.well-known/napp.json') add(file.name, file.bytes)
  if (!names.has('index.html')) throw new Error('Local app requires index.html')
  const tags = [['d', identifier], ['service', 'blossom']]
  for (const key of ['name', 'summary', 'description']) {
    for (const entry of metadata[key] ?? []) if (Array.isArray(entry) && typeof entry[0] === 'string') tags.push([key, ...entry.filter(value => typeof value === 'string')])
  }
  if (!tags.some(tag => tag[0] === 'name')) tags.push(['name', name])
  for (const country of metadata.country?.length ? metadata.country : ['*']) tags.push(['c', country])
  if (metadata.self?.[0]?.[0]) tags.push(['self', metadata.self[0][0]])
  for (const [category, children] of metadata.category ?? []) for (const child of children ?? []) tags.push(['l', `napp.${category}:${child}`])
  for (const entry of metadata.hashtag ?? []) tags.push(['t', ...entry])
  const addMedia = (dataUrl, mark, index, country) => {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '')
    if (!match) throw new Error(`Local ${mark} must contain a data URL`)
    const bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]))
    const asset = add(`__local_media__/${mark}-${index}`, bytes, match[1])
    tags.push(['r', asset.root, country ? `${mark} ${country}` : mark, `m ${asset.mimeType}`, `size ${asset.size}`])
  }
  if (metadata.icon?.[0]?.[0]) addMedia(metadata.icon[0][0], 'icon', 0)
  else {
    const html = Buffer.from(assets.find(asset => asset.name === 'index.html').body, 'base64').toString()
    const link = (html.match(/<link\b[^>]*>/gi) ?? []).find(tag => /\brel\s*=\s*['"][^'"]*\bicon\b/i.test(tag))
    const href = link?.match(/\bhref\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    const icon = assets.find(asset => asset.name === href?.replace(/^\.?\//, ''))
    if (icon) tags.push(['r', icon.root, 'icon', `m ${icon.mimeType}`, `size ${icon.size}`], ['auto', 'icon'])
  }
  for (const [key, mark] of [['keyArt', 'key_art'], ['screenshot', 'screenshot']]) {
    for (const [index, entry] of (metadata[key] ?? []).entries()) addMedia(entry[0], mark, index, entry[1])
  }
  for (const asset of assets) tags.push(['path', `/${asset.name}`, asset.root])
  const revision = createHash('sha256').update(JSON.stringify(tags)).digest('hex')
  const manifest = finalizeEvent({ kind: 35130, created_at: createdAt, tags, content: '' }, secret)
  const address = { kind: manifest.kind, pubkey: manifest.pubkey, dTag: identifier }
  const appId = addressObjToAppId(address)
  return { project: appId, appId, app: appEncode(address), revision, manifest, assets }
}
