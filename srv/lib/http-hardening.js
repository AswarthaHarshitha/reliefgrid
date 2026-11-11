const cds = require('@sap/cds')

/**
 * HTTP hardening for the self-hosted server (SEC-03, SEC-07). On BTP the
 * approuter is the edge, but the service sends the same headers itself.
 */

const UI5 = 'https://ui5.sap.com'

/**
 * The policy the apps need: SAPUI5 from ui5.sap.com, the launchpad's inline
 * configuration script, and nothing else. Frames only from the same origin.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${UI5}`,
  `style-src 'self' 'unsafe-inline' ${UI5}`,
  `img-src 'self' data: blob: ${UI5}`,
  `font-src 'self' data: ${UI5}`,
  `connect-src 'self' ${UI5}`,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ')

/** Sets the security headers on every response; HSTS only where the request came over HTTPS. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (req.secure || req.headers['x-forwarded-proto'] === 'https')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
}

/** True where the QUnit pages may be served: development and test profiles only. */
function testPagesAllowed(profiles = cds.env.profiles ?? []) {
  return profiles.includes('development') || profiles.includes('test')
}

const TEST_PAGE = /\/webapp\/test(\/|$)/

/** Refuses the apps' test pages outside development and test (SEC-07), whatever was copied into the image. */
function hideTestPages(req, res, next) {
  if (TEST_PAGE.test(req.path) && !testPagesAllowed()) return res.status(404).end()
  next()
}

/** Installs both, before the apps and services are mounted. */
function harden(app) {
  app.use(securityHeaders)
  app.use(hideTestPages)
}

module.exports = { CONTENT_SECURITY_POLICY, securityHeaders, testPagesAllowed, hideTestPages, harden }
