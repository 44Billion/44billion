import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_BUDGET_BACKGROUND_DENIED,
  ASSET_BUDGET_STEP_BYTES,
  ensureCanStoreAppAssetBytes,
  formatAssetBudgetBytes,
  normalizeAssetBudgetState,
  readAssetBudgetState,
  rebuildAssetBudgetFromChunks,
  writeAssetBudgetState
} from '../../src/services/app-asset-budget/index.js'

function storageFromEntries (entries = {}) {
  const data = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
  return {
    getItem: key => data.get(String(key)) ?? null,
    removeItem: key => { data.delete(String(key)) },
    setItem: (key, value) => { data.set(String(key), String(value)) }
  }
}

describe('app asset budget', () => {
  it('keeps normal reads from auto-approving bytes over the current step', () => {
    const state = normalizeAssetBudgetState({
      cachedBytes: ASSET_BUDGET_STEP_BYTES + 1,
      approvedBytes: ASSET_BUDGET_STEP_BYTES
    })

    assert.equal(state.approvedBytes, ASSET_BUDGET_STEP_BYTES)
  })

  it('approves existing cached bytes when rebuilding the ledger', async () => {
    const storage = storageFromEntries()
    async function * streamChunks () {
      yield { b: ASSET_BUDGET_STEP_BYTES + 1 }
    }

    const state = await rebuildAssetBudgetFromChunks({
      _localStorage: storage,
      _streamAllFileChunks: streamChunks,
      _now: () => 123
    })

    assert.equal(state.cachedBytes, ASSET_BUDGET_STEP_BYTES + 1)
    assert.equal(state.approvedBytes, ASSET_BUDGET_STEP_BYTES * 2)
    assert.equal(state.rebuiltAt, 123)
  })

  it('prompts and raises the approved step for foreground writes', async () => {
    const storage = storageFromEntries()
    writeAssetBudgetState({
      cachedBytes: ASSET_BUDGET_STEP_BYTES,
      approvedBytes: ASSET_BUDGET_STEP_BYTES
    }, { _localStorage: storage })

    let prompt
    await ensureCanStoreAppAssetBytes(1, {
      _localStorage: storage,
      requestConfirmation: async details => { prompt = details }
    })

    assert.equal(prompt.nextApprovedBytes, ASSET_BUDGET_STEP_BYTES * 2)
    assert.equal(readAssetBudgetState({ _localStorage: storage }).approvedBytes, ASSET_BUDGET_STEP_BYTES * 2)
  })

  it('rejects background writes instead of prompting', async () => {
    const storage = storageFromEntries()
    writeAssetBudgetState({
      cachedBytes: ASSET_BUDGET_STEP_BYTES,
      approvedBytes: ASSET_BUDGET_STEP_BYTES
    }, { _localStorage: storage })

    await assert.rejects(
      ensureCanStoreAppAssetBytes(1, { _localStorage: storage, mode: 'background' }),
      err => err.code === ASSET_BUDGET_BACKGROUND_DENIED
    )
  })

  it('does not double-count old and new versions during replacement checks', async () => {
    const storage = storageFromEntries()
    writeAssetBudgetState({
      cachedBytes: ASSET_BUDGET_STEP_BYTES + 100,
      approvedBytes: ASSET_BUDGET_STEP_BYTES * 2
    }, { _localStorage: storage })

    let didPrompt = false
    await ensureCanStoreAppAssetBytes(ASSET_BUDGET_STEP_BYTES - 200, {
      _localStorage: storage,
      mode: 'autoUpdate',
      replacement: {
        oldBytes: ASSET_BUDGET_STEP_BYTES + 100,
        newBytes: 0
      },
      requestConfirmation: async () => { didPrompt = true }
    })

    assert.equal(didPrompt, false)
  })

  it('prompts when a replacement version crosses the next approved step', async () => {
    const storage = storageFromEntries()
    writeAssetBudgetState({
      cachedBytes: (ASSET_BUDGET_STEP_BYTES * 3),
      approvedBytes: ASSET_BUDGET_STEP_BYTES * 2
    }, { _localStorage: storage })

    let prompt
    await ensureCanStoreAppAssetBytes(200, {
      _localStorage: storage,
      mode: 'autoUpdate',
      replacement: {
        oldBytes: ASSET_BUDGET_STEP_BYTES + 100,
        newBytes: (ASSET_BUDGET_STEP_BYTES * 2) - 100
      },
      requestConfirmation: async details => { prompt = details }
    })

    assert.equal(prompt.nextApprovedBytes, ASSET_BUDGET_STEP_BYTES * 3)
  })

  it('formats whole and fractional GB values', () => {
    assert.equal(formatAssetBudgetBytes(ASSET_BUDGET_STEP_BYTES * 2), '6 GB')
    assert.equal(formatAssetBudgetBytes(ASSET_BUDGET_STEP_BYTES / 2), '1.5 GB')
  })
})
