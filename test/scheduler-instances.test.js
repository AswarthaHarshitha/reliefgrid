const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { start } = require('./helpers/file-server')

const R = '/odata/v4/relief'
const rows = (f, sql, ...a) => { const d = new DatabaseSync(f, { readOnly: true }); try { return d.prepare(sql).all(...a) } finally { d.close() } }

/**
 * Two application instances run the scheduled-decision job at the same
 * moment against one database (temporary SQLite file) while a decision is
 * due. The decision must come into force once, with one assessment record.
 * (Two servers cannot be started at the same moment on one SQLite file: the
 * start-up schema evolution reports "database is locked". SQLite deployments
 * are single-instance; on SAP HANA the HDI deployer creates the schema.)
 */
describe('scheduled decisions with two application instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-instances-'))
  const dbFile = path.join(dir, 'shared.sqlite')
  let campID, decisionID, servers = []

  before(async () => {
    const s = await start(dbFile)
    const d = await s.api('POST', `${R}/Camps`, {})
    const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
    await s.api('PATCH', key, { name: 'Instances Camp', district: 'D', region: 'R', hazard_code: 'FLOOD', headcount: 100 })
    await s.api('POST', `${key}/ReliefService.draftActivate`, {})
    campID = d.ID
    await s.stop()
    // Fixture: a decision approved earlier for today (two different users, as the workflow requires).
    decisionID = crypto.randomUUID()
    const today = new Date().toISOString().slice(0, 10)
    const db = new DatabaseSync(dbFile)
    try {
      db.prepare(`insert into reliefgrid_CampDecisions (ID, createdAt, createdBy, modifiedAt, modifiedBy, camp_ID, kind, standard_code, intent,
        applicable, source, reason, proposedBy, proposedAt, reviewDate, effectiveFrom, version, status_code, approvedBy, approvedAt)
        values (?, ?, 'coordinator', ?, 'admin', ?, 'APPLICABILITY', 'NET', 'DECIDE', 0, 'Test reference', 'No malaria risk', 'coordinator', ?,
        '2099-12-31', ?, 2, 'SCHEDULED', 'admin', ?)`).run(decisionID, today, today, campID, today, today, today)
    } finally { db.close() }
  })

  after(async () => {
    await Promise.all(servers.map(s => s.stop()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const worker = goAt => new Promise((resolve, reject) =>
    execFile(process.execPath, [path.join(__dirname, 'helpers', 'activate-due-worker.js'), dbFile, String(goAt)], { cwd: path.join(__dirname, '..') },
      (err, stdout, stderr) => err ? reject(new Error(stderr)) : resolve(JSON.parse(stdout.trim().split('\n').pop()))))

  it('the decision comes into force exactly once', async () => {
    const goAt = Date.now() + 4000
    const results = await Promise.all([worker(goAt), worker(goAt)])
    assert.equal(results[0].activated + results[1].activated, 1, JSON.stringify(results))
    console.log(`  instances: ${JSON.stringify(results)}`)
    const [d] = rows(dbFile, 'select status_code, version from reliefgrid_CampDecisions where ID = ?', decisionID)
    assert.equal(d.status_code, 'APPROVED')
    assert.equal(d.version, 3, 'claimed once')
    const records = rows(dbFile, "select ID from reliefgrid_AssessmentRecords where trigger = 'DECISION_EFFECTIVE' and triggerID = ?", decisionID)
    assert.equal(records.length, 1, 'one assessment record')
  })

  it('a later start finds nothing to do and serves the decision in force', async () => {
    servers = [await start(dbFile)]
    assert.doesNotMatch(servers[0].output(), /scheduled decisions took effect/)
    assert.equal(rows(dbFile, "select count(*) n from reliefgrid_AssessmentRecords where trigger = 'DECISION_EFFECTIVE'")[0].n, 1)
    const { value } = await servers[0].api('GET', `${R}/Stock?$filter=camp_ID eq ${campID} and standard_code eq 'NET'`)
    assert.equal(value[0].assessment, 'NOT_APPLICABLE')
  })

  it('a local target whose date passed while the server was down takes effect at the next start, once', async () => {
    await servers[0].stop()
    servers = []
    const targetID = crypto.randomUUID()
    const past = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)
    const db = new DatabaseSync(dbFile)
    try {
      db.prepare(`insert into reliefgrid_CampDecisions (ID, createdAt, createdBy, modifiedAt, modifiedBy, camp_ID, kind, standard_code, intent,
        targetPerPerson, referencePerPerson, source, reason, proposedBy, proposedAt, reviewDate, effectiveFrom, version, status_code, approvedBy, approvedAt)
        values (?, ?, 'coordinator', ?, 'admin', ?, 'TARGET', 'WATER', 'DECIDE', 25, 15, 'Cluster note', 'Hot season', 'coordinator', ?,
        '2099-12-31', ?, 2, 'SCHEDULED', 'admin', ?)`).run(targetID, past, past, campID, past, past, past)
    } finally { db.close() }
    servers = [await start(dbFile)]
    assert.match(servers[0].output(), /1 scheduled decisions took effect/)
    const { value } = await servers[0].api('GET', `${R}/Stock?$filter=camp_ID eq ${campID} and standard_code eq 'WATER'`)
    assert.equal(value[0].targetBasis, 'LOCAL_TARGET')
    assert.equal(Number(value[0].perPerson), 25)
    const effective = () => rows(dbFile, "select ID from reliefgrid_AssessmentRecords where trigger = 'DECISION_EFFECTIVE' and triggerID = ?", targetID)
    assert.equal(effective().length, 1)
    const [line] = rows(dbFile, "select requirementBasis, targetDecisionID from reliefgrid_AssessmentRecordLines where record_ID = ? and standardCode = 'WATER'", effective()[0].ID)
    assert.equal(line.requirementBasis, 'LOCAL_TARGET')
    assert.equal(line.targetDecisionID, targetID)
    await servers[0].stop()
    servers = [await start(dbFile)]
    assert.doesNotMatch(servers[0].output(), /scheduled decisions took effect/)
    assert.equal(effective().length, 1, 'a restart does not activate it again')
  })
})
