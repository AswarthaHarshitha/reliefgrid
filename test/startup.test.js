const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { isLoopback, isInsecureAuth, enforceLoopbackBinding } = require('../srv/lib/network-guard')

const ROOT = path.join(__dirname, '..')
const IN_MEMORY = { requires: { db: { kind: 'sqlite', credentials: { url: ':memory:' } } } }

/** A non-loopback IPv4 address of this machine, if it has one. */
const externalAddress = Object.values(os.networkInterfaces())
  .flat()
  .find(i => i && i.family === 'IPv4' && !i.internal)?.address

/**
 * Starts the real server in a child process. Resolves with the port once it
 * listens, or with the exit code and output if it stops first.
 */
function start(env) {
  const base = { ...process.env }
  for (const k of ['CDS_ENV', 'NODE_ENV', 'HOST', 'PORT', 'CDS_CONFIG']) delete base[k]
  const child = spawn(process.execPath, [require.resolve('@sap/cds/bin/serve.js')], {
    cwd: ROOT,
    env: { ...base, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('server neither started nor stopped:\n' + output))
    }, 30000)
    const onData = d => {
      output += d
      const m = output.match(/server listening on \{ url: 'http:\/\/localhost:(\d+)' \}/)
      if (m) {
        clearTimeout(timer)
        resolve({ port: Number(m[1]), output, stop: () => child.kill() })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ exitCode: code, output })
    })
  })
}

/** For runs that must be refused: stops a server that started anyway, then fails. */
async function expectRefused(env) {
  const s = await start(env)
  if (s.stop) {
    s.stop()
    assert.fail('server started although it must be refused:\n' + s.output)
  }
  return s
}

/** Resolves true when a TCP connection to host:port succeeds. */
const reachable = (host, port) =>
  new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: 2000 })
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => (socket.destroy(), resolve(false)))
  })

describe('loopback detection', () => {
  it('accepts loopback addresses only', () => {
    for (const a of ['localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1'])
      assert.equal(isLoopback(a), true, a)
    for (const a of [undefined, '', '0.0.0.0', '::', '192.168.1.20', '10.0.0.5', '::ffff:10.0.0.5', 'example.org', '128.0.0.1'])
      assert.equal(isLoopback(a), false, String(a))
  })

  it('treats dummy and mocked authentication as insecure', () => {
    assert.equal(isInsecureAuth('dummy'), true)
    assert.equal(isInsecureAuth('mocked'), true)
    assert.equal(isInsecureAuth('basic'), false)
    assert.equal(isInsecureAuth('xsuaa'), false)
  })
})

describe('post-listen check of the bound address', () => {
  const fakeServer = address => {
    const server = { closed: false, address: () => address, close: () => (server.closed = true) }
    return server
  }
  const check = address => {
    const server = fakeServer(address)
    let message
    const accepted = enforceLoopbackBinding(server, 'dummy', m => (message = m))
    return { accepted, closed: server.closed, message }
  }

  for (const address of ['127.0.0.1', '127.0.1.1', '::1', '::ffff:127.0.0.1'])
    it(`accepts ${address}`, () => {
      const r = check({ address, port: 4004 })
      assert.equal(r.accepted, true)
      assert.equal(r.closed, false)
      assert.equal(r.message, undefined)
    })

  for (const address of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.20', 'fe80::1', '::ffff:10.0.0.5'])
    it(`closes the server and stops on ${address}`, () => {
      const r = check({ address, port: 4004 })
      assert.equal(r.accepted, false)
      assert.equal(r.closed, true)
      assert.match(r.message, new RegExp(`Refusing to start: authentication "dummy".*${address.replace(/[.:]/g, '\\$&')}`, 's'))
    })

  it('stops when the bound address is unknown', () => {
    const r = check(null)
    assert.equal(r.accepted, false)
    assert.match(r.message, /an unknown address/)
  })

  it('accepts a real server bound to 127.0.0.1', async () => {
    const server = net.createServer()
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    try {
      assert.equal(enforceLoopbackBinding(server, 'dummy', () => assert.fail('must not stop')), true)
    } finally {
      server.close()
    }
  })

  it('terminates the real server process when the bound address is not loopback', async () => {
    const preload = path.join(__dirname, 'fixtures', 'report-public-address.js')
    const s = await expectRefused({ NODE_OPTIONS: `--require ${preload}`, CDS_CONFIG: JSON.stringify(IN_MEMORY) })
    assert.equal(s.port, undefined, 'must not report listening')
    assert.equal(s.exitCode, 1)
    assert.match(s.output, /Refusing to start: authentication "dummy"[\s\S]*listen on 10\.0\.0\.5/)
  })
})

describe('startup guard', () => {
  it('keeps local development working, reachable only from this machine', async () => {
    const s = await start({ CDS_CONFIG: JSON.stringify(IN_MEMORY) })
    assert.ok(s.port, s.output)
    try {
      const res = await fetch(`http://localhost:${s.port}/odata/v4/relief/Camps`)
      assert.equal(res.status, 200)
      if (externalAddress) assert.equal(await reachable(externalAddress, s.port), false, 'must not listen on ' + externalAddress)
    } finally {
      s.stop()
    }
  })

  it('allows insecure authentication on an explicitly configured loopback host', async () => {
    const s = await start({ HOST: '127.0.0.1', CDS_CONFIG: JSON.stringify(IN_MEMORY) })
    assert.ok(s.port, s.output)
    try {
      assert.equal(await reachable('127.0.0.1', s.port), true)
      if (externalAddress) assert.equal(await reachable(externalAddress, s.port), false)
    } finally {
      s.stop()
    }
  })

  for (const host of ['0.0.0.0', '::'])
    it(`refuses development authentication on ${host}`, async () => {
      const s = await expectRefused({ HOST: host, CDS_CONFIG: JSON.stringify(IN_MEMORY) })
      assert.equal(s.port, undefined, 'must not listen')
      assert.notEqual(s.exitCode, 0)
      assert.match(s.output, /Refusing to start: authentication "dummy"/)
    })

  if (externalAddress)
    it('refuses development authentication on a network address', async () => {
      const s = await expectRefused({ HOST: externalAddress, CDS_CONFIG: JSON.stringify(IN_MEMORY) })
      assert.equal(s.port, undefined, 'must not listen')
      assert.match(s.output, /Refusing to start/)
    })

  it('refuses mocked test users on a public interface', async () => {
    const s = await expectRefused({ CDS_ENV: 'test', HOST: '0.0.0.0' })
    assert.equal(s.port, undefined, 'must not listen')
    assert.match(s.output, /Refusing to start: authentication "mocked"/)
  })

  it('leaves real authentication on all interfaces unchanged', async () => {
    const config = {
      requires: {
        ...IN_MEMORY.requires,
        auth: { users: { controlroom: { password: 'a-long-test-password', roles: ['Coordinator'] } } }
      }
    }
    const s = await start({ NODE_ENV: 'production', CDS_ENV: 'selfhost', CDS_CONFIG: JSON.stringify(config) })
    assert.ok(s.port, s.output)
    try {
      const url = `http://localhost:${s.port}/odata/v4/relief/Camps`
      assert.equal((await fetch(url)).status, 401)
      const auth = { authorization: 'Basic ' + btoa('controlroom:a-long-test-password') }
      assert.equal((await fetch(url, { headers: auth })).status, 200)
      if (externalAddress) assert.equal(await reachable(externalAddress, s.port), true, 'self-hosting serves the network')
    } finally {
      s.stop()
    }
  })
})
