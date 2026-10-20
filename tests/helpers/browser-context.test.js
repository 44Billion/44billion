import { it } from 'node:test'
import assert from 'node:assert/strict'
import { contextForOrigin, frameKey } from '../browser/runtime/contexts.js'

const origin = 'http://0.localhost:10000'
const context = (sessionId, frameId, extra = {}) => ({ sessionId, origin, auxData: { isDefault: true, frameId }, ...extra })

it('waits for frame metadata and excludes internal documents, isolated worlds and workers', () => {
  const unknown = context('missing', 'frame')
  const bridge = context('trusted', 'frame')
  const download = context('download', 'file')
  const isolated = context('isolated', 'app', { auxData: { isDefault: false, frameId: 'app' } })
  const worker = context('worker', undefined)
  const actual = context('page', 'app')
  const contexts = new Map([unknown, bridge, download, isolated, worker, actual].map(value => [value.sessionId, value]))
  const frames = new Map([
    [frameKey('trusted', 'frame'), origin + '/~~napp?bridge=example'],
    [frameKey('download', 'file'), origin + '/~~nfile/example']
  ])
  assert.equal(contextForOrigin(contexts, frames, origin), undefined)
  frames.set(frameKey('page', 'app'), origin + '/chat/user')
  assert.equal(contextForOrigin(contexts, frames, origin), actual)
})

it('an old target detach cannot remove metadata belonging to a replacement session with the same frame ID', () => {
  const old = context('old', 'shared-frame')
  const replacement = context('new', 'shared-frame')
  const contexts = new Map([['old', old], ['new', replacement]])
  const frames = new Map([
    [frameKey('old', 'shared-frame'), origin + '/~~napp'],
    [frameKey('new', 'shared-frame'), origin + '/chat/user']
  ])
  frames.delete(frameKey('old', 'shared-frame'))
  assert.equal(contextForOrigin(contexts, frames, origin), replacement)
})

it('checks the document origin and pathname rather than unrelated query text', () => {
  const actual = context('page', 'app')
  const contexts = new Map([['page', actual]])
  const frames = new Map([[frameKey('page', 'app'), 'http://localhost:10000/chat/user']])
  assert.equal(contextForOrigin(contexts, frames, origin), undefined)
  frames.set(frameKey('page', 'app'), origin + '/chat/user?reference=/~~napp')
  assert.equal(contextForOrigin(contexts, frames, origin), actual)
})
