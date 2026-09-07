import { ensureRuntime } from './dev-runtime.js'

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
try {
  const runtime = await ensureRuntime({ signal: controller.signal })
  if (runtime.owned) await runtime.closed
  else console.log(`Reusing 44billion at ${runtime.url}`)
} catch (error) {
  if (!controller.signal.aborted) { console.error(error); process.exitCode = 1 }
}
