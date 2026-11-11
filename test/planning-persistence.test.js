const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { start } = require('./helpers/file-server')

const R = '/odata/v4/relief'
const SETTINGS = `${R}/PlanningSettings('CURRENT')`
const FIELDS = ['criticalDays', 'warningDays', 'criticalPercent', 'warningPercent', 'targetDays']
const pick = row => Object.fromEntries(FIELDS.map(f => [f, Number(row[f])]))
const rows = (dbFile, table) => {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try { return db.prepare(`select * from ${table} order by ID`).all() } finally { db.close() }
}

/** The planning settings on a file database (temporary file, synthetic records only). */
describe('planning settings across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-planning-'))
  const dbFile = path.join(dir, 'existing.sqlite')
  const changed = { criticalDays: 3, warningDays: 6, criticalPercent: 55, warningPercent: 95, targetDays: 9 }
  let server

  before(async () => {
    server = await start(dbFile)
    assert.match(server.output(), /planning settings created with the default values/)
    await server.api('POST', `${SETTINGS}/ReliefService.change`, { ...changed, reason: 'Persistence test', version: 1 })
    await server.stop()
    server = await start(dbFile)
  })

  after(async () => {
    await server?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps an administrator change after a restart', async () => {
    assert.deepEqual(pick(await server.api('GET', SETTINGS)), changed)
    assert.doesNotMatch(server.output(), /planning settings created/)
    assert.equal(rows(dbFile, 'reliefgrid_PlanningSettingsChanges').length, 1)
  })

  it('recreates a missing record with the defaults and keeps the history', async () => {
    await server.stop()
    const db = new DatabaseSync(dbFile)
    db.prepare('delete from reliefgrid_PlanningSettings').run()
    db.close()
    server = await start(dbFile)
    assert.match(server.output(), /planning settings created with the default values/)
    assert.deepEqual(pick(await server.api('GET', SETTINGS)),
      { criticalDays: 2, warningDays: 5, criticalPercent: 50, warningPercent: 90, targetDays: 7 })
    const history = rows(dbFile, 'reliefgrid_PlanningSettingsChanges')
    assert.equal(history.length, 1)
    assert.equal(history[0].reason, 'Persistence test')
  })
})
