export const frameKey = (sessionId, frameId) => `${sessionId}:${frameId}`

export function contextForOrigin (contexts, frames, origin) {
  return [...contexts.values()].find(context => {
    if (context.origin !== origin || !context.auxData?.isDefault) return false
    const location = frames.get(frameKey(context.sessionId, context.auxData.frameId))
    if (!location) return false
    try {
      const url = new URL(location)
      return url.origin === origin && !url.pathname.startsWith('/~~')
    } catch { return false }
  })
}
