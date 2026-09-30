import { writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { finalizeEvent } from 'libp2r2p/event'
import { generateSecretKey } from 'libp2r2p/key'
import { createBridgeTransport } from '../src/services/relay-pool/app-shim.js'
import { createRelayBridgeEndpoint } from '../src/services/relay-pool/bridge-endpoint.js'
import { RELAY_POOL_LIMITS } from '../src/services/relay-pool/constants.js'
import { UnifiedRelayPool } from '../src/services/relay-pool/pool.js'
import { RelayRegistry } from '../src/services/relay-pool/registry.js'
import { createRelayPoolWebSocketClass } from '../src/services/relay-pool/virtual-socket.js'

const { values } = parseArgs({
  options: {
    publish: { type: 'boolean', default: false },
    relay: { type: 'string', default: 'wss://relay.44billion.net' },
    samples: { type: 'string', default: '4' },
    timeout: { type: 'string', default: '30000' },
    output: { type: 'string', default: '/tmp/relay-publication-diagnostic.json' }
  }
})
if (!values.publish) {
  console.log('Live diagnostic: node bin/diagnose-relay-publication.js --publish [--relay wss://...] [--samples 4] [--timeout 30000] [--output /tmp/report.json]')
  console.log('Publishes 4 events per sample: direct/pooled, kinds 3560/20000, disposable key, 10-minute expiration. No real account is used.')
  process.exit(0)
}
const samples = Number(values.samples)
const timeoutMs = Number(values.timeout)
if (!Number.isInteger(samples) || samples < 1 || samples > 20) throw new Error('samples must be 1..20')
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('timeout must be 1000..60000')
const relay = new URL(values.relay).href
if (!['ws:', 'wss:'].includes(new URL(relay).protocol)) throw new Error('relay must use ws:// or wss://')
const report = { startedAt: new Date().toISOString(), relay, runtime: process.version, samples, timeoutMs, observations: [], connections: [], logs: [] }
const measurements = new Map()
const physicalSockets = []
const virtualSockets = []
const now = () => performance.now()
const rounded = value => value === undefined ? null : Math.round(value * 100) / 100
const key = generateSecretKey()
const registry = new RelayRegistry([relay])

function physicalSocket (url, path) {
  const started = now()
  const socket = new WebSocket(url)
  physicalSockets.push(socket)
  socket.addEventListener('open', () => report.connections.push({ path, openMs: rounded(now() - started) }))
  socket.addEventListener('close', event => report.logs.push({ type: 'close', path, code: event.code, reason: event.reason }))
  const send = socket.send.bind(socket)
  socket.send = raw => {
    const frame = JSON.parse(raw)
    if (frame[0] === 'EVENT') {
      const measurement = measurements.get(frame[1].id)
      if (measurement) measurement.sentAt = now()
    }
    send(raw)
  }
  // Registered before pool handlers, so this measures physical reception.
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data)
    if (frame[0] === 'OK') {
      const measurement = measurements.get(frame[1])
      if (measurement) {
        measurement.wireOkAt = now()
        measurement.physicalAccepted = frame[2]
      }
    } else if (frame[0] === 'NOTICE') report.logs.push({ type: 'notice', path, frame })
  })
  return socket
}

const pool = new UnifiedRelayPool({ registry, createSocket: url => physicalSocket(url, 'pooled'), log: (...args) => report.logs.push(args) })
const { port1, port2 } = new MessageChannel()
const endpoint = createRelayBridgeEndpoint({ port: port2, pool })
class NoDirectFallback extends WebSocket {
  constructor () { throw new Error('Unexpected direct fallback: pooled measurements would be invalid') }
}
const PooledWebSocket = createRelayPoolWebSocketClass({
  OriginalWebSocket: NoDirectFallback, registry, baseUrl: 'https://app.example/',
  log: (...args) => report.logs.push(args),
  createPoolTransport: ({ url, callbacks }) => createBridgeTransport({ url, callbacks, getPort: async () => port1, limits: RELAY_POOL_LIMITS })
})

function opened (socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onError)
    }
    const onOpen = () => { cleanup(); resolve(socket) }
    const onError = () => { cleanup(); reject(new Error('WebSocket failed before opening')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket open timeout')) }, timeoutMs)
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onError)
  })
}

