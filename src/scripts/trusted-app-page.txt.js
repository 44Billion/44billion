import { initMessageListener, tellSwImReady, tellParentImReady } from '#helpers/window-message/trusted-app-page/index.js'
import { waitUntilSwIsActive, checkForSwUpdatesFrequently, triggerReloadOnSwSkipWaiting } from '#helpers/service-worker.js'

// ERROR: Top-level await is currently not supported with the "iife" output format [plugin js-text]
// https://github.com/evanw/esbuild/issues/253
(async () => {
  initMessageListener()
  await waitUntilSwIsActive()
  triggerReloadOnSwSkipWaiting()
  checkForSwUpdatesFrequently()
  tellSwImReady()
  tellParentImReady()
})()
