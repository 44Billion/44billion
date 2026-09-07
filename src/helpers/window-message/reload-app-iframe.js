export function reloadAppIframe ({ appIframeRef$, appIframeSrc$, fallbackSrc }) {
  const currentSrc = appIframeSrc$()
  const src = currentSrc && currentSrc !== 'about:blank' ? currentSrc : fallbackSrc

  // App documents are cross-origin: accessing contentWindow.location.reload
  // throws SecurityError. Navigate the parent-owned iframe instead, retaining
  // its bridge marker. A same-value signal write would not reload the document.
  if (currentSrc === src) appIframeRef$()?.setAttribute('src', src)
  else appIframeSrc$(src)
}
