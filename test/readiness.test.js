process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { axios } = cds.test(__dirname + '/..')

describe('Stage F: liveness and readiness', () => {
  it('/health answers without sign-in and says nothing else', async () => {
    const res = await axios.get('/health')
    assert.equal(res.status, 200)
    assert.deepEqual(res.data, { status: 'ok' })
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  })
  it('/ready checks the database', async () => {
    const res = await axios.get('/ready')
    assert.equal(res.status, 200)
    assert.deepEqual(res.data, { status: 'ready' })
  })
  it('/ready reports 503 without details when the database cannot be read', async () => {
    const run = cds.db.run
    cds.db.run = () => Promise.reject(new Error('database file is locked by /secret/path'))
    try {
      const res = await axios.get('/ready').catch(e => e.response)
      assert.equal(res.status, 503)
      assert.deepEqual(res.data, { status: 'not ready' })
    } finally {
      cds.db.run = run
    }
  })
})
