process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH, PUT, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const SETTINGS = `${R}/PlanningSettings('CURRENT')`
const DEFAULTS = { criticalDays: 2, warningDays: 5, criticalPercent: 50, warningPercent: 90, targetDays: 7 }
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`

const outcome = p => p.then(r => r, e => e.response ?? e)
const ok = s => s >= 200 && s < 300
const records = campID => cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }).orderBy('assessedAt'))
const linesOf = recordID => cds.run(SELECT.from('reliefgrid.AssessmentRecordLines').where({ record_ID: recordID }).orderBy('standardCode'))
const lastRecord = async campID => (await records(campID)).at(-1)
const allHistory = async () => ({
  records: await cds.run(SELECT.from('reliefgrid.AssessmentRecords').orderBy('ID')),
  lines: await cds.run(SELECT.from('reliefgrid.AssessmentRecordLines').orderBy('ID'))
})

async function createCamp(data, user = coordinator) {
  const { data: draft } = await POST(`${R}/Camps`, {}, user)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { district: 'D', region: 'R', hazard_code: 'FLOOD', ...data }, user)
  await POST(`${key}/ReliefService.draftActivate`, {}, user)
  return draft.ID
}
async function editCamp(ID, data) {
  await POST(`${camp(ID)}/ReliefService.draftEdit`, { PreserveChanges: true }, coordinator)
  const key = `${R}/Camps(ID=${ID},IsActiveEntity=false)`
  await PATCH(key, data, coordinator)
  return outcome(POST(`${key}/ReliefService.draftActivate`, {}, coordinator))
}
const stockOf = async campID => Object.fromEntries((await GET(`${camp(campID)}/stock`, coordinator)).data.value.map(s => [s.standard_code, s]))
const count = (line, quantity) => POST(`${R}/Stock(${line.ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(line.standard_code) ? { functionalUnits: quantity } : {}) }, coordinator)
const version = async () => (await GET(SETTINGS, coordinator)).data.version
const changeSettings = async v => POST(`${SETTINGS}/ReliefService.change`, { ...v, reason: 'history test', version: await version() }, admin)

/** A record's lines must equal the live calculation at the moment it was written. */
async function matchesLive(record) {
  const live = await stockOf(record.camp_ID)
  for (const line of await linesOf(record.ID)) {
    const s = live[line.standardCode]
    assert.equal(line.state, s.assessment, line.standardCode)
    for (const [k, l] of [['severity', 'severity'], ['requirement', 'required'], ['daysOfCover', 'daysOfCover'], ['coveragePct', 'coveragePct'], ['shortfall', 'shortfall'], ['quantity', 'quantity']])
      assert.equal(line[k] === null ? null : Number(line[k]), s[l] === null ? null : Number(s[l]), `${line.standardCode}.${k}`)
    assert.equal(line.countedAt === null, s.countedAt === null, `${line.standardCode}.countedAt`)
  }
}

/** The B2/B3 rules worked out again from the record's own inputs only. */
function recalculate(rec, line) {
  if (!(rec.headcount > 0)) return 'NOT_ASSESSED'
  if (rec.settingsVersion === null) return 'NOT_ASSESSED'
  // B4.1 inputs; records written before B4.1 have no rule, which means "applies by default"
  if (line.applicabilityRule === 'DECISION_REQUIRED' && !line.applicabilityDecisionID) return 'NOT_DECIDED'
  if (line.applicable === false) return 'NOT_APPLICABLE'
  if (line.perPerson === null && line.perHousehold === null) return 'NO_REQUIREMENT'
  if (line.countedAt === null || line.quantity === null) return 'NOT_COUNTED'
  // a per-household line uses the households the record kept: counted, or estimated
  const need = line.perHousehold !== null ? (rec.recordedHouseholds ?? rec.estimatedHouseholds) * Number(line.perHousehold) : rec.headcount * Number(line.perPerson)
  const q = Number(line.quantity)
  const [crit, warn] = line.basis === 'Consumption'
    ? [need * Number(rec.criticalDays), need * Number(rec.warningDays)]
    : [need * Number(rec.criticalPercent) / 100, need * Number(rec.warningPercent) / 100]
  return q < crit ? 'CRITICAL' : q < warn ? 'ATTENTION' : 'MET'
}

