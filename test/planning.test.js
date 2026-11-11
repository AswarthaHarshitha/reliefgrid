process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const SETTINGS = `${R}/PlanningSettings('CURRENT')`
const CHANGE = `${SETTINGS}/ReliefService.change`
const DEFAULTS = { criticalDays: 2, warningDays: 5, criticalPercent: 50, warningPercent: 90, targetDays: 7 }
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`

const fail = promise => promise.then(() => assert.fail('expected the request to fail'), e => e.response ?? e)
const codes = res => JSON.parse(res.headers['sap-messages'] ?? '[]').map(m => m.code)
const errorCodes = res => {
  const e = res.data.error
  return e.details ? e.details.map(d => d.code) : [e.code]
}
const settingsNow = async () => {
  const { data } = await GET(SETTINGS, coordinator)
  return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, Number(data[k])]))
}
const versionNow = async () => (await GET(SETTINGS, coordinator)).data.version
const change = async (values, reason = 'Test of the planning settings', user = admin) =>
  POST(CHANGE, { ...values, reason, version: await versionNow() }, user)

async function createCamp(data) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { district: 'District P', region: 'Region P', hazard_code: 'FLOOD', ...data }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}
const stockOf = async campID =>
  Object.fromEntries((await GET(`${camp(campID)}/stock`, coordinator)).data.value.map(s => [s.standard_code, s]))
const count = (line, quantity) => POST(`${R}/Stock(${line.ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(line.standard_code) ? { functionalUnits: quantity } : {}) }, coordinator)

describe('planning settings record', () => {
  it('exists once, with the shipped defaults', async () => {
    assert.deepEqual(await settingsNow(), DEFAULTS)
    const { data } = await GET(`${R}/PlanningSettings`, coordinator)
    assert.equal(data.value.length, 1)
  })

  it('is read-only through the entity itself', async () => {
    const res = await fail(PATCH(SETTINGS, { criticalDays: 3 }, admin))
    assert.ok([403, 405].includes(res.status))
    const del = await fail(axios.delete(SETTINGS, admin))
    assert.ok([403, 405].includes(del.status))
  })
})

describe('who may see and change the settings', () => {
  it('lets coordinators read the settings and their history, but not change them', async () => {
    await GET(SETTINGS, coordinator)
    await GET(`${R}/PlanningSettingsChanges`, coordinator)
    const res = await fail(change({ ...DEFAULTS, criticalDays: 3 }, 'should be refused', coordinator))
    assert.equal(res.status, 403)
    assert.deepEqual(await settingsNow(), DEFAULTS)
  })

  it('keeps donors away from the settings', async () => {
    assert.equal((await fail(GET(SETTINGS, donor))).status, 403)
    assert.equal((await fail(change({ ...DEFAULTS, criticalDays: 3 }, 'donor', donor))).status, 403)
    const { data } = await axios.get(`${D}/$metadata`, donor)
    assert.doesNotMatch(data, /PlanningSettings|criticalDays/)
  })

  it('tells the UI whether the user may change them', async () => {
    assert.equal((await GET(`${R}/planningAccess()`, coordinator)).data.canChange, false)
    assert.equal((await GET(`${R}/planningAccess()`, admin)).data.canChange, true)
  })
})

describe('validation', () => {
  const refused = async (values, expected, reason) => {
    const res = await fail(change(values, reason))
    assert.equal(res.status, expected.status ?? 400, JSON.stringify(values))
    assert.ok(errorCodes(res).includes(expected.code), `${expected.code} in ${errorCodes(res)}`)
    assert.deepEqual(await settingsNow(), DEFAULTS, 'nothing was saved')
  }

  it('requires a reason', async () => {
    // a blank reason is refused by the mandatory check before the handler runs
    for (const reason of ['   ', '']) {
      const res = await fail(change({ ...DEFAULTS, criticalDays: 3 }, reason))
      assert.equal(res.status, 400)
      assert.ok(errorCodes(res).some(c => ['ASSERT_MANDATORY', 'SETTINGS_REASON_REQUIRED'].includes(c)), String(errorCodes(res)))
    }
    assert.deepEqual(await settingsNow(), DEFAULTS, 'nothing was saved')
  })
  it('requires positive numbers for every field', async () => {
    await refused({ ...DEFAULTS, warningDays: 0 }, { code: 'SETTINGS_POSITIVE' })
    await refused({ ...DEFAULTS, criticalPercent: -5 }, { code: 'SETTINGS_POSITIVE' })
  })
  it('keeps critical strictly below warning', async () => {
    await refused({ ...DEFAULTS, criticalDays: 5 }, { code: 'SETTINGS_DAYS_ORDER' })
    await refused({ ...DEFAULTS, criticalPercent: 95 }, { code: 'SETTINGS_PERCENT_ORDER' })
  })
  it('keeps percentages at most 100 and days within 90', async () => {
    await refused({ ...DEFAULTS, warningPercent: 101 }, { code: 'SETTINGS_PERCENT_RANGE' })
    await refused({ ...DEFAULTS, warningDays: 91 }, { code: 'SETTINGS_DAYS_RANGE' })
    await refused({ ...DEFAULTS, targetDays: 91 }, { code: 'TARGET_DAYS_RANGE' })
  })
  it('refuses a save that changes nothing', async () => {
    await refused({ ...DEFAULTS }, { code: 'SETTINGS_UNCHANGED', status: 409 })
  })
})

