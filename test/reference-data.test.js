const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { start } = require('./helpers/file-server')

const ROOT = path.join(__dirname, '..')

/** Wording shipped before the B1 citation corrections, as an existing database still holds it. */
const OLD = {
  NET: 'WHO universal coverage target for long-lasting insecticidal nets: one net for every two people',
  FOOD: 'Sphere Handbook 2018, Food security and nutrition chapter: planning figure of 2,100 kcal per person per day',
  CONTAINER: 'Sphere Handbook 2018, Hygiene promotion standard 1.2: two clean 10-20 L water containers per household (household of 5 assumed)'
}
const OLD_FOOD_DESCR = 'General food ration providing 2,100 kcal'
const OLD_HIGH_PRIORITY = 'Below the Sphere minimum but not yet life-threatening'

const csv = file => {
  const [header, ...rows] = fs.readFileSync(path.join(ROOT, 'db/data', file), 'utf8').trim().split('\n').map(l => l.split(';'))
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

const rows = (dbFile, table) => {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try { return db.prepare(`select * from ${table} order by ID`).all() } finally { db.close() }
}

describe('reference data on an existing database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-refdata-'))
  const dbFile = path.join(dir, 'existing.sqlite')
  const R = '/odata/v4/relief'
  const BUSINESS = ['reliefgrid_Camps', 'reliefgrid_Stock', 'reliefgrid_Requests', 'reliefgrid_Pledges']
  let before_, server

  before(async () => {
    // A database in use: one camp with counts, requests and a pledge (synthetic, temporary file only).
    server = await start(dbFile)
    const { api } = server
    const draft = await api('POST', `${R}/Camps`, {})
    const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
    await api('PATCH', key, { name: 'Reference Data Test Camp', district: 'District T', region: 'Region T', hazard_code: 'FLOOD', headcount: 200 })
    await api('POST', `${key}/ReliefService.draftActivate`, {})
    for (const line of (await api('GET', `${R}/Camps(ID=${draft.ID},IsActiveEntity=true)/stock`)).value)
      await api('POST', `${R}/Stock(${line.ID})/ReliefService.recordCount`, { quantity: 10, ...(['TOILET', 'TAP'].includes(line.standard_code) ? { functionalUnits: 10 } : {}) })
    await api('POST', `${R}/Camps(ID=${draft.ID},IsActiveEntity=true)/ReliefService.raiseRequests`, { targetDays: 7 })
    const [request] = (await api('GET', `/odata/v4/donor/Requests?$top=1`)).value
    await api('POST', `/odata/v4/donor/Requests(${request.ID})/DonorService.pledge`, { donor: 'Reference Data Test Donor', quantity: 1 })
    await server.stop()

    // The database still holds the wording shipped before the citation corrections.
    const db = new DatabaseSync(dbFile)
    for (const [code, reference] of Object.entries(OLD))
      db.prepare('update reliefgrid_Standards set reference = ? where code = ?').run(reference, code)
    db.prepare("update reliefgrid_Standards set descr = ? where code = 'FOOD'").run(OLD_FOOD_DESCR)
    db.prepare('update reliefgrid_Priorities set descr = ? where code = 2').run(OLD_HIGH_PRIORITY)
    db.close()
    before_ = Object.fromEntries(BUSINESS.map(t => [t, rows(dbFile, t)]))

    server = await start(dbFile)
  })

  after(async () => {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('serves the corrected citations and descriptions after a restart', async () => {
    const expected = csv('reliefgrid-Standards.csv')
    for (const service of ['/odata/v4/relief', '/odata/v4/donor']) {
      const { value } = await server.api('GET', `${service}/Standards`)
      for (const e of expected) {
        const got = value.find(s => s.code === e.code)
        assert.equal(got.reference, e.reference, `${service} ${e.code}`)
        assert.equal(got.descr, e.descr, `${service} ${e.code}`)
        assert.equal(Number(got.perPerson), Number(e.perPerson), `${service} ${e.code}`)
      }
      assert.doesNotMatch(JSON.stringify(value), /WHO|household of 5 assumed|General food ration/)
      const priorities = (await server.api('GET', `${service}/Priorities`)).value
      assert.equal(priorities.find(p => p.code === 2).descr, csv('reliefgrid-Priorities.csv').find(p => p.code === '2').descr)
    }
  })

  it('leaves camps, stock, requests and pledges exactly as they were', () => {
    for (const t of BUSINESS) {
      assert.ok(before_[t].length > 0, `${t} has rows`)
      assert.deepEqual(rows(dbFile, t), before_[t], t)
    }
  })
})
