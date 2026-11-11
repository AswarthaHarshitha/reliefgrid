const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { start } = require('./helpers/file-server')

const R = '/odata/v4/relief'
const rows = (dbFile, sql, ...args) => {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try { return db.prepare(sql).all(...args) } finally { db.close() }
}
const write = (dbFile, fn) => {
  const db = new DatabaseSync(dbFile)
  try { fn(db) } finally { db.close() }
}
const sorted = list => list.slice().sort((a, b) => String(a.ID).localeCompare(String(b.ID)))
const without = (list, cols) => sorted(list).map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k))))

/**
 * The B4.1 upgrade of an existing database (temporary file, synthetic
 * records). The database is first put back into its pre-B4.1 state: the NET
 * reference figure of 0.5 per person, NET requests in every situation, and no
 * decisions or reviews. A restart must then remove the ratio, flag only the
 * outstanding NET requests, and change nothing else.
 */
describe('B4.1 upgrade of an existing database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-b41-'))
  const dbFile = path.join(dir, 'existing.sqlite')
  const ids = {}
  let server, prior

  before(async () => {
    server = await start(dbFile)
    const { api } = server
    const create = async name => {
      const d = await api('POST', `${R}/Camps`, {})
      const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
      await api('PATCH', key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount: 100 })
      await api('POST', `${key}/ReliefService.draftActivate`, {})
      return d.ID
    }
    ids.active = await create('Upgrade Camp')
    ids.closed = await create('Upgrade Closed Camp')
    const net = (await api('GET', `${R}/Camps(ID=${ids.active},IsActiveEntity=true)/stock?$filter=standard_code eq 'NET'`)).value[0]
    await api('POST', `${R}/Stock(${net.ID})/ReliefService.recordCount`, { quantity: 10 })
    await api('POST', `${R}/Camps(ID=${ids.closed},IsActiveEntity=true)/ReliefService.closeCamp`, {})
    await server.stop()

    // Back to the pre-B4.1 state: the old NET figure and rule, and NET requests as B4.0 could create them.
    write(dbFile, db => {
      db.prepare("update reliefgrid_Standards set perPerson = 0.5, applicability = 'ALWAYS' where code = 'NET'").run()
      db.prepare('delete from reliefgrid_RequestReviews').run()
      const now = new Date().toISOString()
      const request = (camp, status, quantity, pledged, delivered) => {
        const ID = crypto.randomUUID()
        db.prepare(`insert into reliefgrid_Requests (ID, createdAt, createdBy, modifiedAt, modifiedBy, camp_ID, standard_code, quantity,
          pledgedQuantity, deliveredQuantity, priority_code, status_code) values (?, ?, 'b40', ?, 'b40', ?, 'NET', ?, ?, ?, 2, ?)`)
          .run(ID, now, now, camp, quantity, pledged, delivered, status)
        return ID
      }
      const pledge = (requestID, quantity, received, status) => db.prepare(`insert into reliefgrid_Pledges (ID, createdAt, createdBy, modifiedAt,
        modifiedBy, request_ID, donor, quantity, receivedQuantity, status_code) values (?, ?, 'b40', ?, 'b40', ?, 'Upgrade Donor', ?, ?, ?)`)
        .run(crypto.randomUUID(), now, now, requestID, quantity, received, status)
      ids.open = request(ids.active, 'OPEN', 40, 0, 0)
      ids.partly = request(ids.active, 'PARTIAL', 40, 20, 0); pledge(ids.partly, 20, 0, 'PLEDGED')
      ids.fully = request(ids.active, 'PLEDGED', 30, 30, 0); pledge(ids.fully, 30, 0, 'PLEDGED')
      ids.delivered = request(ids.active, 'PARTIAL', 50, 10, 10); pledge(ids.delivered, 10, 10, 'DELIVERED')
      ids.cancelled = request(ids.closed, 'CANCELLED', 40, 0, 0)
    })
    prior = {
      requests: rows(dbFile, 'select * from reliefgrid_Requests'),
      pledges: rows(dbFile, 'select * from reliefgrid_Pledges'),
      stock: rows(dbFile, 'select * from reliefgrid_Stock'),
      records: rows(dbFile, 'select * from reliefgrid_AssessmentRecords'),
      lines: rows(dbFile, 'select * from reliefgrid_AssessmentRecordLines')
    }
    server = await start(dbFile)
  })

  after(async () => {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('removes the NET ratio and makes NET need a decision', () => {
    const [net] = rows(dbFile, "select perPerson, applicability from reliefgrid_Standards where code = 'NET'")
    assert.equal(net.perPerson, null)
    assert.equal(net.applicability, 'DECISION_REQUIRED')
  })

  it('flags the outstanding NET requests for review, and only those', () => {
    const flagged = rows(dbFile, "select ID from reliefgrid_Requests where review_code = 'PENDING'").map(r => r.ID).sort()
    assert.deepEqual(flagged, [ids.open, ids.partly, ids.fully, ids.delivered].sort())
    const reviews = rows(dbFile, 'select * from reliefgrid_RequestReviews')
    assert.equal(reviews.length, 4)
    assert.ok(reviews.every(r => r.cause === 'NOT_DECIDED' && r.flaggedBy === 'system' && r.decision_ID === null && r.resolution_code === 'PENDING'),
      'no decision is invented for the upgrade')
    assert.match(server.output(), /4 outstanding requests flagged for review/)
  })

  it('cancels nothing and changes no quantity, pledge, delivery, basis or stock', () => {
    assert.deepEqual(without(rows(dbFile, 'select * from reliefgrid_Requests'), ['review_code', 'currentReview_ID']),
      without(prior.requests, ['review_code', 'currentReview_ID']))
    assert.deepEqual(sorted(rows(dbFile, 'select * from reliefgrid_Pledges')), sorted(prior.pledges))
    assert.deepEqual(sorted(rows(dbFile, 'select * from reliefgrid_Stock')), sorted(prior.stock))
  })

  it('keeps the earlier assessment history and explains the change with new records', async () => {
    const lines = rows(dbFile, 'select * from reliefgrid_AssessmentRecordLines')
    assert.deepEqual(sorted(lines.filter(l => prior.lines.some(b => b.ID === l.ID))), sorted(prior.lines))
    const added = rows(dbFile, 'select * from reliefgrid_AssessmentRecords').filter(r => !prior.records.some(b => b.ID === r.ID))
    assert.deepEqual(added.map(r => r.trigger), ['REFERENCE_DATA_CHANGED'], 'one record, for the active camp only')
    assert.equal(added[0].camp_ID, ids.active)
    const [net] = rows(dbFile, "select state, perPerson from reliefgrid_AssessmentRecordLines where record_ID = ? and standardCode = 'NET'", added[0].ID)
    assert.equal(net.state, 'NOT_DECIDED')
    assert.equal(net.perPerson, null)
    const live = (await server.api('GET', `${R}/Stock?$filter=camp_ID eq ${ids.active} and standard_code eq 'NET'`)).value[0]
    assert.equal(live.assessment, 'NOT_DECIDED')
    assert.equal(Number(live.quantity), 10, 'the count is kept')
  })

  it('offers no NET request to donors', async () => {
    const { value } = await server.api('GET', `/odata/v4/donor/Requests?$filter=standard_code eq 'NET'`)
    assert.equal(value.length, 0)
  })

  it('is a no-op on the next start', async () => {
    const snapshot = ['reliefgrid_Requests', 'reliefgrid_RequestReviews', 'reliefgrid_AssessmentRecords'].map(t => sorted(rows(dbFile, `select * from ${t}`)))
    await server.stop()
    server = await start(dbFile)
    assert.deepEqual(['reliefgrid_Requests', 'reliefgrid_RequestReviews', 'reliefgrid_AssessmentRecords'].map(t => sorted(rows(dbFile, `select * from ${t}`))), snapshot)
    assert.doesNotMatch(server.output(), /flagged for review|re-assessed/)
  })
})
