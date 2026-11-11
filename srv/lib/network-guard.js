const net = require('node:net')

/** Authentication kinds that let anyone in, or accept well-known test passwords. */
const INSECURE_AUTH_KINDS = ['dummy', 'mocked']

const isInsecureAuth = kind => INSECURE_AUTH_KINDS.includes(kind)

/** True only for addresses that cannot be reached from another machine. */
function isLoopback(address) {
  if (!address) return false
  if (address === 'localhost') return true
  const ip = address.replace(/^\[|\]$/g, '')
  if (net.isIPv4(ip)) return ip.split('.')[0] === '127'
  if (net.isIPv6(ip)) {
    if (ip === '::1') return true
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    return !!mapped && mapped[1].split('.')[0] === '127'
  }
  return false
}

function refusal(kind, where) {
  return [
    `Refusing to start: authentication "${kind}" lets anyone act as a coordinator,`,
    `so it is only allowed on a loopback address, but the server would listen on ${where}.`,
    'For local development, keep HOST unset (it defaults to localhost) or set HOST=localhost.',
    'To serve other machines, use real authentication: NODE_ENV=production, or CDS_ENV=selfhost with configured users.'
  ].join('\n')
}

const exitWith = message => {
  console.error(message)
  process.exit(1)
}

/**
 * Checks the address a listening server actually bound to. A non-loopback
 * address closes the server and stops the process; `stop` is injectable so
 * the rejection path can be tested without a network.
 */
function enforceLoopbackBinding(server, kind, stop = exitWith) {
  const bound = server.address()
  const address = typeof bound === 'string' ? bound : bound?.address
  if (isLoopback(address)) return true
  server.close()
  stop(refusal(kind, address ?? 'an unknown address'))
  return false
}

module.exports = { INSECURE_AUTH_KINDS, isInsecureAuth, isLoopback, refusal, enforceLoopbackBinding }
