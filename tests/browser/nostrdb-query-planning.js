// Native IDB: already-selective startup reads, paginated history and writes.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { launchChrome } from './runtime/chrome.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const plannerSource = process.argv.find(arg => arg.startsWith('--planner-source='))?.slice('--planner-source='.length)
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { IS_DEVELOPMENT: 'true', IS_PRODUCTION: 'false' },
  entryPoints: ['tests/browser/fixtures/nostrdb-query-planning.js'],
  plugins: plannerSource
    ? [{
        name: 'comparison-planner', setup (builder) {
          builder.onLoad({ filter: /services\/idb\/nostrdb\/query-plan\.js$/ }, async () => ({ contents: await readFile(plannerSource, 'utf8'), loader: 'js' }))
        }
      }]
    : []
})
const origin = 'http://localhost:10000'
const browser = await launchChrome({
  intercept: request => request.url.startsWith(origin + '/__tests__/bounded-planner')
    ? { responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(`<script type="module">${bundle.outputFiles[0].text}</script>`).toString('base64') }
    : false
})
const rows = []
try {
  await browser.navigate(origin + '/__tests__/bounded-planner')
  await browser.until(() => browser.evaluate('!!globalThis.plannerFixture', origin), 'planner fixture ready')
  await browser.evaluate('plannerFixture.seed()', origin)
  if (!plannerSource) {
    const recovery = await browser.evaluate('plannerFixture.recoveryPage()', origin)
    assert.equal(recovery.resultCount, 128)
    assert.equal(recovery.probes, 2)
    assert.equal(recovery.plan.recoveryPlan, true)
    assert.equal(recovery.plan.recoveryPath, 'o')
    assert.equal(recovery.plan.keysExamined <= 130, true)
    console.log('RECOVERY-PLAN', JSON.stringify(recovery))
  }
  for (const history of [false, true]) {
    if (history) await browser.evaluate('plannerFixture.seedHistory()', origin)
    for (const n of history ? [100] : [1, 25, 100]) {
      for (let sample = 0; sample < 5; sample++) {
        const row = await browser.evaluate(`plannerFixture.burst(${n}, ${history})`, origin)
        rows.push(row)
        console.log('PLANNER-BURST', JSON.stringify(row))
        if (!plannerSource) {
          assert.equal(row.countCalls, 0)
          assert.ok(row.maxProbeLimit <= 65)
          assert.ok(row.maxPlanningKeys <= 256)
          assert.equal(row.readPlans, n)
          assert.equal(row.earlyReadPlans, n)
        }
      }
    }
  }
  if (output) await writeFile(output, JSON.stringify({ comparison: !!plannerSource, samplesPerCase: 5, rows }, null, 2))
  console.log('Selective queries, history pages and concurrent three-account maintenance passed')
} finally { await browser.close() }
