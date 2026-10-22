import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  beginNostrDbForegroundIntent,
  cancelNostrDbAccesses,
  clearNostrDbAccessSchedulers,
  nostrDbAccessSchedulerSnapshot,
  scheduleNostrDbRead,
  scheduleNostrDbWrite
} from '../../src/services/idb/nostrdb/access-scheduler.js'

const owner = 'a'.repeat(64)

afterEach(() => {
  cancelNostrDbAccesses(owner)
  clearNostrDbAccessSchedulers()
})

test('runs disjoint stores together while an intersecting transaction waits', async () => {
  const release = Promise.withResolvers()
  const started = []
  const events = scheduleNostrDbWrite({
    owner,
    stores: ['events', 'maintenance'],
    schedulerClass: 'foreground',
    appId: 'app-a'
  }, async () => {
    started.push('events')
    await release.promise
  })
  const waiting = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground',
    appId: 'app-b'
  }, async () => {
    started.push('waiting')
  })
  const coverage = scheduleNostrDbWrite({
    owner,
    stores: ['accountCoverage'],
    schedulerClass: 'maintenance'
  }, async () => {
    started.push('coverage')
  })

  await coverage
  await setImmediate()
  assert.deepEqual(started, ['events', 'coverage'])
  assert.deepEqual(nostrDbAccessSchedulerSnapshot(owner), { active: 1, waiting: 1 })

  release.resolve()
  await Promise.all([events, waiting])
  assert.deepEqual(started, ['events', 'coverage', 'waiting'])
  assert.deepEqual(nostrDbAccessSchedulerSnapshot(owner), { active: 0, waiting: 0 })
})

test('prioritizes foreground and round-robins applications within a class', async () => {
  const release = Promise.withResolvers()
  const started = []
  const blocker = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'normal',
    appId: 'blocker'
  }, async () => {
    await release.promise
  })
  const jobs = []
  for (const [appId, label, schedulerClass] of [
    ['app-a', 'a1', 'normal'],
    ['app-a', 'a2', 'normal'],
    ['app-b', 'b1', 'normal'],
    ['app-b', 'b2', 'normal'],
    ['app-c', 'foreground', 'foreground']
  ]) {
    jobs.push(scheduleNostrDbWrite({
      owner,
      stores: ['events'],
      schedulerClass,
      appId
    }, async () => {
      started.push(label)
    }))
  }

  release.resolve()
  await blocker
  await setImmediate()
  await setImmediate()
  assert.deepEqual(started.slice(0, 4), ['foreground', 'a1', 'b1', 'a2'])
  await Promise.all(jobs)
})

test('lower-priority work gets a bounded turn after foreground traffic', async () => {
  const release = Promise.withResolvers()
  const started = []
  const blocker = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'maintenance'
  }, async () => {
    await release.promise
  })
  const jobs = []
  for (const [label, schedulerClass] of [
    ['f1', 'foreground'],
    ['f2', 'foreground'],
    ['f3', 'foreground'],
    ['background', 'background']
  ]) {
    jobs.push(scheduleNostrDbWrite({
      owner,
      stores: ['events'],
      schedulerClass,
      appId: label
    }, async () => {
      started.push(label)
    }))
  }

  release.resolve()
  await blocker
  await setImmediate()
  await setImmediate()
  assert.deepEqual(started.slice(0, 2), ['f1', 'f2'])
  await setImmediate()
  await setImmediate()
  assert.equal(started.includes('background'), true)
  await Promise.all(jobs)
})

test('serializes background reads and lets a waiting foreground write run next', async () => {
  const release = Promise.withResolvers()
  const started = []
  const firstRead = scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    appId: 'recovery'
  }, async () => {
    started.push('read-1')
    await release.promise
  })
  const secondRead = scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    appId: 'recovery'
  }, async () => {
    started.push('read-2')
  })
  const write = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground',
    appId: 'chat'
  }, async () => {
    started.push('write')
  })

  await setImmediate()
  assert.deepEqual(started, ['read-1'])
  release.resolve()
  await Promise.all([firstRead, secondRead, write])
  assert.deepEqual(started, ['read-1', 'write', 'read-2'])
})

