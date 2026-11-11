process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const { GET, POST, PATCH, PUT, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const SETTINGS = `${R}/PlanningSettings('CURRENT')`
const DEFAULTS = { criticalDays: 2, warningDays: 5, criticalPercent: 50, warningPercent: 90, targetDays: 7 }
const ROOT = path.join(__dirname, '..')

const outcome = promise => promise.then(res => res, e => e.response ?? e)
const ok = status => status >= 200 && status < 300
const record = () => cds.run(SELECT.one.from('reliefgrid.PlanningSettings').where({ ID: 'CURRENT' }))
const history = () => cds.run(SELECT.from('reliefgrid.PlanningSettingsChanges').orderBy('changedAt'))
const values = row => Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, Number(row[k])]))
const versionNow = async () => Number((await record()).version)
const changeBody = async (v, reason = 'security test') => ({ ...v, reason, version: await versionNow() })
const batch = (requests, user) => outcome(POST(`${R}/$batch`, { requests }, { ...user, headers: { 'content-type': 'application/json' } }))
const batchStatuses = res => (res.data?.responses ?? []).map(r => r.status)

/** Nothing about the record or its history may change through the request under test. */
async function unchanged(attempt, label) {
  const [beforeRow, beforeLog] = [await record(), await history()]
  const res = await attempt()
  assert.deepEqual(await record(), beforeRow, `${label}: settings changed`)
  assert.deepEqual(await history(), beforeLog, `${label}: history changed`)
  return res
}

let stockID, campID

