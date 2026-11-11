const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { start } = require('./helpers/file-server')

const R = '/odata/v4/relief'
const BUSINESS = ['reliefgrid_Camps', 'reliefgrid_Stock', 'reliefgrid_Requests', 'reliefgrid_Pledges']

const rows = (dbFile, table) => {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try { return db.prepare(`select * from ${table} order by ID`).all() } finally { db.close() }
}
const without = (row, keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)))

/**
 * An installation from before counts were tracked as unknown: never-counted
 * lines hold the old default 0, and a delivery onto a never-counted line was
 * added to that 0. Synthetic records in a temporary file only.
 */
describe('existing database after the not-counted migration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-migration-'))
  const dbFile = path.join(dir, 'existing.sqlite')
  let server, before_, ids

  before(async () => {
    server = await start(dbFile)
    const { api } = server
    const create = async data => {
      const d = await api('POST', `${R}/Camps`, {})
      const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
      await api('PATCH', key, { district: 'D', region: 'R', hazard_code: 'FLOOD', ...data })
      await api('POST', `${key}/ReliefService.draftActivate`, {})
      return d.ID
    }
    const campID = await create({ name: 'Migration Camp', headcount: 300 })
    await create({ name: 'Migration Empty Camp', headcount: 0 })
    const stock = Object.fromEntries((await api('GET', `${R}/Camps(ID=${campID},IsActiveEntity=true)/stock`)).value.map(s => [s.standard_code, s]))
    await api('POST', `${R}/Stock(${stock.FOOD.ID})/ReliefService.recordCount`, { quantity: 0 })
    await api('POST', `${R}/Stock(${stock.SOAP.ID})/ReliefService.recordCount`, { quantity: 1000 })
    await api('POST', `${R}/Camps(ID=${campID},IsActiveEntity=true)/ReliefService.raiseRequests`, { targetDays: 7 })
    ids = { food: stock.FOOD.ID, soap: stock.SOAP.ID, water: stock.WATER.ID }
    await server.stop()

    const db = new DatabaseSync(dbFile)
    db.prepare('update reliefgrid_Stock set quantity = 0 where countedAt is null').run()
    db.prepare('update reliefgrid_Stock set quantity = 800 where ID = ?').run(ids.water)
    db.close()
    before_ = Object.fromEntries(BUSINESS.map(t => [t, rows(dbFile, t)]))
    assert.equal(before_.reliefgrid_Stock.filter(s => s.countedAt === null && s.quantity === 0).length, 15)

    server = await start(dbFile)
  })

  after(async () => {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('marks only never-counted zeros as not counted', () => {
    const now = Object.fromEntries(rows(dbFile, 'reliefgrid_Stock').map(s => [s.ID, s]))
    for (const old of before_.reliefgrid_Stock) {
      const row = now[old.ID]
      if (old.countedAt === null && old.quantity === 0) assert.equal(row.quantity, null, old.standard_code)
      else assert.deepEqual(row, old, `${old.standard_code} untouched`)
    }
    assert.equal(now[ids.food].quantity, 0, 'a counted zero stays a zero')
    assert.equal(now[ids.soap].quantity, 1000)
    assert.equal(now[ids.water].quantity, 800, 'goods received onto a never-counted line are kept')
  })

  it('changes nothing else in the migrated rows, not even who modified them, and nothing in other tables', () => {
    const now = Object.fromEntries(rows(dbFile, 'reliefgrid_Stock').map(s => [s.ID, s]))
    for (const old of before_.reliefgrid_Stock)
      assert.deepEqual(without(now[old.ID], ['quantity']), without(old, ['quantity']))
    for (const t of BUSINESS.slice(0).filter(t => t !== 'reliefgrid_Stock'))
      assert.deepEqual(rows(dbFile, t), before_[t], t)
    assert.ok(before_.reliefgrid_Requests.length > 0)
  })

  it('serves the migrated lines with the new states', async () => {
    const line = async id => server.api('GET', `${R}/Stock(${id})`)
    assert.equal((await line(ids.food)).assessment, 'CRITICAL')
    assert.equal((await line(ids.water)).assessment, 'NOT_COUNTED')
    assert.equal((await line(ids.water)).shortfall, null)
    const { value } = await server.api('GET', `${R}/Camps?$filter=IsActiveEntity eq true&$expand=health&$orderby=name`)
    const [counted, empty] = value
    // FOOD counted 0 and SOAP 1,000 g for 300 people (0.4 days) are both critical
    assert.equal(counted.health.assessedIndicators, 2)
    assert.equal(counted.health.criticalGaps, 2)
    assert.equal(counted.health.notCountedIndicators, 6, 'mosquito nets are not decided (B4.1), not merely not counted')
    assert.equal(counted.health.compliance, 0)
    assert.equal(empty.health.assessment, 'Not assessed')
    assert.equal(empty.health.compliance, null)
  })

  it('is a no-op on the next start', async () => {
    const snapshot = Object.fromEntries(BUSINESS.map(t => [t, rows(dbFile, t)]))
    await server.stop()
    server = await start(dbFile)
    for (const t of BUSINESS) assert.deepEqual(rows(dbFile, t), snapshot[t], t)
  })
})
