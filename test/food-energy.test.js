process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`
const outcome = p => p.then(r => r, e => e.response ?? e)
const day = offset => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10)
const table = (name, where = {}) => cds.run(SELECT.from(`reliefgrid.${name}`).where(where))

async function createCamp(name, headcount, rationKcalPerPack) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount, rationKcalPerPack }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}
async function editCamp(ID, data) {
  await POST(`${camp(ID)}/ReliefService.draftEdit`, { PreserveChanges: true }, coordinator)
  const key = `${R}/Camps(ID=${ID},IsActiveEntity=false)`
  try {
    await PATCH(key, data, coordinator)
    return await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  } catch (e) {
    await axios.delete(key, coordinator).catch(() => {})
    throw e
  }
}
const food = async campID => (await GET(`${camp(campID)}/stock?$filter=standard_code eq 'FOOD'`, coordinator)).data.value[0]
const count = async (campID, quantity) => POST(`${R}/Stock(${(await food(campID)).ID})/ReliefService.recordCount`, { quantity }, coordinator)
const requestsOf = async campID => (await GET(`${camp(campID)}/requests?$filter=standard_code eq 'FOOD'&$expand=currentReview`, coordinator)).data.value
const records = campID => cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }).orderBy('assessedAt'))
const approve = async ID => {
  const d = (await GET(`${R}/CampDecisions(${ID})`, admin)).data
  return POST(`${R}/CampDecisions(${ID})/ReliefService.approve`, { version: d.version }, { ...admin, headers: { 'if-match': d['@odata.etag'] } })
}

describe('B5 food energy planning (decision D10, option A)', () => {
  describe('the calculation', () => {
    it('without a recorded pack energy, assumes 2,100 kcal per pack, says so, and keeps the earlier result', async () => {
      const c = await createCamp('Assumed Energy Camp', 100)
      await count(c, 300)
      const f = await food(c)
      assert.equal(f.targetBasis, 'FOOD_ENERGY')
      assert.equal(f.targetBasisText, 'Food energy (assumed kcal)')
      assert.equal(Number(f.perPerson), 1, '2,100 kcal per person per day at 2,100 kcal per pack is one pack')
      assert.equal(Number(f.required), 100)
      assert.equal(Number(f.daysOfCover), 3, '300 packs for 100 people at one pack each per day')
      assert.equal(f.assessment, 'ATTENTION')
    })

    it('days of cover = (packs × kcal per pack) ÷ (people × 2,100)', async () => {
      const c = await createCamp('Recorded Energy Camp', 100, 2800)
      await count(c, 300)
      const f = await food(c)
      assert.equal(f.targetBasisText, 'Food energy (recorded kcal)')
      assert.equal(Number(f.perPerson), 0.75, '2,100 / 2,800')
      assert.equal(Number(f.required), 75)
      assert.equal(Number(f.daysOfCover), 4, '300 × 2,800 / (100 × 2,100) = 4')
      assert.equal(Number(f.referencePerPerson), 0.75, 'the reference in packs follows the energy of the pack')
    })

    it('a pack with less energy raises the requirement, and the shortfall follows', async () => {
      const c = await createCamp('Small Pack Camp', 70, 1500)
      await count(c, 98)
      const f = await food(c)
      assert.equal(Number(f.required), 98, '70 × 2,100 / 1,500')
      assert.equal(Number(f.daysOfCover), 1)
      assert.equal(f.assessment, 'CRITICAL')
      const s = Number(f.shortfall)
      assert.equal(s, 98 * 7 - 98, 'seven days of supply less the packs on hand')
    })

    it('only food is affected; the other indicators keep their figures', async () => {
      const c = await createCamp('Only Food Camp', 100, 3000)
      const lines = Object.fromEntries((await GET(`${camp(c)}/stock`, coordinator)).data.value.map(s => [s.standard_code, s]))
      assert.equal(Number(lines.WATER.perPerson), 15)
      assert.equal(lines.WATER.targetBasisText, 'Reference figure')
      assert.equal(Number(lines.SOAP.perPerson), Number((250 / 30).toFixed(6)))
    })

    it('refuses an energy that is not a whole number of kcal, at least 1', async () => {
      const c = await createCamp('Invalid Energy Camp', 50)
      for (const value of [0, -5, 2100.5]) {
        const res = await outcome(editCamp(c, { rationKcalPerPack: value }))
        assert.ok(res.status >= 400, String(value))
      }
      assert.equal((await GET(camp(c), coordinator)).data.rationKcalPerPack, null)
    })
  })

  describe('precedence', () => {
    it('B4.2: an approved local target in packs per person replaces the energy figure, and the energy figure stays visible as the reference', async () => {
      const c = await createCamp('Food Target Camp', 100, 2800)
      await count(c, 300)
      const { data: t } = await POST(`${camp(c)}/ReliefService.proposeTarget`,
        { standard: 'FOOD', targetPerPerson: 1.2, reason: 'Heavy labour', source: 'Food security cluster', reviewDate: day(90) }, coordinator)
      await approve(t.ID)
      const f = await food(c)
      assert.equal(f.targetBasis, 'LOCAL_TARGET')
      assert.equal(Number(f.perPerson), 1.2)
      assert.equal(Number(f.required), 120)
      assert.equal(Number(f.referencePerPerson), 0.75)
    })

    it('B4.1: food decided not applicable stays not applicable, whatever the pack energy', async () => {
      const c = await createCamp('Food Not Applicable Camp', 100, 2800)
      const { data: d } = await POST(`${camp(c)}/ReliefService.proposeApplicability`,
        { standard: 'FOOD', applicability: 'NOT_APPLICABLE', reason: 'Cooked meals by the host', source: 'Host letter', reviewDate: day(60) }, coordinator)
      await approve(d.ID)
      const f = await food(c)
      assert.equal(f.assessment, 'NOT_APPLICABLE')
      assert.equal(f.required, null)
    })
  })

  describe('history and requests', () => {
    it('every assessment keeps the pack energy and whether it was recorded or assumed; a change is its own record and never rewrites an earlier one', async () => {
      const c = await createCamp('History Energy Camp', 100)
      await count(c, 300)
      const first = (await records(c)).at(-1)
      assert.equal(first.rationKcalPerPack, 2100)
      assert.equal(first.rationKcalBasis, 'ASSUMED')
      const [line] = await table('AssessmentRecordLines', { record_ID: first.ID, standardCode: 'FOOD' })
      assert.equal(line.requirementBasis, 'FOOD_ENERGY')
      assert.equal(line.kcalPerPersonDay, 2100)
      assert.equal(line.kcalPerUnit, 2100)
      const snapshot = [await table('AssessmentRecords', { ID: first.ID }), await table('AssessmentRecordLines', { record_ID: first.ID })]
      await editCamp(c, { rationKcalPerPack: 2400 })
      const after = (await records(c)).at(-1)
      assert.equal(after.trigger, 'RATION_ENERGY_CHANGED')
      assert.equal(after.triggerText, 'Ration energy changed')
      assert.equal(after.rationKcalPerPack, 2400)
      assert.equal(after.rationKcalBasis, 'RECORDED')
      assert.deepEqual([await table('AssessmentRecords', { ID: first.ID }), await table('AssessmentRecordLines', { record_ID: first.ID })], snapshot)
    })

    it('a request keeps the energy basis it was raised with', async () => {
      const c = await createCamp('Energy Request Camp', 100, 2800)
      await count(c, 100)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = await requestsOf(c)
      assert.equal(Number(r.basisRequirement), 75)
      assert.match(r.basisSource, /^Food energy: 2100 kcal per person per day at 2800 kcal per pack \(recorded for the camp\), 0\.75 rations per person per day/)
    })

    it('recording the pack energy flags outstanding food requests whose requirement changed, and changes nothing else', async () => {
      const c = await createCamp('Flag Energy Camp', 100)
      await count(c, 100)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = await requestsOf(c)
      const { data: p } = await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Energy Donor', quantity: 10 }, donor)
      const KEPT = ['quantity', 'pledgedQuantity', 'deliveredQuantity', 'status_code', 'basisSource', 'basisRequirement', 'modifiedAt']
      const pledged = (await requestsOf(c))[0]
      const before = Object.fromEntries(KEPT.map(k => [k, pledged[k]]))
      const pledges = await table('Pledges', { ID: p.ID })
      await editCamp(c, { rationKcalPerPack: 2800 })
      const [flagged] = await requestsOf(c)
      assert.equal(flagged.review_code, 'PENDING')
      assert.equal(flagged.currentReview.cause, 'RATION_KCAL')
      assert.equal(flagged.currentReview.causeText, 'Ration energy changed')
      assert.equal(flagged.currentReview.detail, 'Ration energy changed from none recorded (2,100 kcal assumed) to 2800 kcal per pack: requirement 100 rations → 75 rations')
      assert.deepEqual(Object.fromEntries(KEPT.map(k => [k, flagged[k]])), before)
      assert.deepEqual(await table('Pledges', { ID: p.ID }), pledges)
      assert.equal((await GET(`${D}/Requests`, donor)).data.value.some(o => o.ID === r.ID), false, 'not offered to donors until reviewed')
    })

    it('recording the assumed energy itself changes no requirement and flags nothing', async () => {
      const c = await createCamp('Same Energy Camp', 100)
      await count(c, 100)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      await editCamp(c, { rationKcalPerPack: 2100 })
      assert.equal((await requestsOf(c))[0].review_code, null)
      assert.equal((await food(c)).targetBasisText, 'Food energy (recorded kcal)')
    })
  })

  describe('access', () => {
    it('donors never see the pack energy of a camp', async () => {
      const { data: md } = await GET(`${D}/$metadata`, donor)
      assert.doesNotMatch(md, /rationKcalPerPack|rationKcalBasis/)
    })
  })
})
