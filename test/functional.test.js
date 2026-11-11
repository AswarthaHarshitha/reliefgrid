process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`
const outcome = p => p.then(r => r, e => e.response ?? e)
const code = res => res.data?.error?.code
const day = offset => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10)
const table = (name, where = {}) => cds.run(SELECT.from(`reliefgrid.${name}`).where(where))

async function createCamp(name, headcount = 100) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}
const stockOf = async campID => Object.fromEntries((await GET(`${camp(campID)}/stock`, coordinator)).data.value.map(s => [s.standard_code, s]))
const count = async (campID, c, quantity, functionalUnits) =>
  POST(`${R}/Stock(${(await stockOf(campID))[c].ID})/ReliefService.recordCount`, functionalUnits === undefined ? { quantity } : { quantity, functionalUnits }, coordinator)
const health = async campID => (await GET(`${camp(campID)}/health`, coordinator)).data
const approve = async ID => {
  const d = (await GET(`${R}/CampDecisions(${ID})`, admin)).data
  return POST(`${R}/CampDecisions(${ID})/ReliefService.approve`, { version: d.version }, { ...admin, headers: { 'if-match': d['@odata.etag'] } })
}
const records = campID => cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }).orderBy('assessedAt'))
const lineOf = async (recordID, standardCode) => (await table('AssessmentRecordLines', { record_ID: recordID, standardCode }))[0]

describe('B4.5 functional toilets and taps', () => {
  describe('classification', () => {
    it('a total alone is neither met nor a gap: functionality not confirmed', async () => {
      const c = await createCamp('Total Only Camp')
      await count(c, 'TOILET', 4)
      const { TOILET } = await stockOf(c)
      assert.equal(TOILET.assessment, 'NOT_VERIFIED')
      assert.equal(TOILET.status, 'Functionality not confirmed')
      assert.equal(TOILET.cover, 'Not confirmed')
      assert.equal(TOILET.functionalityText, 'Not confirmed')
      assert.equal(Number(TOILET.quantity), 4, 'the recorded total stays visible')
      assert.equal(TOILET.functionalUnits, null)
      assert.equal(Number(TOILET.required), 5, 'the requirement is known')
      for (const f of ['severity', 'shortfall', 'coveragePct']) assert.equal(TOILET[f], null, f)
      const h = await health(c)
      assert.equal(h.notVerifiedIndicators, 1)
      assert.equal(h.assessedIndicators, 0, 'not counted as assessed, met or critical')
      assert.equal(h.criticalGaps, 0)
    })

    it('a certain crisis is never hidden: when even the total is below the critical threshold, the line is critical', async () => {
      const c = await createCamp('Certain Crisis Camp')
      await count(c, 'TOILET', 2)
      const { TOILET } = await stockOf(c)
      assert.equal(TOILET.assessment, 'CRITICAL')
      assert.equal(TOILET.status, 'Critical (functionality not confirmed)')
      assert.equal(Number(TOILET.shortfall), 3, 'from the total: the real shortfall can only be larger')
      assert.equal((await health(c)).criticalGaps, 1)
    })

    it('only functional units meet the requirement', async () => {
      const c = await createCamp('Functional Camp')
      for (const [total, functional, state, pct, shortfall] of [[6, 4, 'ATTENTION', 80, 1], [6, 5, 'MET', 100, 0], [6, 2, 'CRITICAL', 40, 3], [6, 0, 'CRITICAL', 0, 5]]) {
        await count(c, 'TOILET', total, functional)
        const { TOILET } = await stockOf(c)
        assert.equal(TOILET.assessment, state, `${functional} of ${total}`)
        assert.equal(Number(TOILET.coveragePct), pct)
        assert.equal(Number(TOILET.shortfall), shortfall)
        assert.equal(Number(TOILET.nonFunctionalUnits), total - functional)
        assert.equal(TOILET.functionalityText, 'Confirmed')
        assert.equal(TOILET.status, state === 'CRITICAL' ? 'Critical' : TOILET.status)
      }
    })

    it('a new count without functional units is not confirmed again', async () => {
      const c = await createCamp('Recount Camp')
      await count(c, 'TAP', 1, 1)
      assert.equal((await stockOf(c)).TAP.assessment, 'MET')
      await count(c, 'TAP', 1)
      const { TAP } = await stockOf(c)
      assert.equal(TAP.functionalUnits, null)
      assert.equal(TAP.assessment, 'NOT_VERIFIED')
    })

    it('taps state their flow assumption, and other indicators are unchanged', async () => {
      const { data: tap } = await GET(`${R}/Standards('TAP')`, coordinator)
      assert.equal(tap.countsFunctional, true)
      assert.match(tap.countingAssumption, /7\.5 litres per minute/)
      assert.match(tap.descr, /7\.5 L\/min/, 'the indicator itself says what a tap is assumed to deliver')
      const functional = (await GET(`${R}/Standards?$filter=countsFunctional eq true&$orderby=code`, coordinator)).data.value.map(s => s.code)
      assert.deepEqual(functional, ['TAP', 'TOILET'])
      const c = await createCamp('Other Indicators Camp')
      await count(c, 'WATER', 2000)
      const { WATER } = await stockOf(c)
      assert.equal(WATER.assessment, 'CRITICAL', '2000 litres for 100 people is 1.3 days')
      assert.equal(WATER.functionalityText, null)
    })
  })

  describe('validation', () => {
    it('refuses functional units above the total, fractions, negatives and functional units for other indicators', async () => {
      const c = await createCamp('Functional Validation Camp')
      await count(c, 'TOILET', 3, 3)
      for (const [line, body, expected] of [
        ['TOILET', { quantity: 4, functionalUnits: 5 }, 'FUNCTIONAL_EXCEEDS_TOTAL'],
        ['TOILET', { quantity: 4, functionalUnits: 1.5 }, 'FUNCTIONAL_WHOLE_NUMBER'],
        ['TOILET', { quantity: 4, functionalUnits: -1 }, 'FUNCTIONAL_WHOLE_NUMBER'],
        ['WATER', { quantity: 100, functionalUnits: 50 }, 'FUNCTIONAL_NOT_APPLICABLE']
      ]) {
        const res = await outcome(POST(`${R}/Stock(${(await stockOf(c))[line].ID})/ReliefService.recordCount`, body, coordinator))
        assert.equal(res.status, 400, JSON.stringify(body))
        assert.ok([expected, 'ASSERT_FORMAT', 'ASSERT_DATA_TYPE', 'ASSERT_RANGE'].includes(code(res)), `${JSON.stringify(body)}: ${code(res)}`)
      }
      const { TOILET } = await stockOf(c)
      assert.equal(Number(TOILET.quantity), 3)
      assert.equal(Number(TOILET.functionalUnits), 3)
    })

    it('records and refuses the same way through the camp page path the app uses', async () => {
      const c = await createCamp('Functional Navigation Camp')
      const via = async body => outcome(POST(`${camp(c)}/stock(${(await stockOf(c)).TOILET.ID})/ReliefService.recordCount`, body, coordinator))
      const refused = await via({ quantity: '6', functionalUnits: '7' })
      assert.equal(refused.status, 400)
      assert.equal(code(refused), 'FUNCTIONAL_EXCEEDS_TOTAL')
      const ok = await via({ quantity: '6', functionalUnits: '5' })
      assert.equal(ok.status, 200, JSON.stringify(ok.data))
      const { TOILET } = await stockOf(c)
      assert.equal(Number(TOILET.functionalUnits), 5)
      assert.equal(TOILET.assessment, 'MET')
    })
  })

  describe('requests, deliveries and history', () => {
    it('raises no request from an unconfirmed total, and says so; a certain crisis raises one from the total', async () => {
      const c = await createCamp('Functional Request Camp')
      await count(c, 'TOILET', 4)
      const res = await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      assert.equal(res.data.notVerified, 1)
      // the coordinator is told in words why the line was left out
      assert.match(res.headers['sap-messages'] ?? '', /1 toilet or tap lines whose functionality is not confirmed/)
      assert.ok((await GET(`${camp(c)}/requests?$filter=standard_code eq 'TOILET'`, coordinator)).data.value.length === 0)
      await count(c, 'TOILET', 1)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = (await GET(`${camp(c)}/requests?$filter=standard_code eq 'TOILET'`, coordinator)).data.value
      assert.equal(Number(r.quantity), 4)
      const c2 = await createCamp('Functional Request Camp 2')
      await count(c2, 'TOILET', 6, 3)
      await POST(`${camp(c2)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r2] = (await GET(`${camp(c2)}/requests?$filter=standard_code eq 'TOILET'`, coordinator)).data.value
      assert.equal(Number(r2.quantity), 2, 'from the 3 functional toilets, not the 6 recorded')
    })

    it('a delivery adds to the total; the functional count stays as counted until the next count', async () => {
      const c = await createCamp('Functional Delivery Camp')
      await count(c, 'TOILET', 3, 2)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = (await GET(`${camp(c)}/requests?$filter=standard_code eq 'TOILET'`, coordinator)).data.value
      const { data: p } = await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Toilet Donor', quantity: 3 }, donor)
      await POST(`${R}/Pledges(${p.ID})/ReliefService.confirmDelivery`, { receivedQuantity: 3 }, coordinator)
      const { TOILET } = await stockOf(c)
      assert.equal(Number(TOILET.quantity), 6)
      assert.equal(Number(TOILET.functionalUnits), 2, 'delivered units are not functional until counted as such')
      assert.equal(TOILET.assessment, 'CRITICAL')
    })

    it('every assessment keeps the functional count and whether it was confirmed; earlier records are unchanged', async () => {
      const c = await createCamp('Functional History Camp')
      await count(c, 'TOILET', 4)
      const first = (await records(c)).at(-1)
      const l1 = await lineOf(first.ID, 'TOILET')
      assert.equal(l1.state, 'NOT_VERIFIED')
      assert.equal(Number(l1.quantity), 4)
      assert.equal(l1.functionalUnits, null)
      assert.equal(l1.functionalityConfirmed, false)
      assert.equal((await lineOf(first.ID, 'WATER')).functionalityConfirmed, null)
      const snapshot = await table('AssessmentRecordLines', { record_ID: first.ID })
      await count(c, 'TOILET', 4, 3)
      const l2 = await lineOf((await records(c)).at(-1).ID, 'TOILET')
      assert.equal(l2.state, 'ATTENTION')
      assert.equal(Number(l2.functionalUnits), 3)
      assert.equal(l2.functionalityConfirmed, true)
      assert.deepEqual(await table('AssessmentRecordLines', { record_ID: first.ID }), snapshot)
    })
  })

  describe('with local targets and the response phase', () => {
    it('functional units are compared with the requirement in use: a local target or the first-phase figure', async () => {
      const c = await createCamp('Functional Phase Camp')
      await count(c, 'TOILET', 3, 2)
      assert.equal((await stockOf(c)).TOILET.assessment, 'CRITICAL', '2 of 5 is 40 %')
      const { data: f } = await POST(`${camp(c)}/ReliefService.proposePhase`,
        { responsePhase: 'FIRST_PHASE', reason: 'Rapid onset', effectiveFrom: day(0), reviewDate: day(30) }, coordinator)
      await approve(f.ID)
      assert.equal((await stockOf(c)).TOILET.assessment, 'MET', '2 functional toilets for 2 required in the first phase')
      const { data: t } = await POST(`${camp(c)}/ReliefService.proposeTarget`,
        { standard: 'TOILET', targetPerPerson: 0.04, reason: 'Safety', source: 'Protection cluster', reviewDate: day(60) }, coordinator)
      await approve(t.ID)
      assert.equal((await stockOf(c)).TOILET.assessment, 'ATTENTION', '2 functional toilets for 4 required at the local target')
    })
  })

  describe('exposure', () => {
    it('donors see no functional counts', async () => {
      const { data } = await GET(`${D}/$metadata`, donor)
      assert.doesNotMatch(data, /functionalUnits|functionalityText|nonFunctionalUnits|measuredQuantity/)
    })
  })
})
