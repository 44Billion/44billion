// Real IndexedDB/Web Locks, bounded profile bursts and auxiliary-history load.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { launchChrome } from './runtime/chrome.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const baselinePath = process.argv.find(value => value.startsWith('--baseline-index='))?.slice('--baseline-index='.length)
const plannerPath = process.argv.find(value => value.startsWith('--planner-source='))?.slice('--planner-source='.length)
const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { IS_DEVELOPMENT: 'true', IS_PRODUCTION: 'false' },
  entryPoints: ['tests/browser/fixtures/nostrdb-contention.js'],
  plugins: baselinePath || plannerPath
    ? [{
        name: 'comparison-source', setup (builder) {
          if (baselinePath) builder.onLoad({ filter: /services\/idb\/nostrdb\/index\.js$/ }, async () => ({ contents: await readFile(baselinePath, 'utf8'), loader: 'js' }))
          if (plannerPath) builder.onLoad({ filter: /services\/idb\/nostrdb\/query-plan\.js$/ }, async () => ({ contents: await readFile(plannerPath, 'utf8'), loader: 'js' }))
        }
      }]
    : []
})
const origin = 'http://localhost:10000'
const browser = await launchChrome({
  intercept: request => request.url.startsWith(origin + '/__tests__/contention')
    ? { responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(`<script type="module">${bundle.outputFiles[0].text}</script>`).toString('base64') }
    : false
})
const rows = []
try {
  await browser.navigate(origin + '/__tests__/contention')
  await browser.until(() => browser.evaluate('!!globalThis.fixture', origin), 'fixture ready')
  await browser.evaluate('fixture.seed()', origin)
  for (let sample = 0; sample < 7; sample++) {
    const row = await browser.evaluate('fixture.round()', origin)
    rows.push(row)
    console.log('NOSTRDB-CONTENTION', JSON.stringify(row))
    if (!baselinePath) { assert.equal(row.duplicateReads, 104); assert.ok(row.materialized < 100, 'unrelated auxiliary wrappers must not be materialized') }
  }
  // A second document has its own JS caches and shares native quota locking.
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const second = await browser.until(() => [...browser.contexts.values()].find(context => context.auxData?.frameId === targetId && context.auxData?.isDefault), 'second context')
  await browser.send('Page.navigate', { url: origin + '/__tests__/contention/two' }, second.sessionId)
  const evaluateSecond = async expression => {
    const result = await browser.send('Runtime.evaluate', { expression, contextId: second.id, awaitPromise: true, returnByValue: true }, second.sessionId)
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const secondContext = await browser.until(() => [...browser.contexts.values()].find(context => context.sessionId === second.sessionId && context.origin === origin && context.auxData?.isDefault), 'second navigated')
  Object.assign(second, secondContext)
  await browser.until(() => evaluateSecond('!!globalThis.fixture'), 'second fixture ready')
  const [firstCopy, secondCopy] = await Promise.all([browser.evaluate('fixture.prepareRace()', origin), evaluateSecond('fixture.prepareRace()')])
  const results = await Promise.all([browser.evaluate('fixture.race()', origin), evaluateSecond('fixture.race()')])
  assert.ok(results.every(result => result.ok))
  const winner = await browser.evaluate(`fixture.preferred('${firstCopy.id}','${secondCopy.id}')`, origin)
  assert.deepEqual(await evaluateSecond('fixture.raceWinner()'), [winner])
  if (!baselinePath) {
    await browser.evaluate('void navigator.locks.request(fixture.QUOTA_LOCK, () => new Promise(resolve => { globalThis.releaseQuota = resolve }))', origin)
    await browser.until(() => browser.evaluate('!!globalThis.releaseQuota', origin), 'quota lock held')
    try { assert.equal((await evaluateSecond('fixture.duplicate()')).code, 'duplicate') } finally { await browser.evaluate('releaseQuota()', origin) }
  }
  const summary = values => {
    const sorted = [...values].sort((a, b) => a - b)
    return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
  }
  const result = { baseline: !!baselinePath, comparisonPlanner: !!plannerPath, samples: rows.length, foregroundMs: summary(rows.map(row => row.foregroundMs)), foregroundQuotaWaitMs: summary(rows.map(row => row.foregroundQuotaWaitMs)), foregroundQuotaHeldMs: summary(rows.map(row => row.foregroundQuotaHeldMs)), quotaWaitMs: summary(rows.flatMap(row => row.quotaWaitMs)), quotaHeldMs: summary(rows.flatMap(row => row.quotaHeldMs)), planningMs: summary(rows.map(row => row.planningMs)), rows }
  if (output) await writeFile(output, JSON.stringify(result, null, 2))
  console.log('NOSTRDB-CONTENTION-SUMMARY', JSON.stringify({ ...result, rows: undefined }))
  console.log('Native contention and concurrent provenance checks passed')
} finally { await browser.close() }
