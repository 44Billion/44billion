// Dev helper: exposes the local dev servers — launcher (:10000) and EZ Vault
// (:4000) — to an Android device connected over USB via `adb reverse`, then
// runs `npm start`.
//
// Optionally connect over wifi:
// https://developer.android.com/tools/adb?hl=pt-br#connect-to-a-device-over-wi-fi
// Go to Dev Options > Wi-Fi debugging > Pair device with pairing code.
// Then run `adb pair <ip>:<port>`,
// `adb connect <ip>:<port>` and
// `adb devices` to verify the connection.
//
// On the phone, open http://localhost:10000. Chrome/Edge resolve `*.localhost`
// to loopback, so app subdomains (`0.localhost:10000`, ...) reach this machine
// with no tunnel and no TLS (localhost is a secure context, so service workers
// keep working). The `adb reverse` mappings are removed when this script exits.

import { spawn, spawnSync } from 'node:child_process'

const LAUNCHER_PORT = process.env.LAUNCHER_PORT || '10000'
const VAULT_PORT = process.env.VAULT_PORT || '4000'

let npm
let shuttingDown = false

function adb (args) {
  const result = spawnSync('adb', args, { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') {
    throw new Error('adb was not found in PATH. Install Android platform-tools and enable USB debugging on the device.')
  }
  return result
}

function removeReverse (port) {
  const result = adb(['reverse', '--remove', `tcp:${port}`])
  if (result.status !== 0) {
    console.error(`Failed to remove adb reverse for port ${port}`)
  }
}

function cleanup (code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  if (npm?.pid) {
    try { process.kill(-npm.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  removeReverse(LAUNCHER_PORT)
  removeReverse(VAULT_PORT)
  process.exit(code)
}

process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))

function checkDevice () {
  const state = adb(['get-state'])
  if (state.status !== 0 || (state.stdout || '').trim() !== 'device') {
    console.error('No Android device with USB debugging connected. Check `adb devices` first.')
    process.exit(1)
  }
}

function setupReverse (port) {
  const result = adb(['reverse', `tcp:${port}`, `tcp:${port}`])
  if (result.status !== 0) {
    console.error(`adb reverse failed for port ${port}: ${(result.stderr || '').trim()}`)
    removeReverse(LAUNCHER_PORT)
    removeReverse(VAULT_PORT)
    process.exit(1)
  }
}

function main () {
  try {
    checkDevice()
  } catch (err) {
    console.error(err?.message ?? err)
    process.exit(1)
  }

  setupReverse(LAUNCHER_PORT)
  setupReverse(VAULT_PORT)

  console.log(`adb reverse ready: phone localhost:${LAUNCHER_PORT} -> this machine`)
  console.log(`Launcher: http://localhost:${LAUNCHER_PORT}`)

  npm = spawn('npm', ['start'], {
    detached: true,
    stdio: 'inherit'
  })

  npm.once('error', err => {
    console.error(`Failed to start npm: ${err?.message ?? err}`)
    cleanup(1)
  })
  npm.once('exit', (code, signal) => {
    cleanup(code ?? (signal ? 1 : 0))
  })
}

main()
