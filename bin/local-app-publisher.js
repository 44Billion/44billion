import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launcherRoot, launcherUrl } from './dev-runtime.js'
import { localIdentity, prepareLocalApp } from './local-app.js'

// Reports arrive through the same local server on desktop and forwarded Android.
export async function createLocalPublisher (projectRoot, { signal, identifier = 'zillion', name = 'Zillion', log = console.log } = {}) {
  const secret = await localIdentity(projectRoot)
  const { token } = JSON.parse(await readFile(path.join(launcherRoot, 'tmp/local-dev-session.json'), 'utf8'))
  const owner = randomUUID()
  let project
  const reports = (async () => {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${launcherUrl}/__dev/apps/events`, { signal })
        if (!response.ok) throw new Error('Local event stream unavailable')
        let buffer = ''
        for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += text
          let index
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index); buffer = buffer.slice(index + 2)
            if (!block.startsWith('event: report\n')) continue
            const report = JSON.parse(block.slice(block.indexOf('data: ') + 6))
            if (report.project === project) log(`[local app] ${report.message}`)
          }
        }
      } catch (error) { if (!signal.aborted) log(`Local reports: ${error.message}`) }
      if (!signal.aborted) await delay(1000, undefined, { signal }).catch(() => {})
    }
  })()
  return {
    async publish (files) {
      const build = prepareLocalApp(files, { secret, identifier, name })
      project = build.project
      const response = await fetch(`${launcherUrl}/__dev/apps/register`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-local-owner': owner, 'content-type': 'application/json' }, body: JSON.stringify(build), signal
      })
      if (!response.ok) throw new Error(`Local registration failed: ${await response.text()}`)
      log(`Local preview: ${launcherUrl}/?local-dev=${encodeURIComponent(project)}`)
      log(`Build ${build.revision.slice(0, 12)} ready; open the link once in each browser.`)
    },
    async close () {
      await reports
      if (project) {
        await fetch(`${launcherUrl}/__dev/apps/unregister`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-local-owner': owner, 'content-type': 'application/json' },
          body: JSON.stringify({ project }), signal: AbortSignal.timeout(2000)
        }).catch(() => {})
      }
    }
  }
}
