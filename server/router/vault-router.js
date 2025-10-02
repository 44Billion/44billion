import IttyRouter from './itty-router.js'
import { pipeline } from 'node:stream/promises'
import { dupeRstream } from '#helpers/stream.js'
import handleEtag from '#helpers/middleware/etag.js'
import fs from 'node:fs'
import path from 'node:path'
import mime from 'mime'

const isDev = process.env.NODE_ENV === 'development'

async function getFileModificationTime (filePath) {
  try {
    const stats = await fs.promises.stat(filePath)
    return stats.mtime.getTime()
  } catch (_err) {
    return undefined
  }
}

// vault.<domain>
const vaultRouter = IttyRouter()
  // Redirect /index.html to /
  .get('/index.html', async (req, res) => {
    res.setHeader('location', '/')
    res.writeHead(301)
    res.end()
    return res
  })
  // Handle all other routes by serving files from vault/docs
  .get('*', async (req, res) => {
    try {
      const pathname = req.webUrl.pathname

      // Handle trailing slash redirect (except for root '/')
      if (pathname !== '/' && pathname.endsWith('/')) {
        const redirectPath = pathname.slice(0, -1) // Remove trailing slash
        res.setHeader('location', redirectPath)
        res.writeHead(301)
        res.end()
        return res
      }

      // Handle root path
      const filePath = pathname === '/' ? '/index.html' : pathname

      // Basic security validations
      if (filePath.length > 1000) {
        res.setHeader('content-type', 'text/plain')
        res.writeHead(400)
        res.end('Bad Request: Path too long')
        return res
      }

      if (filePath.includes('\0') || filePath.includes('%00')) {
        res.setHeader('content-type', 'text/plain')
        res.writeHead(400)
        res.end('Bad Request: Null bytes not allowed')
        return res
      }

      // Early security check: detect suspicious patterns in the pathname
      if (filePath.includes('..') || filePath.includes('*') || filePath.includes('?') ||
          filePath.includes('[') || filePath.includes(']') || filePath.includes('{') ||
          filePath.includes('}') || filePath.includes('~') || filePath.includes('|')) {
        res.setHeader('content-type', 'text/plain')
        res.writeHead(400)
        res.end('Bad Request: Invalid characters in path')
        return res
      }

      // Construct the absolute path to the vault docs file
      // Current project is at ~/repositories/44billion, vault is at ~/repositories/vault
      const vaultDocsRoot = path.resolve(process.cwd(), '../vault/docs')
      const vaultDocsPath = path.resolve(vaultDocsRoot, filePath.slice(1)) // Remove leading slash

      // Security check: ensure the resolved path is still within the vault/docs directory
      // e.g. preventing acess to /../../../home/user/.ssh/id_rsa
      if (!vaultDocsPath.startsWith(vaultDocsRoot + path.sep) && vaultDocsPath !== vaultDocsRoot) {
        res.setHeader('content-type', 'text/plain')
        res.writeHead(403)
        res.end('Access denied: Path traversal not allowed')
        return res
      }

      // Block access to potentially sensitive file types
      const fileExt = path.extname(vaultDocsPath).toLowerCase()
      const blockedExtensions = ['.env', '.key', '.pem', '.p12', '.pfx', '.crt', '.csr', '.log']
      if (blockedExtensions.includes(fileExt)) {
        res.setHeader('content-type', 'text/plain')
        res.writeHead(403)
        res.end('Access denied: File type not allowed')
        return res
      }

      // Check if file exists
      try {
        await fs.promises.access(vaultDocsPath, fs.constants.F_OK)
      } catch (_err) {
        // File not found
        res.setHeader('content-type', 'text/plain')
        res.writeHead(404)
        res.end('File not found')
        return res
      }

      const stats = await fs.promises.stat(vaultDocsPath)
      if (stats.isDirectory()) {
        // Try to serve index.html from the directory
        const indexPath = path.join(vaultDocsPath, 'index.html')
        try {
          await fs.promises.access(indexPath, fs.constants.F_OK)
          const contentType = mime.getType('.html') || 'text/html'
          const ts = await getFileModificationTime(indexPath)

          // Set cache-control header
          const cacheControl = isDev ? 'no-cache' : 'must-revalidate, max-age=30'
          res.setHeader('cache-control', cacheControl)
          res.setHeader('content-type', contentType)

          const fileStream = fs.createReadStream(indexPath)
          const [streamForRes, streamForEtag] = dupeRstream(fileStream, 2)

          if (await handleEtag(req, res, { data: streamForEtag, ts })) return res

          res.writeHead(200)
          await pipeline(
            streamForRes,
            res
          )
          return res
        } catch (_err) {
          // No index.html in directory
          res.setHeader('content-type', 'text/plain')
          res.writeHead(403)
          res.end('Directory access forbidden')
          return res
        }
      }

      const contentType = mime.getType(path.extname(vaultDocsPath)) || 'application/octet-stream'
      const ts = await getFileModificationTime(vaultDocsPath)

      const cacheControl = isDev ? 'no-cache' : 'must-revalidate, max-age=30'
      res.setHeader('cache-control', cacheControl)
      res.setHeader('content-type', contentType)

      const fileStream = fs.createReadStream(vaultDocsPath)
      const [streamForRes, streamForEtag] = dupeRstream(fileStream, 2)

      if (await handleEtag(req, res, { data: streamForEtag, ts })) return res

      res.writeHead(200)
      await pipeline(
        streamForRes,
        res
      )

      return res
    } catch (err) {
      console.error('Error serving vault file:', err)
      res.setHeader('content-type', 'text/plain')
      res.writeHead(500)
      res.end('Internal server error')
      return res
    }
  })

export default vaultRouter
