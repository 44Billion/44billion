// Copies text with the modern Clipboard API when available, falling back to
// the legacy hidden-textarea + execCommand path for non-secure or older
// browser contexts.
export async function copyTextToClipboard (text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch (_) {}
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Copy failed')
}
