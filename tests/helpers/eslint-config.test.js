import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../', import.meta.url)) })

test('repository lint excludes gitignored files globally, including HTML history', async () => {
  for (const path of [
    '.history/src/old.html', 'src/.history/old.js', 'node_modules/example/index.js',
    'todo/notes.js', 'dist/44billion/app.js', 'tmp/fixture.js'
  ]) assert.equal(await eslint.isPathIgnored(path), true, path)
  for (const path of ['src/services/idb/nostrdb/query-plan.js', 'src/assets/html/app-page-loader.txt.html', 'tests/helpers/theme.test.js']) {
    assert.equal(await eslint.isPathIgnored(path), false, path)
  }
})

test('tracked HTML inline scripts still run through the ESLint rules', async () => {
  const [result] = await eslint.lintText('<script>unknownLoaderFunction()</script>', { filePath: 'src/assets/html/lint-fixture.html' })
  assert.equal(result.fatalErrorCount, 0)
  assert.ok(result.messages.some(message => message.ruleId === 'no-undef' && message.message.includes('unknownLoaderFunction')))
})