async function publish (socket, path, kind, round) {
  const createdAt = Math.floor(Date.now() / 1000)
  const event = finalizeEvent({
    kind, created_at: createdAt,
    tags: [['expiration', String(createdAt + 600)]],
    content: `relay latency diagnostic ${randomBytes(96).toString('base64')}`
  }, key)
  const measurement = { path, kind, round, eventId: event.id, startedAt: now(), at: new Date().toISOString() }
  measurements.set(event.id, measurement)
  await new Promise(resolve => {
    const finish = (status, frame) => {
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      measurement.finishedAt = now()
      measurement.status = status
      if (frame) { measurement.accepted = frame[2]; measurement.reason = frame[3] }
      resolve()
    }
    const onMessage = ({ data }) => {
      const frame = JSON.parse(data)
      if (frame[0] === 'OK' && frame[1] === event.id) finish('ok', frame)
    }
    const onClose = () => finish('closed')
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    if (socket.readyState !== 1) return finish('closed')
    try { socket.send(JSON.stringify(['EVENT', event])) } catch (error) {
      measurement.error = error.message
      finish('send-error')
    }
  })
  const result = {
    path, kind, round, eventId: event.id, at: measurement.at,
    status: measurement.status, accepted: measurement.accepted, reason: measurement.reason,
    totalMs: rounded(measurement.finishedAt - measurement.startedAt),
    queueMs: rounded(measurement.sentAt === undefined ? undefined : measurement.sentAt - measurement.startedAt),
    responseMs: rounded(measurement.wireOkAt === undefined ? undefined : measurement.wireOkAt - measurement.sentAt),
    dispatchMs: rounded(measurement.wireOkAt === undefined ? undefined : measurement.finishedAt - measurement.wireOkAt)
  }
  if (result.status === 'ok' && (result.queueMs === null || result.responseMs === null)) throw new Error('Missing physical socket measurements')
  report.observations.push(result)
  console.log(JSON.stringify(result))
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n')
  return result
}

try {
  const direct = await opened(physicalSocket(relay, 'direct'))
  await delay(1100)
  const a = new PooledWebSocket(relay)
  virtualSockets.push(a)
  await opened(a)
  const b = new PooledWebSocket(relay)
  virtualSockets.push(b)
  await opened(b)
  if (pool.snapshot().members !== 2 || pool.snapshot().physicalOpened !== 1) throw new Error('Expected two pool members sharing one physical connection')
  for (let round = 0; round < samples; round++) {
    // Alternate ordering and use distinct IDs: duplicate-event shortcuts would bias results.
    const paths = round % 2 ? ['pooled', 'direct'] : ['direct', 'pooled']
    const kinds = round % 2 ? [20000, 3560] : [3560, 20000]
    for (const kind of kinds) {
      for (const path of paths) {
        const result = await publish(path === 'direct' ? direct : virtualSockets[round % 2], path, kind, round)
        if (result.status === 'closed' || result.status === 'send-error') throw new Error(`Publication transport failed: ${result.status}`)
        await delay(500)
      }
    }
  }
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
} finally {
  report.pool = pool.snapshot()
  report.finishedAt = new Date().toISOString()
  report.summary = []
  for (const path of ['direct', 'pooled']) {
    for (const kind of [3560, 20000]) {
      const rows = report.observations.filter(row => row.path === path && row.kind === kind)
      const accepted = rows.filter(row => row.accepted === true)
      const times = accepted.map(row => row.totalMs).sort((a, b) => a - b)
      report.summary.push({
        path, kind, count: rows.length, accepted: accepted.length,
        timeouts: rows.filter(row => row.status === 'timeout').length,
        minMs: times[0] ?? null, medianMs: times.length ? rounded((times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2) : null,
        maxMs: times.at(-1) ?? null
      })
    }
  }
  endpoint.dispose()
  pool.closeAll()
  for (const socket of virtualSockets) socket.close()
  for (const socket of physicalSockets) socket.close()
  port1.close()
  port2.close()
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output: values.output, summary: report.summary, error: report.error }, null, 2))
}
