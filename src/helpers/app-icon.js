// Accepts only self-contained images and absolute HTTP(S) icon URLs.
export function isRenderableAppIconUrl (value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /\s/.test(value)
  ) return false

  if (/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value)) return true

  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch (_) {
    return false
  }
}

// Normalizes current and legacy cached icon shapes into an ordered URL list.
export function normalizeAppIconCandidates (icon) {
  if (!icon || typeof icon !== 'object') return []
  const candidates = [icon, ...(Array.isArray(icon.candidates) ? icon.candidates : [])]
  const seenUrls = new Set()
  return candidates.flatMap(candidate => {
    if (!candidate || !isRenderableAppIconUrl(candidate.url)) return []
    const url = candidate.url
    if (seenUrls.has(url)) return []
    seenUrls.add(url)
    return [{ fx: typeof candidate.fx === 'string' ? candidate.fx : null, url }]
  })
}

// Keeps a confirmed image selected while refreshed candidates still represent it.
export function reconcileAppIconCandidates (candidates, displayedIcon, rejectedUrls) {
  const index = candidates.findIndex(candidate => !rejectedUrls.has(candidate.url))
  if (!displayedIcon || rejectedUrls.has(displayedIcon.url)) {
    return { candidates, index: index < 0 ? candidates.length : index }
  }

  const exactIndex = candidates.findIndex(candidate => candidate.url === displayedIcon.url)
  if (exactIndex >= 0) return { candidates, index: exactIndex }

  if (displayedIcon.fx && candidates.some(candidate => candidate.fx === displayedIcon.fx)) {
    return { candidates: [displayedIcon, ...candidates], index: 0 }
  }

  return { candidates, index: index < 0 ? candidates.length : index }
}

// Describes the two image layers without hiding a confirmed image during preload.
export function getAppIconLayerState (displayedIcon, candidateIcon) {
  const hasDisplayedIcon = !!displayedIcon
  const isCandidateDisplayed = displayedIcon?.url === candidateIcon?.url
  return {
    isShimmerVisible: !hasDisplayedIcon,
    isDisplayedLayerVisible: hasDisplayedIcon && !isCandidateDisplayed,
    isCandidateLayerVisible: isCandidateDisplayed
  }
}

// Shows the initial placeholder only while icon resolution is still active.
export function shouldShowAppIconShimmer ({
  resolutionPending,
  isLoading,
  candidateIcon,
  displayedIcon
}) {
  return (resolutionPending || isLoading) && !candidateIcon && !displayedIcon
}