describe('assessment history', () => {
  let campID, stock

  before(async () => {
    campID = await createCamp({ name: 'History Camp', headcount: 100 })
    stock = await stockOf(campID)
  })

  describe('one record per event, matching the live calculation', () => {
    it('records the registration of a camp', async () => {
      const [rec] = await records(campID)
      assert.equal(rec.trigger, 'CAMP_REGISTERED')
      assert.equal(rec.triggerID, campID)
      assert.equal(rec.actor, 'coordinator')
      assert.equal(rec.headcount, 100)
      assert.equal(rec.campName, 'History Camp')
      assert.equal(rec.settingsVersion, 1)
      assert.deepEqual([rec.criticalDays, rec.warningDays, rec.criticalPercent, rec.warningPercent, rec.targetDays].map(Number), Object.values(DEFAULTS))
      const lines = await linesOf(rec.ID)
      assert.equal(lines.length, 9)
      // containers are per household (B4.3), food is worked out from food energy (B5), the rest from the reference figure
      const BASIS = { CONTAINER: 'HOUSEHOLD', FOOD: 'FOOD_ENERGY' }
      assert.ok(lines.every(l => l.requirementBasis === (BASIS[l.standardCode] ?? 'REFERENCE_FIGURE') && l.requirementSource))
      assert.ok(lines.filter(l => l.standardCode !== 'NET').every(l => l.state === 'NOT_COUNTED'))
      const net = lines.find(l => l.standardCode === 'NET')
      assert.equal(net.state, 'NOT_DECIDED')
      assert.equal(net.applicabilityRule, 'DECISION_REQUIRED')
      assert.equal(net.applicabilityDecisionID, null)
      await matchesLive(rec)
    })

    it('records each stock count', async () => {
      await count(stock.WATER, 3000)
      const rec = await lastRecord(campID)
      assert.equal(rec.trigger, 'STOCK_COUNTED')
      assert.equal(rec.triggerID, stock.WATER.ID)
      const water = (await linesOf(rec.ID)).find(l => l.standardCode === 'WATER')
      assert.equal(Number(water.quantity), 3000)
      assert.ok(water.countedAt)
      assert.equal(water.state, 'ATTENTION')
      assert.equal(Number(water.perPerson), 15)
      assert.equal(water.unit, 'litres')
      await matchesLive(rec)
    })

    it('records a population change, and nothing when the population is unchanged', async () => {
      const before = (await records(campID)).length
      await editCamp(campID, { district: 'New District' })
      assert.equal((await records(campID)).length, before, 'no record without a population change')
      await editCamp(campID, { headcount: 150 })
      const rec = await lastRecord(campID)
      assert.equal(rec.trigger, 'POPULATION_CHANGED')
      assert.equal(rec.headcount, 150)
      await matchesLive(rec)
    })

    it('records the requests raised and keeps their basis on each request', async () => {
      await count(stock.FOOD, 0)
      const res = await POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator)
      assert.ok(res.data.created >= 1)
      const rec = await lastRecord(campID)
      assert.equal(rec.trigger, 'REQUESTS_RAISED')
      await matchesLive(rec)
      const { data } = await GET(`${camp(campID)}/requests`, coordinator)
      for (const r of data.value) {
        assert.equal(r.basisAssessment_ID, rec.ID)
        assert.equal(r.raisedBeforeB4, false)
        assert.equal(r.basisSettingsVersion, rec.settingsVersion)
        assert.equal(r.basisTargetDays, 7)
        assert.equal(r.basisCalculatedAt, rec.assessedAt)
        const line = (await linesOf(rec.ID)).find(l => l.standardCode === r.standard_code)
        assert.equal(Number(r.basisRequirement), Number(line.requirement))
        assert.match(r.basisSource, r.standard_code === 'FOOD' ? /^Food energy: 2100 kcal per person per day at 2100 kcal per pack \(planning assumption, not recorded\), 1 rations per person per day\. / : /^Reference figure \d/)
      }
    })

    it('records a manual request and keeps its basis', async () => {
      const { data } = await POST(`${camp(campID)}/ReliefService.requestSupplies`, { standard: 'SOAP', quantity: 500 }, coordinator)
      const rec = await lastRecord(campID)
      assert.equal(rec.trigger, 'REQUEST_SUBMITTED')
      assert.equal(rec.triggerID, data.ID)
      const { data: r } = await GET(`${R}/Requests(${data.ID})`, coordinator)
      assert.equal(r.basisAssessment_ID, rec.ID)
      assert.equal(r.basisTargetDays, null)
      assert.equal(r.raisedBeforeB4, false)
    })

    it('records a confirmed delivery', async () => {
      const { data } = await GET(`${D}/Requests?$filter=campName eq 'History Camp' and standard_code eq 'WATER'`, donor)
      const { data: p } = await POST(`${D}/Requests(${data.value[0].ID})/DonorService.pledge`, { donor: 'History Donor', quantity: 100 }, donor)
      await POST(`${R}/Pledges(${p.ID})/ReliefService.confirmDelivery`, { receivedQuantity: 100 }, coordinator)
      const rec = await lastRecord(campID)
      assert.equal(rec.trigger, 'DELIVERY_CONFIRMED')
      assert.equal(rec.triggerID, p.ID)
      assert.equal(Number((await linesOf(rec.ID)).find(l => l.standardCode === 'WATER').quantity), 3100)
      await matchesLive(rec)
    })

    it('records every active camp when the planning settings change, not closed camps', async () => {
      const closed = await createCamp({ name: 'Closed History Camp', headcount: 10 })
      await POST(`${camp(closed)}/ReliefService.closeCamp`, {}, coordinator)
      const closedBefore = (await records(closed)).length
      const res = await changeSettings({ ...DEFAULTS, criticalDays: 2.5 })
      const [change] = await cds.run(SELECT.from('reliefgrid.PlanningSettingsChanges').orderBy({ changedAt: 'desc' }).limit(1))
      const rec = await lastRecord(campID)
      assert.equal(rec.trigger, 'SETTINGS_CHANGED')
      assert.equal(rec.triggerID, change.ID)
      assert.equal(rec.actor, 'admin')
      assert.equal(rec.settingsVersion, res.data.version)
      assert.equal(Number(rec.criticalDays), 2.5)
      await matchesLive(rec)
      assert.equal((await records(closed)).length, closedBefore, 'closed camps are not re-assessed')
      await changeSettings(DEFAULTS)
    })
  })

  describe('explainable and immutable history', () => {
    it('explains every stored state from the record\'s own inputs', async () => {
      const recs = await cds.run(SELECT.from('reliefgrid.AssessmentRecords'))
      let checked = 0
      for (const rec of recs) for (const line of await linesOf(rec.ID)) {
        assert.equal(line.state, recalculate(rec, line), `${rec.trigger} ${line.standardCode}`)
        checked++
      }
      assert.ok(checked > 50)
    })

    it('leaves earlier records exactly as written when settings, stock and population change', async () => {
      const first = (await records(campID))[1]
      const before = { record: first, lines: await linesOf(first.ID) }
      await changeSettings({ ...DEFAULTS, warningDays: 6, targetDays: 10 })
      await count(stock.WATER, 9000)
      await editCamp(campID, { headcount: 175 })
      const after = {
        record: (await cds.run(SELECT.one.from('reliefgrid.AssessmentRecords').where({ ID: first.ID }))),
        lines: await linesOf(first.ID)
      }
      assert.deepEqual(after, before)
      await changeSettings(DEFAULTS)
    })

    it('marks requests created before history was recorded, and never fills their basis in', async () => {
      const { data } = await GET(`${camp(campID)}/requests?$top=1`, coordinator)
      const ID = data.value[0].ID
      await cds.run(UPDATE('reliefgrid.Requests', ID).with({ basisAssessment_ID: null, basisRequirement: null, basisSource: null,
        basisSettingsVersion: null, basisTargetDays: null, basisCalculatedAt: null }))
      const { data: r } = await GET(`${R}/Requests(${ID})`, coordinator)
      assert.equal(r.raisedBeforeB4, true)
      assert.equal(r.basisAssessment_ID, null)
    })
  })

  describe('recording and the business operation are one transaction', () => {
    let fail = false
    before(() => {
      cds.db.before('CREATE', 'reliefgrid.AssessmentRecords', () => {
        if (fail) { fail = false; throw new Error('injected assessment failure') }
      })
    })
    const failing = async (label, attempt, unchanged) => {
      const before = await unchanged()
      fail = true
      const res = await outcome(attempt())
      assert.equal(fail, false, `${label}: the assessment write was reached`)
      assert.ok(!ok(res.status), `${label} answered ${res.status}`)
      assert.deepEqual(await unchanged(), before, `${label}: business data changed`)
    }

    it('rolls back a stock count', async () => {
      await failing('count', () => count(stock.SOAP, 1234), () => cds.run(SELECT.one.from('reliefgrid.Stock').where({ ID: stock.SOAP.ID })))
    })
    it('rolls back request generation', async () => {
      const other = await createCamp({ name: 'Rollback Camp', headcount: 40 })
      const lines = await stockOf(other)
      await count(lines.WATER, 0)
      await failing('raise', () => POST(`${camp(other)}/ReliefService.raiseRequests`, {}, coordinator),
        () => cds.run(SELECT.from('reliefgrid.Requests').where({ camp_ID: other })))
    })
    it('rolls back a delivery', async () => {
      const { data } = await GET(`${D}/Requests?$filter=campName eq 'History Camp' and standard_code eq 'WATER'`, donor)
      const { data: p } = await POST(`${D}/Requests(${data.value[0].ID})/DonorService.pledge`, { donor: 'Rollback Donor', quantity: 10 }, donor)
      await failing('delivery', () => POST(`${R}/Pledges(${p.ID})/ReliefService.confirmDelivery`, { receivedQuantity: 10 }, coordinator),
        async () => [await cds.run(SELECT.one.from('reliefgrid.Pledges').where({ ID: p.ID })), await cds.run(SELECT.from('reliefgrid.Stock').where({ camp_ID: campID }))])
    })
    it('rolls back a settings change and its audit entry', async () => {
      await failing('settings', async () => POST(`${SETTINGS}/ReliefService.change`, { ...DEFAULTS, criticalDays: 3, reason: 'must roll back', version: await version() }, admin),
        async () => [await cds.run(SELECT.from('reliefgrid.PlanningSettings')), await cds.run(SELECT.from('reliefgrid.PlanningSettingsChanges'))])
    })
    it('rolls back a population change', async () => {
      await POST(`${camp(campID)}/ReliefService.draftEdit`, { PreserveChanges: true }, coordinator)
      const key = `${R}/Camps(ID=${campID},IsActiveEntity=false)`
      await PATCH(key, { headcount: 999 }, coordinator)
      await failing('population', () => POST(`${key}/ReliefService.draftActivate`, {}, coordinator),
        () => cds.run(SELECT.one.from('reliefgrid.Camps').columns('headcount').where({ ID: campID })))
    })
    it('rolls back a camp registration', async () => {
      const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
      const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
      await PATCH(key, { name: 'Never Registered', district: 'D', region: 'R', hazard_code: 'FLOOD', headcount: 5 }, coordinator)
      await failing('registration', () => POST(`${key}/ReliefService.draftActivate`, {}, coordinator),
        () => cds.run(SELECT.from('reliefgrid.Camps').where({ name: 'Never Registered' })))
    })
  })

  describe('history cannot be altered, and donors cannot see it', () => {
    it('refuses every write route, for every role', async () => {
      const [rec] = await records(campID)
      const [line] = await linesOf(rec.ID)
      const { data: reqs } = await GET(`${camp(campID)}/requests?$top=1`, coordinator)
      const request = reqs.value[0]
      const json = { headers: { 'content-type': 'application/json' } }
      for (const user of [admin, coordinator]) {
        const routes = [
          ['POST record', () => POST(`${R}/AssessmentRecords`, { camp_ID: campID, assessedAt: new Date().toISOString(), trigger: 'BASELINE' }, user)],
          ['PATCH record', () => PATCH(`${R}/AssessmentRecords(${rec.ID})`, { label: 'rewritten' }, user)],
          ['PUT record', () => PUT(`${R}/AssessmentRecords(${rec.ID})`, { ...rec, label: 'rewritten' }, user)],
          ['DELETE record', () => axios.delete(`${R}/AssessmentRecords(${rec.ID})`, user)],
          ['POST line', () => POST(`${R}/AssessmentRecordLines`, { record_ID: rec.ID, standardCode: 'WATER', state: 'MET' }, user)],
          ['PATCH line', () => PATCH(`${R}/AssessmentRecordLines(${line.ID})`, { state: 'MET' }, user)],
          ['DELETE line', () => axios.delete(`${R}/AssessmentRecordLines(${line.ID})`, user)],
          ['POST line via navigation', () => POST(`${R}/AssessmentRecords(${rec.ID})/lines`, { standardCode: 'WATER', state: 'MET' }, user)],
          ['PATCH via request basis', () => PATCH(`${R}/Requests(${request.ID})/basisAssessment`, { label: 'rewritten' }, user)],
          ['PATCH request basis', () => PATCH(`${R}/Requests(${request.ID})`, { basisRequirement: 1 }, user)],
          ['$batch PATCH', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'PATCH', url: `AssessmentRecords(${rec.ID})`, headers: { 'content-type': 'application/json' }, body: { label: 'x' } }] }, { ...user, ...json })],
          ['$batch DELETE line', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'DELETE', url: `AssessmentRecordLines(${line.ID})` }] }, { ...user, ...json })]
        ]
        for (const [label, attempt] of routes) {
          const before = await allHistory()
          const reqBefore = await cds.run(SELECT.one.from('reliefgrid.Requests').where({ ID: request.ID }))
          const res = await outcome(attempt())
          const statuses = res.data?.responses ? res.data.responses.map(r => r.status) : [res.status]
          assert.ok(statuses.every(s => !ok(s)), `${user.auth.username} ${label} answered ${statuses}`)
          assert.deepEqual(await allHistory(), before, `${user.auth.username} ${label} changed history`)
          assert.deepEqual(await cds.run(SELECT.one.from('reliefgrid.Requests').where({ ID: request.ID })), reqBefore)
        }
      }
    })

    it('declares the history read-only, without actions', () => {
      for (const name of ['ReliefService.AssessmentRecords', 'ReliefService.AssessmentRecordLines']) {
        const e = cds.model.definitions[name]
        assert.equal(e['@readonly'], true, name)
        assert.equal(Object.keys(e.actions ?? {}).length, 0, name)
      }
    })

    it('lets coordinators read the history and keeps donors out of it', async () => {
      await GET(`${R}/AssessmentRecords?$expand=lines`, coordinator)
      for (const p of [`${R}/AssessmentRecords`, `${R}/AssessmentRecordLines`]) assert.equal((await outcome(GET(p, donor))).status, 403, p)
      const { data } = await GET(`${D}/$metadata`, donor)
      assert.doesNotMatch(data, /AssessmentRecord|basisAssessment|basisRequirement|raisedBeforeB4/)
      const res = await outcome(GET(`${D}/Requests?$expand=basisAssessment`, donor))
      assert.ok(!ok(res.status))
    })
  })
})
