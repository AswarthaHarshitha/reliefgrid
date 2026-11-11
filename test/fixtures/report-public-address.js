// Test-only preload: makes every HTTP server report a non-loopback bound
// address, to exercise the post-listen guard without touching the network.
const http = require('node:http')
const address = http.Server.prototype.address
http.Server.prototype.address = function () {
  const real = address.call(this)
  return real && typeof real === 'object' ? { ...real, address: '10.0.0.5', family: 'IPv4' } : real
}
