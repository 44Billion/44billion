import { useTask } from '#f'
import { syncThrottle } from '#helpers/function.js'

let stateByContainerMap
// TODO: accessibility - watch Enter(?) press and check focused element
export default function useLongPress (container$, node$) {
  useTask(({ cleanup }) => {
    const container = container$()
    const node = node$?.() ?? container
    if (!container) throw new Error('useLongPress called without a container ref')

    if (!stateByContainerMap) stateByContainerMap = new Map()
    if (!stateByContainerMap.has(container)) {
      const abortController = new AbortController()
      const { signal } = abortController
      const watchedNodesSet = new Set()
      stateByContainerMap.set(container, {
        abortController,
        watchedNodesSet
      })

      let shouldPause = false
      let matchingNode
      let timeout
      let hasTriggeredLongPress = false
      const longPressDelay = 600 // ms
      const pointerIdSet = new Set()
      const throttledMiddleListener = syncThrottle(middleListener, 150)

      function startListener (e) {
        // https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Multi-touch_interaction
        // e.pointerId is useful on multi-touch scenarios
        pointerIdSet.add(e.pointerId)
        // set e.shouldStopPropagation = true instead of e.stopPropagation()
        // if another listener somewhere else has already handled the event
        // because e.stopPropagation() wouldn't let telemetry listening for events on window work
        if (pointerIdSet.size > 1 || e.shouldStopPropagation) shouldPause = true
        if (shouldPause) return

        matchingNode = (() => {
          for (const watchedNode of watchedNodesSet) {
            if (watchedNode.contains(e.target)) return watchedNode
          }
        })()
        if (!matchingNode) return

        window.addEventListener('pointermove', throttledMiddleListener, { signal })
        window.addEventListener('pointerup', endListener, { signal })

        timeout = setTimeout(() => {
          hasTriggeredLongPress = true
          window.removeEventListener('pointermove', throttledMiddleListener, { signal })
          const event = new CustomEvent('custom:longpress', {
            bubbles: false,
            cancelable: false,
            composed: false
          })
          matchingNode.dispatchEvent(event)
        }, longPressDelay)
      }

      function middleListener (e) {
        if (shouldPause) {
          window.removeEventListener('pointermove', throttledMiddleListener, { signal })
          return
        }

        if (isOutsideExpandedBoundingBox(e, matchingNode)) {
          window.removeEventListener('pointermove', throttledMiddleListener, { signal })
          clearTimeout(timeout)
        }
      }

      function endListener (e) {
        pointerIdSet.delete(e.pointerId)
        if (pointerIdSet.size > 0) return

        window.removeEventListener('pointermove', throttledMiddleListener, { signal })
        clearTimeout(timeout)
      }

      function isOutsideExpandedBoundingBox (e, node) {
        const margin = 20 // pixels around the element
        const nodeRect = node.getBoundingClientRect()
        if (!(function isWithinX () { return e.clientX >= (nodeRect.left - margin) && e.clientX <= (nodeRect.right + margin) })()) return true
        if (!(function isWithinY () { return e.clientY >= (nodeRect.top - margin) && e.clientY <= (nodeRect.bottom + margin) })()) return true
        return false
      }

      container.addEventListener('pointerdown', startListener, { signal })
      container.addEventListener('click', function maybeCancelClick (e) {
        if (!hasTriggeredLongPress) return

        hasTriggeredLongPress = false
        if (matchingNode) e.shouldStopPropagation = true
      }, { signal, capture: true /* ancestors first */ })
    }

    stateByContainerMap.get(container).watchedNodesSet.add(node)

    cleanup(() => {
      const state = stateByContainerMap.get(container)
      state.watchedNodesSet.delete(node)
      if (state.watchedNodesSet.size === 0) {
        state.abortController.abort()
        stateByContainerMap.delete(container)
        if (stateByContainerMap.size === 0) stateByContainerMap = undefined
      }
    })
  }, { after: 'rendering' })
}
