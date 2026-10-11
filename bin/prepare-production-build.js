import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export async function prepareProductionBuild ({
  root = path.resolve(import.meta.dirname, '..'),
  env = process.env,
  log = console.log
} = {}) {
  if (env.NODE_ENV === 'development') return

  const vaultRoot = path.resolve(root, '../ez-vault')
  let hasVault = true
  try {
    if (!(await stat(vaultRoot)).isDirectory()) {
      throw new Error(`Expected an ez-vault project directory at ${vaultRoot}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    hasVault = false
    log(`> ez-vault not found at ${vaultRoot}; building only the launcher.`)
  }

  if (hasVault) {
    let manifest
    try {
      manifest = JSON.parse(await readFile(path.join(vaultRoot, 'package.json'), 'utf8'))
    } catch (error) {
      throw new Error(`Invalid ez-vault package.json at ${vaultRoot}`, { cause: error })
    }
    if (manifest?.name !== 'ez-vault' || typeof manifest.scripts?.build !== 'string' || !manifest.scripts.build.trim()) {
      throw new Error(`Expected package name "ez-vault" and a build script at ${vaultRoot}`)
    }
  }

  const productionEnv = { ...env, NODE_ENV: 'production' }
  await runNpm(['i', '--include=dev'], root, productionEnv, log)
  if (hasVault) {
    await runNpm(['i', '--include=dev'], vaultRoot, productionEnv, log)
    await runNpm(['run', 'build'], vaultRoot, productionEnv, log)
  }
}

async function runNpm (args, cwd, env, log) {
  const step = `${path.basename(cwd)}: npm ${args.join(' ')}`
  log(`> ${step}`)
  await new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd, env, stdio: 'inherit' })
    child.once('error', error => reject(new Error(`Could not start ${step}`, { cause: error })))
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${step} failed (${signal ?? `exit ${code}`})`))
    })
  })
}
