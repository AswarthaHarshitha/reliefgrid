/**
 * Signing out with HTTP basic authentication. There is no server session to
 * end: the browser keeps the user name and password for the realm and sends
 * them with every request. The sign-out page replaces them with a reserved user:
 *
 * - /signout-credentials accepts only that reserved user (any other credentials
 *   are challenged), so the browser stores it for the "Users" realm in place of
 *   the real account;
 * - every service call made as that user is challenged, so the browser asks for
 *   a real sign-in the next time ReliefGrid is opened.
 *
 * The reserved user can never act: it has no password anyone knows, no role, and
 * every service refuses it before authentication runs. With XSUAA on SAP BTP the
 * approuter handles sign-out; this changes nothing there.
 */

const SIGNED_OUT = 'signed-out'
const REALM = 'Users'

/** The user name in a basic Authorization header, or null. */
function basicUser(header) {
  const m = /^Basic\s+(.+)$/i.exec(header || '')
  if (!m) return null
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8')
    const i = decoded.indexOf(':')
    return i < 0 ? decoded : decoded.slice(0, i)
  } catch {
    return null
  }
}

const challenge = res => res.status(401).set('WWW-Authenticate', `Basic realm="${REALM}"`).set('Cache-Control', 'no-store').json({ status: 'signed out' })

function install(app) {
  app.get('/signout-credentials', (req, res) => {
    if (basicUser(req.headers.authorization) !== SIGNED_OUT) return challenge(res)
    res.set('Cache-Control', 'no-store').json({ status: 'signed out' })
  })
  app.use('/odata', (req, res, next) => (basicUser(req.headers.authorization) === SIGNED_OUT ? challenge(res) : next()))
}

module.exports = { SIGNED_OUT, REALM, basicUser, install }
