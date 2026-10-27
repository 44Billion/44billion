const DEFAULT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

function compareIds (left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareAppIdsByName (left, right, {
  getAppName = () => '',
  collator = DEFAULT_COLLATOR
} = {}) {
  const leftName = String(getAppName(left) ?? '').trim()
  const rightName = String(getAppName(right) ?? '').trim()

  if (leftName && !rightName) return -1
  if (!leftName && rightName) return 1
  if (leftName && rightName) {
    const byName = collator.compare(leftName, rightName)
    if (byName) return byName
  }
  return compareIds(left, right)
}

export function sortAppIdsByName (appIds, options) {
  return [...new Set(appIds)].sort((left, right) => compareAppIdsByName(left, right, options))
}