describe('planning settings security and integrity', () => {
before(async () => {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name: 'Security Camp', district: 'D', region: 'R', hazard_code: 'FLOOD', headcount: 50 }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  campID = draft.ID
  stockID = (await GET(`${R}/Camps(ID=${campID},IsActiveEntity=true)/stock?$top=1`, coordinator)).data.value[0].ID
})

describe('the Administrator role is enforced by the backend', () => {
  it('is declared on the change action itself', () => {
    const action = cds.model.definitions['ReliefService.PlanningSettings'].actions.change
    assert.equal(action['@requires'], 'Administrator')
    assert.equal(cds.model.definitions.ReliefService['@requires'], 'Coordinator')
  })

  it('refuses a coordinator on every way to reach the change action', async () => {
    const body = await changeBody({ ...DEFAULTS, criticalDays: 3 })
    const paths = [
      `${SETTINGS}/ReliefService.change`,
      `${SETTINGS}/change`,
      `${R}/Stock(${stockID})/settings/ReliefService.change`,
      `${R}/Camps(ID=${campID},IsActiveEntity=true)/settings/ReliefService.change`
    ]
    for (const p of paths) {
      const res = await unchanged(() => outcome(POST(p, body, coordinator)), p)
      assert.ok(!ok(res.status), `${p} answered ${res.status}`)
    }
    const res = await unchanged(() => batch([{ id: '1', method: 'POST', url: "PlanningSettings('CURRENT')/ReliefService.change",
      headers: { 'content-type': 'application/json' }, body }], coordinator), '$batch')
    assert.ok(batchStatuses(res).every(s => !ok(s)) && batchStatuses(res).length === 1, `$batch inner ${batchStatuses(res)}`)
  })

  it('refuses a coordinator who tries to write the record directly', async () => {
    const attempts = [
      ['PATCH record', () => PATCH(SETTINGS, { criticalDays: 3 }, coordinator)],
      ['PUT record', () => PUT(SETTINGS, { ...DEFAULTS, ID: 'CURRENT', criticalDays: 3 }, coordinator)],
      ['DELETE record', () => axios.delete(SETTINGS, coordinator)],
      ['POST second record', () => POST(`${R}/PlanningSettings`, { ...DEFAULTS, ID: 'SECOND' }, coordinator)],
      ['PATCH via stock navigation', () => PATCH(`${R}/Stock(${stockID})/settings`, { criticalDays: 3 }, coordinator)]
    ]
    for (const [label, attempt] of attempts) {
      const res = await unchanged(() => outcome(attempt()), label)
      assert.ok(!ok(res.status), `${label} answered ${res.status}`)
    }
  })

  it('keeps donors away from the settings and the history, by every route', async () => {
    for (const p of [SETTINGS, `${R}/PlanningSettingsChanges`, `${R}/Stock(${stockID})/settings`, `${R}/planningAccess()`]) {
      const res = await outcome(GET(p, donor))
      assert.equal(res.status, 403, p)
    }
    const res = await unchanged(() => outcome(POST(`${SETTINGS}/ReliefService.change`, { ...DEFAULTS, criticalDays: 3, reason: 'x', version: 1 }, donor)), 'donor change')
    assert.equal(res.status, 403)
    const b = await batch([{ id: '1', method: 'GET', url: 'PlanningSettingsChanges' }], donor)
    assert.ok(!ok(b.status) || batchStatuses(b).every(s => !ok(s)), `donor $batch ${b.status} ${batchStatuses(b)}`)
    const { data } = await GET('/odata/v4/donor/$metadata', donor)
    assert.doesNotMatch(data, /PlanningSettings|criticalDays|changedBy/)
  })

  it('lets an administrator do nothing beyond the change action either', async () => {
    for (const [label, attempt] of [
      ['PATCH record', () => PATCH(SETTINGS, { criticalDays: 3 }, admin)],
      ['DELETE record', () => axios.delete(SETTINGS, admin)],
      ['POST second record', () => POST(`${R}/PlanningSettings`, { ...DEFAULTS, ID: 'SECOND' }, admin)],
      ['change another record', () => POST(`${R}/PlanningSettings('SECOND')/ReliefService.change`, { ...DEFAULTS, criticalDays: 3, reason: 'x', version: 1 }, admin)]
    ]) {
      const res = await unchanged(() => outcome(attempt()), label)
      assert.ok(!ok(res.status), `${label} answered ${res.status}`)
    }
    const all = await cds.run(SELECT.from('reliefgrid.PlanningSettings'))
    assert.deepEqual(all.map(r => r.ID), ['CURRENT'], 'still exactly one record')
  })

  it('cannot reach the settings through a camp draft', async () => {
    await POST(`${R}/Camps(ID=${campID},IsActiveEntity=true)/ReliefService.draftEdit`, { PreserveChanges: true }, admin)
    const key = `${R}/Camps(ID=${campID},IsActiveEntity=false)`
    await unchanged(async () => {
      await outcome(PATCH(key, { settings: { criticalDays: 3 } }, admin))
      await outcome(POST(`${key}/ReliefService.draftActivate`, {}, admin))
    }, 'deep update through a camp draft')
  })
})

describe('the change history cannot be altered', () => {
  before(async () => {
    await POST(`${SETTINGS}/ReliefService.change`, await changeBody({ ...DEFAULTS, criticalDays: 2.5 }, 'history entry under test'), admin)
  })

  it('refuses updates, replacements, deletions and inserts by any user and route', async () => {
    const [entry] = await history()
    const one = `${R}/PlanningSettingsChanges(${entry.ID})`
    for (const user of [admin, coordinator]) {
      for (const [label, attempt] of [
        ['PATCH', () => PATCH(one, { reason: 'rewritten' }, user)],
        ['PUT', () => PUT(one, { ...entry, reason: 'rewritten' }, user)],
        ['DELETE', () => axios.delete(one, user)],
        ['POST', () => POST(`${R}/PlanningSettingsChanges`, { reason: 'forged', changedBy: 'someone', changedAt: new Date().toISOString() }, user)],
        ['$batch PATCH', () => batch([{ id: '1', method: 'PATCH', url: `PlanningSettingsChanges(${entry.ID})`,
          headers: { 'content-type': 'application/json' }, body: { reason: 'rewritten' } }], user)],
        ['$batch DELETE', () => batch([{ id: '1', method: 'DELETE', url: `PlanningSettingsChanges(${entry.ID})` }], user)]
      ]) {
        const res = await unchanged(() => outcome(attempt()), `${user.auth.username} ${label}`)
        const statuses = res.data?.responses ? batchStatuses(res) : [res.status]
        assert.ok(statuses.every(s => !ok(s)), `${user.auth.username} ${label} answered ${statuses}`)
      }
    }
  })

  it('exposes no action on the history and no navigation into it', () => {
    const entity = cds.model.definitions['ReliefService.PlanningSettingsChanges']
    assert.equal(entity['@readonly'], true)
    assert.equal(Object.keys(entity.actions ?? {}).length, 0)
    for (const def of Object.values(cds.model.definitions))
      for (const el of Object.values(def.elements ?? {}))
        assert.notEqual(el.target, 'ReliefService.PlanningSettingsChanges', `${def.name}.${el.name} leads into the history`)
  })
})

describe('settings change and audit entry are one transaction', () => {
  it('records actor, time, reason, previous and new values, and the version', async () => {
    const before = await record()
    const started = Date.now()
    const res = await POST(`${SETTINGS}/ReliefService.change`, await changeBody({ ...DEFAULTS, warningPercent: 95 }, 'audit content check'), admin)
    const after = await record()
    const entry = (await history()).at(-1)
    assert.equal(entry.changedBy, 'admin')
    assert.equal(entry.reason, 'audit content check')
    assert.ok(new Date(entry.changedAt).getTime() >= started - 1000 && new Date(entry.changedAt).getTime() <= Date.now() + 1000)
    assert.deepEqual([entry.previousCriticalDays, entry.previousWarningDays, entry.previousCriticalPercent, entry.previousWarningPercent, entry.previousTargetDays].map(Number),
      Object.values(values(before)))
    assert.deepEqual([entry.newCriticalDays, entry.newWarningDays, entry.newCriticalPercent, entry.newWarningPercent, entry.newTargetDays].map(Number),
      Object.values(values(after)))
    assert.equal(entry.version, Number(before.version) + 1)
    assert.equal(res.data.version, entry.version)
    assert.equal(after.modifiedBy, 'admin')
  })

  it('rolls back the settings when the audit entry cannot be written', async () => {
    let fail = true
    cds.db.before('CREATE', 'reliefgrid.PlanningSettingsChanges', () => {
      if (fail) { fail = false; throw new Error('injected audit failure') }
    })
    const res = await unchanged(() => outcome(POST(`${SETTINGS}/ReliefService.change`,
      // version is read before the attempt, so a stale version is not what stops it
      { ...DEFAULTS, criticalDays: 3, warningPercent: 95, reason: 'must roll back', version: NaN }, admin)), 'version missing')
    assert.equal(res.status, 400)
    fail = true
    const rolledBack = await unchanged(async () => outcome(POST(`${SETTINGS}/ReliefService.change`,
      await changeBody({ ...DEFAULTS, criticalDays: 3, warningPercent: 95 }, 'must roll back'), admin)), 'audit failure')
    assert.ok(rolledBack.status >= 500, `answered ${rolledBack.status}`)
    assert.equal(fail, false, 'the audit insert was reached, after the settings update')
  })

  it('creates no audit entry for a refused change', async () => {
    for (const body of [
      { ...DEFAULTS, criticalDays: 9 },
      { ...DEFAULTS, warningPercent: 101 }
    ]) {
      const res = await unchanged(async () => outcome(POST(`${SETTINGS}/ReliefService.change`, await changeBody(body), admin)), JSON.stringify(body))
      assert.equal(res.status, 400)
    }
  })
})

describe('concurrent use', () => {
  it('refuses a change based on an older version, so no change is silently overwritten', async () => {
    const seen = await versionNow()
    const first = await POST(`${SETTINGS}/ReliefService.change`, { ...DEFAULTS, criticalDays: 3, warningPercent: 95, reason: 'first administrator', version: seen }, admin)
    assert.equal(first.status, 200)
    const second = await unchanged(() => outcome(POST(`${SETTINGS}/ReliefService.change`,
      { ...DEFAULTS, criticalDays: 4, reason: 'second administrator, stale form', version: seen }, admin)), 'stale change')
    assert.equal(second.status, 409)
    assert.equal(second.data.error.code, 'SETTINGS_CHANGED_MEANWHILE')
    assert.equal(Number((await record()).criticalDays), 3, 'the first change is still in force')
  })

  it('lets exactly one of two simultaneous changes from the same version through', async () => {
    const seen = await versionNow()
    const logBefore = (await history()).length
    const results = await Promise.all([
      outcome(POST(`${SETTINGS}/ReliefService.change`, { ...DEFAULTS, criticalDays: 1.5, reason: 'race A', version: seen }, admin)),
      outcome(POST(`${SETTINGS}/ReliefService.change`, { ...DEFAULTS, criticalDays: 3.5, reason: 'race B', version: seen }, admin))
    ])
    const statuses = results.map(r => r.status).sort()
    assert.deepEqual(statuses, [200, 409])
    const winner = results.find(r => r.status === 200)
    const log = await history()
    assert.equal(log.length, logBefore + 1)
    assert.equal(Number((await record()).criticalDays), Number(log.at(-1).newCriticalDays))
    assert.equal(log.at(-1).version, winner.data.version)
  })

  it('creates the record exactly once when initialisation runs several times at once', async () => {
    const planning = require('../srv/lib/planning')
    const saved = await record()
    await cds.run(DELETE.from('reliefgrid.PlanningSettings'))
    try {
      const created = await Promise.all([planning.ensureSettings(), planning.ensureSettings(), planning.ensureSettings()])
      assert.deepEqual(created.filter(Boolean).length, 1)
      assert.equal((await cds.run(SELECT.from('reliefgrid.PlanningSettings'))).length, 1)
    } finally {
      await cds.run(DELETE.from('reliefgrid.PlanningSettings'))
      await cds.run(INSERT.into('reliefgrid.PlanningSettings').entries(saved))
    }
  })
})

describe('test credentials cannot reach production', () => {
  const authFor = env => JSON.parse(execFileSync(process.execPath, ['-e',
    "const a=require('@sap/cds').env.requires.auth; console.log(JSON.stringify({kind:a.kind,users:Object.keys(a.users||{})}))"],
  { cwd: ROOT, env: { ...process.env, CDS_ENV: env, CDS_CONFIG: '' } }).toString())

  it('uses XSUAA without built-in users in production, and only configured users when self-hosted', () => {
    assert.deepEqual(authFor('production'), { kind: 'xsuaa', users: [] })
    assert.deepEqual(authFor('selfhost'), { kind: 'basic', users: [] })
  })

  it('keeps test users and passwords out of package.json and the production build', () => {
    const fs = require('node:fs')
    const os = require('node:os')
    const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
    assert.doesNotMatch(pkg, /"password"|"users"/)
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-build-'))
    try {
      execFileSync(path.join(ROOT, 'node_modules/.bin/cds'), ['build', '--production', '--dest', dest], { cwd: ROOT, stdio: 'ignore' })
      const files = []
      const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e =>
        e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)))
      walk(dest)
      assert.ok(files.some(f => f.endsWith('package.json')), 'the build produced a package.json')
      const leaking = files.filter(f => !f.endsWith('package-lock.json') && /"password"|test-users|password: 'test'/.test(fs.readFileSync(f, 'utf8')))
      assert.deepEqual(leaking.map(f => path.relative(dest, f)), [])
      const built = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'))
      for (const [profile, req] of Object.entries(built.cds.requires))
        assert.equal(req.auth?.users, undefined, `${profile} carries users`)
    } finally {
      fs.rmSync(dest, { recursive: true, force: true })
    }
  })

  it('defines no role collection assignment to any user', () => {
    const fs = require('node:fs')
    const mta = fs.readFileSync(path.join(ROOT, 'mta.yaml'), 'utf8')
    assert.match(mta, /Planning Administrator \(reliefgrid/)
    assert.doesNotMatch(mta, /user-groups|users:|assignments/i)
    const xs = JSON.parse(fs.readFileSync(path.join(ROOT, 'xs-security.json'), 'utf8'))
    // SEC-06 added the Donor role for known donor organisations; still no assignment to anyone
    assert.deepEqual(xs['role-templates'].map(r => r.name).sort(), ['Administrator', 'Coordinator', 'Donor'])
    assert.equal(xs['role-collections'], undefined)
  })
})
})