test('a foreground intent blocks conflicting reads without holding a transaction slot', async () => {
  const started = []
  const release = beginNostrDbForegroundIntent({
    owner,
    stores: ['events'],
    appId: 'chat'
  })
  const read = scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    appId: 'recovery'
  }, async () => {
    started.push('read')
  })
  const disjoint = scheduleNostrDbRead({
    owner,
    stores: ['quota'],
    schedulerClass: 'background',
    appId: 'quota'
  }, async () => {
    started.push('quota')
  })
  const write = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground',
    appId: 'chat'
  }, async () => {
    started.push('write')
  })

  await Promise.all([disjoint, write])
  assert.deepEqual(started, ['quota', 'write'])
  assert.deepEqual(nostrDbAccessSchedulerSnapshot(owner), { active: 0, waiting: 1 })

  release()
  await read
  assert.deepEqual(started, ['quota', 'write', 'read'])
})

test('preempts an active speculative read and retries it only after foreground finishes', async () => {
  const firstStarted = Promise.withResolvers()
  const attempts = []
  const read = scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    appId: 'recovery',
    preemptible: true
  }, async signal => {
    attempts.push('start')
    if (attempts.length === 1) {
      firstStarted.resolve()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    attempts.push('finish')
    return 'planned'
  })

  await firstStarted.promise
  const release = beginNostrDbForegroundIntent({ owner, stores: ['events'], appId: 'chat' })
  const write = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground',
    appId: 'chat'
  }, async () => {
    attempts.push('write')
  })
  await write
  await setImmediate()
  assert.deepEqual(attempts, ['start', 'write'])

  release()
  assert.equal(await read, 'planned')
  assert.deepEqual(attempts, ['start', 'write', 'start', 'finish'])
})

test('foreground intent does not abort non-preemptible reads already in flight', async () => {
  const started = Promise.withResolvers()
  const releaseRead = Promise.withResolvers()
  const order = []
  const read = scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    appId: 'recovery'
  }, async () => {
    order.push('read-start')
    started.resolve()
    await releaseRead.promise
    order.push('read-finish')
  })
  await started.promise

  const releaseIntent = beginNostrDbForegroundIntent({ owner, stores: ['events'] })
  const write = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground'
  }, async () => {
    order.push('write')
  })
  await setImmediate()
  assert.deepEqual(order, ['read-start'])

  releaseRead.resolve()
  await Promise.all([read, write])
  releaseIntent()
  assert.deepEqual(order, ['read-start', 'read-finish', 'write'])
})

test('external cancellation of a preemptible read is not retried', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers()
  const read = scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    signal: controller.signal,
    preemptible: true
  }, async signal => {
    started.resolve()
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  await started.promise
  controller.abort(new DOMException('caller cancelled', 'AbortError'))
  await assert.rejects(read, { name: 'AbortError' })
  assert.deepEqual(nostrDbAccessSchedulerSnapshot(owner), { active: 0, waiting: 0 })
})

test('ordinary storage failures from a preemptible read are not retried', async () => {
  let attempts = 0
  const failure = new Error('storage unavailable')
  await assert.rejects(scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    preemptible: true
  }, async () => {
    attempts++
    throw failure
  }), error => error === failure)
  assert.equal(attempts, 1)
  assert.deepEqual(nostrDbAccessSchedulerSnapshot(owner), { active: 0, waiting: 0 })
})

test('aborting a foreground intent releases its blocked recovery job', async () => {
  const controller = new AbortController()
  const started = []
  const release = beginNostrDbForegroundIntent({
    owner,
    stores: ['events'],
    signal: controller.signal
  })
  const read = scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    preemptible: true
  }, async () => {
    started.push('read')
  })
  await setImmediate()
  assert.deepEqual(started, [])

  controller.abort()
  await read
  release()
  assert.deepEqual(started, ['read'])
})

test('aborts queued work without opening it and survives operation failures', async () => {
  const release = Promise.withResolvers()
  const started = []
  const blocker = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground'
  }, async () => {
    await release.promise
  })
  const controller = new AbortController()
  const aborted = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground',
    signal: controller.signal
  }, async () => {
    started.push('aborted')
  })
  controller.abort()
  await assert.rejects(aborted, { name: 'AbortError' })
  assert.deepEqual(nostrDbAccessSchedulerSnapshot(owner), { active: 1, waiting: 0 })

  const failure = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground'
  }, async () => {
    throw new Error('controlled failure')
  })
  const next = scheduleNostrDbWrite({
    owner,
    stores: ['events'],
    schedulerClass: 'foreground'
  }, async () => {
    started.push('next')
  })
  release.resolve()
  await blocker
  await assert.rejects(failure, /controlled failure/)
  await next
  assert.deepEqual(started, ['next'])
})