describe('a change takes effect at once, everywhere', () => {
  let campID, stock

  before(async () => {
    // 100 people: water 1,500 L a day, living space 350 m2
    campID = await createCamp({ name: 'Planning Settings Camp', headcount: 100 })
    stock = await stockOf(campID)
    await count(stock.WATER, 3000) // exactly 2 days
    await count(stock.FOOD, 499) // 4.99 days
    await count(stock.SHELTER, 175) // exactly 50 %
    await count(stock.TOILET, 5) // 100 %
  })

  const line = async code => (await GET(`${R}/Stock(${stock[code].ID})`, coordinator)).data

  it('keeps strict comparisons at the default boundaries', async () => {
    assert.equal((await line('WATER')).assessment, 'ATTENTION', 'exactly 2 days is not critical')
    assert.equal((await line('FOOD')).assessment, 'ATTENTION')
    assert.equal((await line('SHELTER')).assessment, 'ATTENTION', 'exactly 50 % is not critical')
    assert.equal((await line('TOILET')).assessment, 'MET')
  })

  let saved
  it('saves an administrator change, logs it and reports its impact', async () => {
    const values = { criticalDays: 2.5, warningDays: 5, criticalPercent: 60, warningPercent: 90, targetDays: 7 }
    saved = await change(values, 'Monsoon season: earlier escalation')
    assert.deepEqual(codes(saved), ['SETTINGS_SAVED', 'SETTINGS_IMPACT'])
    assert.equal(saved.data.linesChanged, 2, 'water and living space became critical')
    assert.equal(saved.data.campsChanged, 1)
    assert.deepEqual(await settingsNow(), values)

    const { data } = await GET(`${R}/PlanningSettingsChanges?$orderby=changedAt desc&$top=1`, coordinator)
    const log = data.value[0]
    assert.equal(log.changedBy, 'admin')
    assert.equal(log.reason, 'Monsoon season: earlier escalation')
    assert.ok(Date.now() - new Date(log.changedAt) < 60000)
    assert.deepEqual(
      [log.previousCriticalDays, log.previousWarningDays, log.previousCriticalPercent, log.previousWarningPercent, log.previousTargetDays].map(Number),
      [2, 5, 50, 90, 7])
    assert.deepEqual(
      [log.newCriticalDays, log.newWarningDays, log.newCriticalPercent, log.newWarningPercent, log.newTargetDays].map(Number),
      [2.5, 5, 60, 90, 7])
    const { data: s } = await GET(SETTINGS, coordinator)
    assert.equal(s.modifiedBy, 'admin')
  })

  it('reclassifies stock lines immediately, with critical precedence', async () => {
    assert.equal((await line('WATER')).assessment, 'CRITICAL')
    assert.equal((await line('SHELTER')).assessment, 'CRITICAL')
    assert.equal((await line('FOOD')).assessment, 'ATTENTION')
    assert.equal((await line('TOILET')).assessment, 'MET')
  })

  it('gives camp health, the overview and the critical gaps list the same answer', async () => {
    const { data: h } = await GET(`${camp(campID)}/health`, coordinator)
    assert.equal(h.criticalGaps, 2)
    assert.equal(h.warningGaps, 1)
    const { data: o } = await GET(`${R}/overview()`, coordinator)
    const { data: gaps } = await GET(`${R}/Stock?$filter=severity eq 1 and camp/status_code eq 'ACTIVE'&$select=ID`, coordinator)
    const { data: all } = await GET(`${R}/Camps?$filter=IsActiveEntity eq true and status_code eq 'ACTIVE'&$expand=health`, coordinator)
    const sum = all.value.reduce((n, c) => n + (c.health?.criticalGaps ?? 0), 0)
    assert.equal(o.criticalGaps, gaps.value.length)
    assert.equal(o.criticalGaps, sum)
  })

  it('uses the stored replenishment target for shortfall and requests, unless one is given', async () => {
    await change({ criticalDays: 2.5, warningDays: 5, criticalPercent: 60, warningPercent: 90, targetDays: 10 }, 'Longer supply lines')
    assert.equal(Number((await line('WATER')).shortfall), 1500 * 10 - 3000)
    const res = await POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator)
    assert.ok(res.data.created >= 1)
    const { data } = await GET(`${camp(campID)}/requests?$filter=standard_code eq 'WATER'`, coordinator)
    assert.equal(Number(data.value[0].quantity), 1500 * 10 - 3000)
    assert.match(data.value[0].note, /10 days/)
  })

  it('warns, but saves, when the target is below the warning threshold', async () => {
    const res = await change({ criticalDays: 2.5, warningDays: 5, criticalPercent: 60, warningPercent: 90, targetDays: 4 }, 'Short-term test')
    assert.deepEqual(codes(res), ['SETTINGS_SAVED', 'SETTINGS_IMPACT', 'SETTINGS_TARGET_BELOW_WARNING'])
    assert.equal((await settingsNow()).targetDays, 4)
  })

  it('leaves not-assessed and not-counted lines exactly as they were', async () => {
    const empty = await createCamp({ name: 'Planning Empty Camp' })
    const before = Object.values(await stockOf(empty)).map(s => s.assessment)
    const uncounted = Object.values(stock).filter(s => !['WATER', 'FOOD', 'SHELTER', 'TOILET', 'NET'].includes(s.standard_code))
    await change({ criticalDays: 3, warningDays: 6, criticalPercent: 70, warningPercent: 95, targetDays: 8 }, 'Check B2 states')
    assert.ok(Object.values(await stockOf(empty)).every((s, i) => s.assessment === before[i] && s.assessment === 'NOT_ASSESSED'))
    for (const s of uncounted) {
      const now = await line(s.standard_code)
      assert.equal(now.assessment, 'NOT_COUNTED')
      assert.equal(now.shortfall, null)
    }
  })

  it('restores the defaults through the same audited path', async () => {
    const res = await change(DEFAULTS, 'Back to the shipped defaults')
    assert.deepEqual(codes(res).slice(0, 2), ['SETTINGS_SAVED', 'SETTINGS_IMPACT'])
    assert.deepEqual(await settingsNow(), DEFAULTS)
    const { data } = await GET(`${R}/PlanningSettingsChanges`, coordinator)
    assert.equal(data.value.length, 5, 'every successful save is logged, refused ones are not')
  })
})

describe('without the settings record', () => {
  it('never classifies a line as met, and restores the record on the next start', async () => {
    const campID = await createCamp({ name: 'No Settings Camp', headcount: 10 })
    const stock = await stockOf(campID)
    await count(stock.TOILET, 100)
    const saved = await cds.run(SELECT.one.from('reliefgrid.PlanningSettings'))
    await cds.run(DELETE.from('reliefgrid.PlanningSettings'))
    try {
      const { data } = await GET(`${R}/Stock(${stock.TOILET.ID})`, coordinator)
      assert.equal(data.assessment, 'NOT_ASSESSED')
      assert.equal(data.severity, null)
      const res = await fail(POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator))
      assert.equal(res.status, 500)
      assert.equal(errorCodes(res)[0], 'SETTINGS_MISSING')
      assert.equal(await require('../srv/lib/planning').ensureSettings(), true)
      assert.deepEqual(await settingsNow(), DEFAULTS)
      assert.equal(await require('../srv/lib/planning').ensureSettings(), false, 'an existing record is never replaced')
    } finally {
      await cds.run(DELETE.from('reliefgrid.PlanningSettings'))
      await cds.run(INSERT.into('reliefgrid.PlanningSettings').entries(saved))
    }
  })
})
