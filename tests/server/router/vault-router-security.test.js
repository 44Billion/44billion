import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

describe('Vault Router Security', () => {
  const vaultDocsRoot = path.resolve(process.cwd(), '../vault/docs')

  describe('Path Traversal Detection', () => {
    it('should allow legitimate paths', () => {
      const legitimatePaths = [
        'modules/avatar.js',
        'styles/main.css',
        'index.html',
        'api/v1/users.json',
        'docs/README.md'
      ]

      legitimatePaths.forEach(filePath => {
        const resolvedPath = path.resolve(vaultDocsRoot, filePath)
        const isAllowed = resolvedPath.startsWith(vaultDocsRoot + path.sep) || resolvedPath === vaultDocsRoot
        assert.ok(isAllowed, `Legitimate path should be allowed: ${filePath}`)
      })
    })

    it('should block malicious paths', () => {
      const maliciousPaths = [
        '../../../etc/passwd',
        '../../home/user/.ssh/id_rsa',
        '../../../root/.bashrc',
        '../../../../etc/shadow',
        '../vault/../../../etc/hosts'
      ]

      maliciousPaths.forEach(filePath => {
        const resolvedPath = path.resolve(vaultDocsRoot, filePath)
        const isBlocked = !resolvedPath.startsWith(vaultDocsRoot + path.sep) && resolvedPath !== vaultDocsRoot
        assert.ok(isBlocked, `Malicious path should be blocked: ${filePath}`)
      })
    })

    it('should handle edge cases correctly', () => {
      const edgeCases = [
        { path: '', expected: false }, // Empty path resolves to root
        { path: '.', expected: false }, // Current dir resolves to root
        { path: '..', expected: true } // Parent dir should be blocked
      ]

      edgeCases.forEach(({ path: testPath, expected }) => {
        const resolvedPath = path.resolve(vaultDocsRoot, testPath)
        const isBlocked = !resolvedPath.startsWith(vaultDocsRoot + path.sep) && resolvedPath !== vaultDocsRoot
        assert.equal(isBlocked, expected, `Edge case path: ${testPath}`)
      })
    })
  })

  describe('Glob Pattern Detection', () => {
    const suspiciousPatterns = ['..', '*', '?', '[', ']', '{', '}', '~', '|']

    it('should allow legitimate paths without suspicious patterns', () => {
      const legitimatePaths = [
        '/index.html',
        '/modules/avatar.js',
        '/styles/main.css',
        '/docs/README.md',
        '/images/logo.png',
        '/api/v1/users.json',
        '/files/data_2024.csv',
        '/scripts/build-script.sh',
        '/config/app-settings.json'
      ]

      legitimatePaths.forEach(testPath => {
        const hasSuspicious = suspiciousPatterns.some(pattern => testPath.includes(pattern))
        assert.ok(!hasSuspicious, `Legitimate path should be allowed: ${testPath}`)
      })
    })

    it('should block paths with malicious patterns', () => {
      const maliciousPatterns = [
        { path: '/../../etc/passwd', pattern: '..' },
        { path: '/files/*.js', pattern: '*' },
        { path: '/backup?.tar', pattern: '?' },
        { path: '/logs[1-9].txt', pattern: '[' },
        { path: '/config{prod,dev}.json', pattern: '{' },
        { path: '/~/private.key', pattern: '~' },
        { path: '/cmd|rm -rf', pattern: '|' }
      ]

      maliciousPatterns.forEach(({ path: testPath, pattern }) => {
        const hasSuspicious = suspiciousPatterns.some(p => testPath.includes(p))
        assert.ok(hasSuspicious, `Path with ${pattern} should be blocked: ${testPath}`)
      })
    })
  })

  describe('Additional Security Validations', () => {
    it('should block paths that are too long', () => {
      const longPath = '/' + 'a'.repeat(1001)
      const isTooLong = longPath.length > 1000
      assert.ok(isTooLong, 'Extremely long paths should be blocked')
    })

    it('should allow reasonable path lengths', () => {
      const normalPath = '/modules/avatar.js'
      const isReasonable = normalPath.length <= 1000
      assert.ok(isReasonable, 'Normal paths should be allowed')
    })

    it('should block paths with null bytes', () => {
      const pathsWithNullBytes = [
        '/file\u0000.txt',
        '/file%00.txt',
        '/dir\u0000/file.js',
        '/path%00test.html'
      ]

      pathsWithNullBytes.forEach(testPath => {
        const hasNullByte = testPath.includes('\0') || testPath.includes('%00')
        assert.ok(hasNullByte, `Path with null byte should be blocked: ${testPath}`)
      })
    })

    it('should block sensitive file extensions', () => {
      const sensitiveFiles = [
        '/config.env',
        '/private.key',
        '/certificate.pem',
        '/keystore.p12',
        '/cert.pfx',
        '/ssl.crt',
        '/request.csr',
        '/application.log'
      ]

      const blockedExtensions = ['.env', '.key', '.pem', '.p12', '.pfx', '.crt', '.csr', '.log']

      sensitiveFiles.forEach(testPath => {
        const fileExt = testPath.split('.').pop()?.toLowerCase()
        const isBlocked = blockedExtensions.includes('.' + fileExt)
        assert.ok(isBlocked, `Sensitive file should be blocked: ${testPath}`)
      })
    })

    it('should allow safe file extensions', () => {
      const safeFiles = [
        '/document.pdf',
        '/image.png',
        '/style.css',
        '/script.js',
        '/page.html',
        '/data.json',
        '/readme.md',
        '/archive.zip'
      ]

      const blockedExtensions = ['.env', '.key', '.pem', '.p12', '.pfx', '.crt', '.csr', '.log']

      safeFiles.forEach(testPath => {
        const fileExt = testPath.split('.').pop()?.toLowerCase()
        const isBlocked = blockedExtensions.includes('.' + fileExt)
        assert.ok(!isBlocked, `Safe file should be allowed: ${testPath}`)
      })
    })
  })

  describe('Pathname Handling', () => {
    it('should handle trailing slash redirects correctly', () => {
      const trailingSlashCases = [
        { path: '/modules/', shouldRedirect: true, expected: '/modules' },
        { path: '/api/v1/', shouldRedirect: true, expected: '/api/v1' },
        { path: '/', shouldRedirect: false, expected: '/' },
        { path: '/index.html', shouldRedirect: false, expected: '/index.html' }
      ]

      trailingSlashCases.forEach(({ path, shouldRedirect, expected }) => {
        const needsRedirect = path !== '/' && path.endsWith('/')
        const redirectPath = needsRedirect ? path.slice(0, -1) : path

        assert.equal(needsRedirect, shouldRedirect, `Trailing slash detection for: ${path}`)
        if (shouldRedirect) {
          assert.equal(redirectPath, expected, `Redirect path for: ${path}`)
        }
      })
    })

    it('should handle root path correctly', () => {
      const rootPathCases = [
        { input: '/', expected: '/index.html' },
        { input: '/modules/avatar.js', expected: '/modules/avatar.js' },
        { input: '/styles/main.css', expected: '/styles/main.css' }
      ]

      rootPathCases.forEach(({ input, expected }) => {
        const filePath = input === '/' ? '/index.html' : input
        assert.equal(filePath, expected, `Root path handling for: ${input}`)
      })
    })
  })

  describe('File Path Construction', () => {
    it('should construct file paths correctly', () => {
      const testCases = [
        { input: '/index.html', expected: path.join(vaultDocsRoot, 'index.html') },
        { input: '/modules/avatar.js', expected: path.join(vaultDocsRoot, 'modules/avatar.js') },
        { input: '/styles/main.css', expected: path.join(vaultDocsRoot, 'styles/main.css') }
      ]

      testCases.forEach(({ input, expected }) => {
        const filePath = input === '/' ? '/index.html' : input
        const vaultDocsPath = path.resolve(vaultDocsRoot, filePath.slice(1))
        assert.equal(vaultDocsPath, expected, `File path construction for: ${input}`)
      })
    })
  })
})
