const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { start } = require('./helpers/file-server')

const R = '/odata/v4/relief'
const FIXTURE = path.join(__dirname, 'fixtures', 'b41-database.sqlite.gz')
const rows = (f, sql, ...a) => { const d = new DatabaseSync(f, { readOnly: true }); try { return d.prepare(sql).all(...a) } finally { d.close() } }
const sorted = list => list.slice().sort((a, b) => String(a.ID ?? a.code).localeCompare(String(b.ID ?? b.code)))
const B42_COLUMNS = {
  reliefgrid_CampDecisions: ['targetPerPerson', 'referencePerPerson', 'previousTargetPerPerson'],
  reliefgrid_AssessmentRecordLines: ['referencePerPerson', 'targetDecisionID', 'targetDecisionVersion', 'targetEffectiveFrom', 'targetSource', 'perHousehold'],
  reliefgrid_AssessmentRecords: ['recordedHouseholds', 'estimatedHouseholds', 'householdBasis', 'householdSize', 'householdAssumptionVersion'],
  reliefgrid_Camps: ['households']
}
const KEPT = ['reliefgrid_Camps', 'reliefgrid_CampDecisions', 'reliefgrid_Requests', 'reliefgrid_Pledges', 'reliefgrid_Stock', 'reliefgrid_AssessmentRecords',
  'reliefgrid_AssessmentRecordLines', 'reliefgrid_RequestReviews', 'reliefgrid_PlanningSettings', 'reliefgrid_PlanningSettingsChanges']

/**
 * The B4.2 upgrade of a database written by the B4.1 application
 * (test/fixtures/b41-database.sqlite.gz: synthetic records created through
 * the B4.1 API, see test/fixtures/README.md). A temporary copy is upgraded;
 * the fixture itself is never opened for writing.
 */
describe('B4.2 upgrade of a B4.1 database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-b42-'))
  const dbFile = path.join(dir, 'b41.sqlite')
  let server, prior, campID

  before(async () => {
    fs.writeFileSync(dbFile, zlib.gunzipSync(fs.readFileSync(FIXTURE)))
    const tables = rows(dbFile, "select name from sqlite_master where type = 'table'").map(t => t.name)
    assert.ok(!tables.includes('reliefgrid_DecisionReviews'), 'the fixture predates B4.2')
    prior = Object.fromEntries(KEPT.map(t => [t, rows(dbFile, `select * from ${t}`)]))
    campID = prior.reliefgrid_Camps[0].ID
    server = await start(dbFile)
  })

  after(async () => {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('adds the B4.2 tables, columns and review outcomes', () => {
    const tables = rows(dbFile, "select name from sqlite_master where type = 'table'").map(t => t.name)
    assert.ok(tables.includes('reliefgrid_DecisionReviews') && tables.includes('reliefgrid_ReviewOutcomes'))
    for (const [t, cols] of Object.entries(B42_COLUMNS)) {
      const have = rows(dbFile, `pragma table_info(${t})`).map(c => c.name)
      assert.ok(cols.every(c => have.includes(c)), t)
    }
    assert.deepEqual(rows(dbFile, 'select code from reliefgrid_ReviewOutcomes order by code').map(r => r.code), ['CHANGE_PROPOSED', 'CONFIRMED'])
  })

  it('keeps every B4.1 row, column for column: decisions, reviews, requests, pledges, deliveries, stock and history', () => {
    for (const [t, before] of Object.entries(prior)) {
      const now = rows(dbFile, `select * from ${t}`)
      for (const r of before) {
        const row = now.find(n => n.ID === r.ID)
        assert.ok(row, `${t}: row kept`)
        for (const [k, v] of Object.entries(r)) assert.deepEqual(row[k], v, `${t}.${k}`)
        for (const c of B42_COLUMNS[t] ?? []) assert.equal(row[c], null, `${t}.${c} is empty for an existing row`)
      }
      // the only additions: the assessment that explains the new container calculation (B4.3), and its lines
      const added = now.filter(n => !before.some(r => r.ID === n.ID))
      if (t === 'reliefgrid_AssessmentRecords') assert.deepEqual(added.map(a => a.trigger), ['REFERENCE_DATA_CHANGED'], t)
      else if (t === 'reliefgrid_AssessmentRecordLines') assert.equal(added.length, 9, t)
      else assert.equal(added.length, 0, t)
    }
    assert.ok(prior.reliefgrid_CampDecisions.length >= 2 && prior.reliefgrid_AssessmentRecordLines.length > 0, 'the fixture has decisions and history')
    assert.equal(rows(dbFile, "select count(*) n from reliefgrid_CampDecisions where kind <> 'APPLICABILITY'")[0].n, 0)
  })

  it('keeps the B4.1 decisions in force; reference figures apply until a local target is approved', async () => {
    const stock = Object.fromEntries((await server.api('GET', `${R}/Stock?$filter=camp_ID eq ${campID}`)).value.map(s => [s.standard_code, s]))
    assert.equal(stock.SOAP.assessment, 'NOT_APPLICABLE')
    assert.equal(stock.NET.assessment, 'NO_REQUIREMENT')
    assert.equal(stock.WATER.targetBasis, 'REFERENCE_FIGURE')
    assert.equal(Number(stock.WATER.perPerson), 15)
    assert.equal(stock.CONTAINER.targetBasis, 'HOUSEHOLD', 'B4.3: containers come from households')
    assert.equal(stock.CONTAINER.targetBasisText, 'Households (estimated)')
    const last = rows(dbFile, 'select ID from reliefgrid_AssessmentRecords order by assessedAt desc limit 1')[0]
    const water = rows(dbFile, "select state, requirement from reliefgrid_AssessmentRecordLines where record_ID = ? and standardCode = 'WATER'", last.ID)[0]
    assert.equal(stock.WATER.assessment, water.state, 'the live classification matches the last B4.1 assessment')
  })

  it('is a no-op on the next start', async () => {
    const tables = [...KEPT, 'reliefgrid_DecisionReviews']
    const snapshot = tables.map(t => sorted(rows(dbFile, `select * from ${t}`)))
    await server.stop()
    server = await start(dbFile)
    assert.deepEqual(tables.map(t => sorted(rows(dbFile, `select * from ${t}`))), snapshot)
  })
})
