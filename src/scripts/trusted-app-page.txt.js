import { initMessageListener, tellParentImReady } from '#helpers/window-message/trusted-app-page/index.js'
import { checkForSwUpdatesFrequently, triggerReloadOnSwSkipWaiting } from '#helpers/service-worker.js'

checkForSwUpdatesFrequently()
triggerReloadOnSwSkipWaiting()
initMessageListener()
tellParentImReady()
