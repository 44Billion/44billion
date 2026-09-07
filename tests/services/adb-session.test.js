import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startAdbSession, socketCandidates } from '../../bin/adb-session.js'
import { runAdbDevelopment } from '../../bin/dev-adb.js'

function fakeAdb ({ reverse = [], failReverse } = {}) {
  const calls = []
  const mappings = { reverse: new Map(reverse), forward: new Map() }
  const run = args => {
    calls.push(args)
    if (args[0] === '-s') args = args.slice(2)
    const [type, option, local, remote] = args
    const ok = stdout => ({ status: 0, stdout: stdout || '' })
    if (type === 'get-state') return ok('device')
    if (type === 'get-serialno') return ok('phone-test')
    if (type === 'shell') return ok('mResumedActivity: com.android.chrome')
    if (option === '--list') return ok([...mappings[type]].map(([local, remote]) => `phone-test ${local} ${remote}`).join('\n'))
    if (option === '--remove') { mappings[type].delete(local); return ok() }
    assert.equal(option, '--no-rebind')
    if (type === 'reverse' && local === failReverse) return { status: 1, stderr: 'reverse failed' }
    const endpoint = local === 'tcp:0' ? 'tcp:45678' : local
    if (mappings[type].has(endpoint)) return { status: 1, stderr: 'cannot rebind' }
    mappings[type].set(endpoint, remote)
    return ok(local === 'tcp:0' ? '45678' : '')
  }
  return { calls, mappings, run }
}

const options = fake => ({ args: [], serial: '', cdpPort: '0', _runAdb: fake.run, _fetch: async () => ({ ok: true, json: async () => [] }), log: () => {} })
const flush = () => new Promise(resolve => setImmediate(resolve))

test('Android sessions forward only app-facing ports and release owned mappings', async () => {
  const fake = fakeAdb()
  const session = await startAdbSession(options(fake))
  assert.equal(session.serial, 'phone-test')
  assert.deepEqual([...fake.mappings.reverse], [['tcp:10000', 'tcp:10000'], ['tcp:4000', 'tcp:4000']])
  assert.ok(fake.calls.some(args => args.includes('tcp:0')))
  assert.ok(fake.calls.filter(args => args.includes('reverse') || args.includes('forward')).every(args => args[0] === '-s' && args[1] === 'phone-test'))
  await Promise.all([session.close(), session.close()])
  assert.equal(fake.mappings.reverse.size, 0)
  assert.equal(fake.mappings.forward.size, 0)
  assert.equal(fake.calls.filter(args => args.includes('--remove')).length, 3)
})

test('existing matching reverse mappings are reused and retained on shutdown', async () => {
  const fake = fakeAdb({ reverse: [['tcp:10000', 'tcp:10000']] })
  const session = await startAdbSession(options(fake))
  await session.close()
  assert.deepEqual([...fake.mappings.reverse], [['tcp:10000', 'tcp:10000']])
  assert.equal(fake.calls.some(args => args.includes('--remove') && args.includes('tcp:10000')), false)
})

test('a conflicting reverse mapping is preserved and partial setup is rolled back', async () => {
  const fake = fakeAdb({ reverse: [['tcp:4000', 'tcp:9999']] })
  await assert.rejects(startAdbSession(options(fake)), /already points to tcp:9999/)
  assert.deepEqual([...fake.mappings.reverse], [['tcp:4000', 'tcp:9999']])
})

test('a failed reverse command rolls back only mappings created by this session', async () => {
  const fake = fakeAdb({ reverse: [['tcp:7777', 'tcp:7777']], failReverse: 'tcp:4000' })
  await assert.rejects(startAdbSession(options(fake)), /reverse failed/)
  assert.deepEqual([...fake.mappings.reverse], [['tcp:7777', 'tcp:7777']])
})

test('abort stops polling and releases the session without removing replaced mappings', async () => {
  const fake = fakeAdb()
  const controller = new AbortController()
  const session = await startAdbSession({ ...options(fake), signal: controller.signal })
  fake.mappings.reverse.set('tcp:10000', 'tcp:9999')
  controller.abort()
  await session.close()
  assert.deepEqual([...fake.mappings.reverse], [['tcp:10000', 'tcp:9999']])
  assert.equal(fake.mappings.forward.size, 0)
})

test('invalid browser and missing/unauthorized devices fail before port setup', async () => {
  const fake = fakeAdb()
  await assert.rejects(startAdbSession({ ...options(fake), args: ['--browser=unknown'] }), /chrome or --browser=edge/)
  assert.deepEqual(fake.calls, [])
  await assert.rejects(startAdbSession({ ...options(fake), _runAdb: () => ({ error: { code: 'ENOENT' } }) }), /not found in PATH/)
  await assert.rejects(startAdbSession({ ...options(fake), _runAdb: () => ({ status: 1, stderr: 'device unauthorized' }) }), /unauthorized/)
})

test('browser preferences resolve to actual Chrome/Edge debugging socket names', () => {
  assert.deepEqual(socketCandidates('edge'), ['edge_devtools_remote', 'chrome_devtools_remote'])
  assert.deepEqual(socketCandidates('chrome'), ['chrome_devtools_remote', 'edge_devtools_remote'])
})

test('ADB development stays active when the launcher is reused', async () => {
  const controller = new AbortController()
  const closed = []
  const work = runAdbDevelopment({
    signal: controller.signal,
    startRuntime: async () => ({ url: 'http://localhost:10000', owned: false, closed: new Promise(() => {}), close: async () => closed.push('runtime') }),
    startSession: async () => ({ close: async () => closed.push('adb') })
  })
  await flush()
  assert.deepEqual(closed, [])
  controller.abort()
  await work
  assert.deepEqual(closed, ['runtime', 'adb'])
})

test('runtime startup failure also closes the ADB session', async () => {
  const closed = []
  await assert.rejects(runAdbDevelopment({
    signal: new AbortController().signal,
    startRuntime: async () => { throw new Error('Port conflict') },
    startSession: async () => ({ close: async () => closed.push('adb') })
  }), /Port conflict/)
  assert.deepEqual(closed, ['adb'])
})
