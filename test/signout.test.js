process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { basicUser, SIGNED_OUT } = require('../srv/lib/signout')

const { axios } = cds.test(__dirname + '/..')
const as = (username, password = 'test') => ({ auth: { username, password }, validateStatus: () => true })

describe('signing out with basic authentication', () => {
  it('the sign-out endpoint accepts only the reserved user, and challenges everyone else in the services\' realm', async () => {
    const out = await axios.get('/signout-credentials', as(SIGNED_OUT, 'anything'))
    assert.equal(out.status, 200)
    assert.equal(out.headers['cache-control'], 'no-store')
    for (const res of [await axios.get('/signout-credentials', as('admin')), await axios.get('/signout-credentials', { validateStatus: () => true })]) {
      assert.equal(res.status, 401)
      assert.equal(res.headers['www-authenticate'], 'Basic realm="Users"')
    }
    const service = await axios.get('/odata/v4/access/access()', { validateStatus: () => true })
    assert.equal(service.headers['www-authenticate'], 'Basic realm="Users"', 'the same realm, so the browser replaces the stored credentials')
  })

  it('the reserved user can do nothing: every service challenges it', async () => {
    for (const url of ['/odata/v4/access/access()', '/odata/v4/relief/Camps', '/odata/v4/donor/Requests', '/odata/v4/relief/$metadata']) {
      const res = await axios.get(url, as(SIGNED_OUT, 'anything'))
      assert.equal(res.status, 401, url)
      assert.equal(res.headers['www-authenticate'], 'Basic realm="Users"', url)
    }
  })

  it('real users are unaffected', async () => {
    assert.equal((await axios.get('/odata/v4/relief/Camps', as('coordinator'))).status, 200)
    assert.equal((await axios.get('/odata/v4/donor/Requests', as('donor'))).status, 200)
  })

  it('reads the user name of a basic Authorization header, and nothing else', () => {
    assert.equal(basicUser('Basic ' + Buffer.from('signed-out:x').toString('base64')), 'signed-out')
    assert.equal(basicUser('Basic ' + Buffer.from('user:pa:ss').toString('base64')), 'user')
    assert.equal(basicUser('Bearer abc'), null)
    assert.equal(basicUser(undefined), null)
  })
})
