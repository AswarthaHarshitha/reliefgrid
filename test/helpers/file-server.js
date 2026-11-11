const { spawn } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')

/**
 * Starts the real server on a temporary database file (never the project
 * database). Resolves once it listens; stop() waits until the process exits.
 */
function start(dbFile) {
  const env = { ...process.env }
  for (const k of ['CDS_ENV', 'NODE_ENV', 'HOST', 'PORT', 'CDS_CONFIG']) delete env[k]
  const child = spawn(process.execPath, [require.resolve('@sap/cds/bin/serve.js')], {
    cwd: ROOT,
    env: { ...env, PORT: '0', CDS_ENV: 'development',
      CDS_CONFIG: JSON.stringify({ requires: { db: { kind: 'sqlite', credentials: { url: dbFile } }, auth: 'dummy' } }) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  return new Promise((resolve, reject) => {
    const onData = d => {
      output += d
      const m = output.match(/server listening on \{ url: 'http:\/\/localhost:(\d+)' \}/)
      if (m) {
        const base = `http://localhost:${m[1]}`
        resolve({
          base,
          output: () => output,
          api: async (method, url, body) => {
            const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
            if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`)
            return res.status === 204 ? null : res.json()
          },
          stop: () => new Promise(done => {
            if (child.exitCode !== null || child.signalCode !== null) return done()
            child.removeAllListeners('exit')
            child.on('exit', () => done())
            child.kill()
          })
        })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => reject(new Error(`server exited with ${code}:\n${output}`)))
  })
}

module.exports = { start }
