import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  cancelNostrDbWrites,
  clearNostrDbWriteSchedulers,
  nostrDbWriteSchedulerSnapshot,
  scheduleNostrDbWrite
} from '../../src/services/idb/nostrdb/write-scheduler.js'

const owner = 'a'.repeat(64)

afterEach(() => {
  cancelNostrDbWrites(owner)
  clearNostrDbWriteSchedulers()
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
  assert.deepEqual(nostrDbWriteSchedulerSnapshot(owner), { active: 1, waiting: 1 })

  release.resolve()
  await Promise.all([events, waiting])
  assert.deepEqual(started, ['events', 'coverage', 'waiting'])
  assert.deepEqual(nostrDbWriteSchedulerSnapshot(owner), { active: 0, waiting: 0 })
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
  assert.deepEqual(nostrDbWriteSchedulerSnapshot(owner), { active: 1, waiting: 0 })

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
