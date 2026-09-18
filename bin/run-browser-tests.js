import { spawn, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readRuntimeHealth } from './dev-runtime.js'

// Isolate the complete test process tree, including browser renderers, build
// watchers and vault. A V8 heap flag alone cannot bound their aggregate RSS.
if (process.platform !== 'linux') throw new Error('Browser tests require Linux user systemd memory limits; no unbounded fallback')
if (await readRuntimeHealth()) throw new Error('A launcher is already running outside the test memory group; stop it before running the protected suite')
const command = process.argv.slice(2)
if (command[0] === '--') command.shift()
if (!command.length) throw new Error('Usage: node bin/run-browser-tests.js -- <command> [args]')
if (command[0] === 'node') command[0] = process.execPath
const unit = `44b-browser-test-${process.pid}-${Date.now()}`
const args = ['--user', '--wait', '--pipe', `--unit=${unit}`, `--working-directory=${process.cwd()}`,
  '--property=MemoryAccounting=yes', '--property=MemoryMax=3G', '--property=MemorySwapMax=0',
  '--property=RuntimeMaxSec=900', '--property=TimeoutStopSec=5', '--property=KillMode=control-group', '--property=OOMPolicy=kill']
for (const key of ['PATH', 'CHROME_BIN', 'ZILLION_FILES_ONLY', 'ZILLION_GALLERY_UI_ONLY', 'ZILLION_SKIP_GALLERY_UI', 'ZILLION_MEMORY_TRACE']) if (process.env[key]) args.push(`--setenv=${key}=${process.env[key]}`)
const child = spawn('systemd-run', [...args, '--', ...command], { stdio: 'inherit' })
let peak = 0
let stopped = false
const control = (...args) => execFileSync('systemctl', ['--user', ...args, `${unit}.service`], { encoding: 'utf8', timeout: 7000, stdio: ['ignore', 'pipe', 'ignore'] })
const sample = () => {
  try {
    const value = Number(control('show', '--property=MemoryPeak', '--value'))
    if (Number.isSafeInteger(value) && value > peak) peak = value
  } catch { /* The unit may not exist yet or may already be collected. */ }
}
const timer = setInterval(sample, 1000)
const stop = () => {
  if (stopped) return
  stopped = true
  try { control('stop') } catch {}
}
// A kernel OOM can make systemd fail to kill the control group ("Invalid
// argument"), leaving launcher/vault/esbuild descendants reparented outside the
// cap. Detect them on the runtime ports and remove them, so a later run cannot
// silently reuse or leak that memory.
const runtimeMarkers = ['/44billion/server/dev-server.js', '/ez-vault/server.py', '44billion/node_modules/@esbuild', 'ez-vault/node_modules/@esbuild']
const leftoverRuntimeProcesses = () => {
  let output
  try { output = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 5000 }) } catch { return [] }
  const pids = new Set()
  for (const line of output.split('\n')) {
    if (!/:(?:10000|8080|4000)\s/.test(line)) continue
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]))
  }
  return [...pids].flatMap(pid => {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      return runtimeMarkers.some(marker => cmdline.includes(marker)) ? [{ pid, cmdline: cmdline.replaceAll('\0', ' ').trim() }] : []
    } catch { return [] }
  })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop)
try {
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  sample()
  process.exitCode = result.code ?? 1
} finally {
  clearInterval(timer)
  stop()
  try { control('reset-failed') } catch {}
  const leftovers = leftoverRuntimeProcesses()
  if (leftovers.length) {
    for (const leftover of leftovers) { try { process.kill(leftover.pid, 'SIGKILL') } catch {} }
    console.error(`Browser test cleanup: killed ${leftovers.length} leftover runtime process(es) outside the unit: ${leftovers.map(leftover => `${leftover.pid} (${leftover.cmdline})`).join(', ')}`)
    process.exitCode = 1
  }
  const measured = peak ? `${(peak / 1024 / 1024).toFixed(0)} MiB` : 'unavailable for this short run'
  console.log(`Browser test memory: observed cgroup peak ${measured}; hard limit 3072 MiB, swap disabled.`)
}
