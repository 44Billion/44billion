import { NOSTRDB_ONE_SHOT_METHODS } from '../nostrdb-protocol.js'

export function nostrDbSignMethodForTemplate (event) {
  return event?.tags?.some(tag => Array.isArray(tag) && tag[0] === 'imkc')
    ? 'double_sign_event'
    : 'sign_event'
}

export function buildNostrDbAddOptions (options, { appId, signEvent }) {
  return {
    ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
    appId,
    mergeSource: 'local',
    signEvent
  }
}

export function createNostrDbSignEvent ({ askNip07, askVault, pubkey, app, isDefaultUser }) {
  return async event => {
    const resolvedApp = typeof app === 'function' ? await app() : app
    const { payload, error } = await askNip07(askVault, pubkey, {
      ns: [''],
      method: nostrDbSignMethodForTemplate(event),
      params: [event],
      context: 'nostrdb_merge'
    }, {
      app: resolvedApp,
      isDefaultUser
    })
    if (error) throw error
    return payload
  }
}

export async function runNostrDbMethod ({ db, method, params = [], appId, signEvent }) {
  if (!NOSTRDB_ONE_SHOT_METHODS.includes(method)) throw new Error(`Unknown nostrdb method ${method}`)
  const args = Array.isArray(params) ? params : []
  if (method === 'add') {
    const [event, options] = args
    return db.add(event, buildNostrDbAddOptions(options, { appId, signEvent }))
  }
  return db[method](...args)
}
