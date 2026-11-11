const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { start } = require('./helpers/file-server')
const { baselineID } = require('../srv/lib/assessment')

const R = '/odata/v4/relief'
const rows = (dbFile, sql, ...args) => {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try { return db.prepare(sql).all(...args) } finally { db.close() }
}
const write = (dbFile, sql, ...args) => {
  const db = new DatabaseSync(dbFile)
  try { db.prepare(sql).run(...args) } finally { db.close() }
}

/**
 * Start-up behaviour on a file database (temporary file, synthetic records).
 * A pre-B4 database is simulated by removing the history and the request
 * bases that B4.0 writes, which is the state those tables have after upgrade.
 */
describe('assessment history at start-up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-history-'))
  const dbFile = path.join(dir, 'existing.sqlite')
  let server, camps, requestsBefore, upgradeStartedAt

  before(async () => {
    server = await start(dbFile)
    const { api } = server
    const create = async (name, headcount) => {
      const d = await api('POST', `${R}/Camps`, {})
      const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
      await api('PATCH', key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount })
      await api('POST', `${key}/ReliefService.draftActivate`, {})
      return d.ID
    }
    camps = [await create('Baseline Camp A', 120), await create('Baseline Camp B', 0), await create('Baseline Camp C', 60)]
    const water = (await api('GET', `${R}/Camps(ID=${camps[0]},IsActiveEntity=true)/stock?$filter=standard_code eq 'WATER'`)).value[0]
    await api('POST', `${R}/Stock(${water.ID})/ReliefService.recordCount`, { quantity: 0 })
    await api('POST', `${R}/Camps(ID=${camps[0]},IsActiveEntity=true)/ReliefService.raiseRequests`, {})
    await api('POST', `${R}/Camps(ID=${camps[2]},IsActiveEntity=true)/ReliefService.closeCamp`, {})
    await server.stop()

    // Pre-B4 state: no history, requests without a basis.
    write(dbFile, 'delete from reliefgrid_AssessmentRecordLines')
    write(dbFile, 'delete from reliefgrid_AssessmentRecords')
    write(dbFile, 'update reliefgrid_Requests set basisAssessment_ID = null, basisRequirement = null, basisSource = null, basisSettingsVersion = null, basisTargetDays = null, basisCalculatedAt = null')
    requestsBefore = rows(dbFile, 'select * from reliefgrid_Requests order by ID')
    assert.ok(requestsBefore.length > 0)

    upgradeStartedAt = new Date().toISOString()
    server = await start(dbFile)
  })

  after(async () => {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('gives every existing camp, active or closed, one labelled baseline stamped at the upgrade', async () => {
    assert.match(server.output(), /3 camps given a baseline assessment \("Baseline at B4 upgrade"\)/)
    const recs = rows(dbFile, 'select * from reliefgrid_AssessmentRecords order by campName')
    assert.equal(recs.length, 3)
    for (const [i, rec] of recs.entries()) {
      assert.equal(rec.trigger, 'BASELINE')
      assert.equal(rec.label, 'Baseline at B4 upgrade')
      assert.equal(rec.actor, 'system')
      assert.equal(rec.ID, baselineID(rec.camp_ID))
      assert.ok(rec.assessedAt >= upgradeStartedAt, 'stamped at the upgrade, not earlier')
      assert.equal(rows(dbFile, 'select count(*) n from reliefgrid_AssessmentRecordLines where record_ID = ?', rec.ID)[0].n, 9)
      assert.equal(rec.campName, ['Baseline Camp A', 'Baseline Camp B', 'Baseline Camp C'][i])
    }
    const live = (await server.api('GET', `${R}/Stock?$filter=camp_ID eq ${camps[0]}&$select=standard_code,assessment`)).value
    const base = rows(dbFile, 'select standardCode, state from reliefgrid_AssessmentRecordLines where record_ID = ?', baselineID(camps[0]))
    assert.deepEqual(Object.fromEntries(base.map(l => [l.standardCode, l.state])), Object.fromEntries(live.map(l => [l.standard_code, l.assessment])))
  })

  it('leaves existing requests unchanged and marks them as raised before B4', async () => {
    assert.deepEqual(rows(dbFile, 'select * from reliefgrid_Requests order by ID'), requestsBefore)
    const { value } = await server.api('GET', `${R}/Requests?$select=ID,raisedBeforeB4,basisAssessment_ID`)
    assert.ok(value.length === requestsBefore.length && value.every(r => r.raisedBeforeB4 === true && r.basisAssessment_ID === null))
  })

  it('writes nothing on a restart when no input changed', async () => {
    const count = () => rows(dbFile, 'select count(*) n from reliefgrid_AssessmentRecords')[0].n
    const n = count()
    await server.stop()
    server = await start(dbFile)
    assert.equal(count(), n)
    assert.doesNotMatch(server.output(), /baseline assessment|re-assessed/)
  })

  it('re-assesses camps with history when a reference figure changes at start-up', async () => {
    await server.stop()
    // The database holds a different figure than db/data; the start-up refresh restores it.
    write(dbFile, "update reliefgrid_Standards set perPerson = 20 where code = 'WATER'")
    server = await start(dbFile)
    assert.match(server.output(), /2 camps re-assessed \(REFERENCE_DATA_CHANGED\)/)
    const recs = rows(dbFile, "select * from reliefgrid_AssessmentRecords where trigger = 'REFERENCE_DATA_CHANGED'")
    assert.deepEqual(recs.map(r => r.camp_ID).sort(), [camps[0], camps[1]].sort(), 'active camps only')
    const water = rows(dbFile, "select perPerson from reliefgrid_AssessmentRecordLines where record_ID = ? and standardCode = 'WATER'", recs.find(r => r.camp_ID === camps[0]).ID)
    assert.equal(Number(water[0].perPerson), 15)
  })

  it('re-assesses camps with history when the settings record has to be recreated', async () => {
    await server.stop()
    write(dbFile, 'delete from reliefgrid_PlanningSettings')
    server = await start(dbFile)
    assert.match(server.output(), /2 camps re-assessed \(SETTINGS_INITIALISED\)/)
    assert.equal(rows(dbFile, "select count(*) n from reliefgrid_AssessmentRecords where trigger = 'BASELINE'")[0].n, 3, 'no second baseline')
  })
})
