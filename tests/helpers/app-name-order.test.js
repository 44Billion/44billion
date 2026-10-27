import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareAppIdsByName, sortAppIdsByName } from '#helpers/app-name-order.js'

describe('app name ordering', () => {
  const names = {
    zeta: 'Zeta',
    alpha: 'alpha',
    beta: 'Beta',
    unknown: ''
  }
  const getAppName = appId => names[appId]
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

  it('sorts case-insensitively, including numeric names', () => {
    assert.deepEqual(sortAppIdsByName(['zeta', 'app-10', 'alpha', 'app-2'], {
      getAppName: appId => names[appId] ?? (appId.startsWith('app-') ? appId.toUpperCase() : ''),
      collator
    }), ['alpha', 'app-2', 'app-10', 'zeta'])
  })

  it('places unknown names after named apps and uses the id as a stable tiebreaker', () => {
    assert.ok(compareAppIdsByName('alpha', 'unknown', { getAppName, collator }) < 0)
    assert.ok(compareAppIdsByName('beta', 'alpha', { getAppName, collator }) > 0)
    assert.ok(compareAppIdsByName('zeta', 'zeta-copy', {
      getAppName: () => 'Same name',
      collator
    }) < 0)
    assert.deepEqual(sortAppIdsByName(['unknown', 'beta', 'alpha', 'alpha'], {
      getAppName,
      collator
    }), ['alpha', 'beta', 'unknown'])
  })
})
