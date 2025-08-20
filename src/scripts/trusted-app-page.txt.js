import { initMessageListener, tellParentImReady } from '#helpers/window-message/trusted-app-page/index.js'

// ERROR: Top-level await is currently not supported with the "iife" output format [plugin js-text]
// https://github.com/evanw/esbuild/issues/253
(async () => {
  initMessageListener()
  await tellParentImReady()
})()
