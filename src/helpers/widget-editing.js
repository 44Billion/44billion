// One owner for automatic reveal; manual reveal lives in a separate signal.
// Timer/menu state stays local to each mounted widget, with an injectable clock.
export function createWidgetEditing ({
  widgetKey, readReveal, writeReveal, onSelected, onMenu,
  duration = 4000, schedule = setTimeout, cancel = clearTimeout
}) {
  let timer = null
  let selected = false
  let menuOpen = false
  let gesturing = false
  const pause = () => {
    cancel(timer)
    timer = null
  }
  const setMenu = enabled => {
    menuOpen = enabled
    onMenu(enabled)
  }
  const deselect = () => {
    pause()
    gesturing = false
    selected = false
    onSelected(false)
    setMenu(false)
    if (readReveal()?.widgetKey === widgetKey) writeReveal(null)
  }
  const restart = () => {
    pause()
    if (selected && !menuOpen && !gesturing) timer = schedule(deselect, duration)
  }
  return {
    begin ({ wsKey, isPinned, isObstructed }) {
      // Transfer before publishing a new drag draft: the previous widget's
      // resulting deselection must not release this widget's reveal session.
      if (readReveal() || (isPinned && isObstructed)) writeReveal({ widgetKey, wsKey })
      gesturing = true
      pause()
      setMenu(false)
    },
    select () {
      gesturing = false
      selected = true
      onSelected(true)
      restart()
    },
    setMenuOpen (enabled) {
      setMenu(selected && enabled && !gesturing)
      restart()
    },
    pause () {
      gesturing = true
      pause()
    },
    deselect
  }
}
