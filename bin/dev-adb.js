import { pathToFileURL } from 'node:url'
import { ensureRuntime } from './dev-runtime.js'
import { startAdbSession } from './adb-session.js'

export { formatRemoteObject, shouldShowLevel, targetLabelForHost } from './adb-session.js'

// Keep ADB alive even when ensureRuntime reuses another process's launcher.
export async function runAdbDevelopment ({ signal, startRuntime = ensureRuntime, startSession = startAdbSession }) {
  const adb = await startSession({ signal })
  let runtime
  try {
    runtime = await startRuntime({ signal })
    console.log(`Android launcher: ${runtime.url}`)
    await Promise.race([
      runtime.closed,
      new Promise(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
    ])
  } finally {
    try { await runtime?.close() } finally { await adb.close() }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try { await runAdbDevelopment({ signal: controller.signal }) } catch (error) {
    if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1 }
  }
}
