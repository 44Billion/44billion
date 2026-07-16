const warnedAssets = new Set()
const MAX_WARNED_ASSETS = 1000

// Reports an untrusted size hint mismatch at most once per service/root pair.
export function warnAssetSizeMismatch ({ service, root, advertisedSize, actualSize, source = 'manifest' }) {
  if (advertisedSize == null || advertisedSize === actualSize) return false

  const key = `${service}:${root}`
  if (warnedAssets.has(key)) return false
  if (warnedAssets.size >= MAX_WARNED_ASSETS) warnedAssets.delete(warnedAssets.values().next().value)
  warnedAssets.add(key)

  console.warn(
    `Ignoring ${service} asset size mismatch for ${root}: ` +
    `${source} advertised ${advertisedSize} bytes, received ${actualSize} bytes`
  )
  return true
}
