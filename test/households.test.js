process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH, PUT, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const admin2 = { auth: { username: 'admin2', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`
const SIZE = `${R}/HouseholdAssumption('CURRENT')`
const outcome = p => p.then(r => r, e => e.response ?? e)
const ok = s => s >= 200 && s < 300
const code = res => res.data?.error?.code
const day = offset => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10)
const table = (name, where = {}) => cds.run(SELECT.from(`reliefgrid.${name}`).where(where))

async function createCamp(name, headcount, households) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount, households }, coordinator)
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
const stockOf = async campID => Object.fromEntries((await GET(`${camp(campID)}/stock`, coordinator)).data.value.map(s => [s.standard_code, s]))
const count = async (campID, c, quantity) => POST(`${R}/Stock(${(await stockOf(campID))[c].ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(c) ? { functionalUnits: quantity } : {}) }, coordinator)
const info = async campID => (await GET(`${camp(campID)}/householdInfo`, coordinator)).data
const assumption = async () => (await GET(SIZE, coordinator)).data
// B4.3 governance: a change is proposed by one Administrator and approved by another
const proposeSize = async (householdSize, reason = 'New registration data', user = admin, version) =>
  POST(`${SIZE}/ReliefService.proposeSize`, { householdSize, reason, version: version ?? (await assumption()).version }, user)
const PROPOSAL = ID => `${R}/HouseholdSizeProposals(${ID})`
const approveSize = (ID, user = admin2) => POST(`${PROPOSAL(ID)}/ReliefService.approve`, {}, user)
const changeSize = async (householdSize, reason = 'New registration data', user = admin, version) => {
  const { data: p } = await proposeSize(householdSize, reason, user, version)
  return approveSize(p.ID, user === admin2 ? admin : admin2)
}
const records = campID => cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }).orderBy('assessedAt'))
const lineOf = async (recordID, standardCode) => (await table('AssessmentRecordLines', { record_ID: recordID, standardCode }))[0]
const proposeTarget = (campID, body = {}) => POST(`${camp(campID)}/ReliefService.proposeTarget`,
  { standard: 'CONTAINER', targetPerPerson: 1, reason: 'Two sites, longer walks', source: 'WASH cluster note', reviewDate: day(90), ...body }, coordinator)
const approve = async ID => {
  const d = (await GET(`${R}/CampDecisions(${ID})`, admin)).data
  return POST(`${R}/CampDecisions(${ID})/ReliefService.approve`, { version: d.version }, { ...admin, headers: { 'if-match': d['@odata.etag'] } })
}

describe('B4.3 households', () => {
  describe('estimated and recorded households', () => {
    it('estimates households from the headcount, rounded up, and labels the figure as an estimate', async () => {
      const c = await createCamp('Estimate Camp', 23)
      const h = await info(c)
      assert.equal(h.recordedHouseholds, null, 'an estimate is never stored as a count')
      assert.equal(h.estimatedHouseholds, 5, '23 people at 5 per household, rounded up')
      assert.equal(h.householdsUsed, 5)
      assert.equal(h.householdBasis, 'ESTIMATED')
      assert.equal(h.householdBasisText, 'Estimated')
      const { CONTAINER } = await stockOf(c)
      assert.equal(Number(CONTAINER.required), 10, '2 containers for each of 5 households')
      assert.equal(CONTAINER.targetBasis, 'HOUSEHOLD')
      assert.equal(CONTAINER.targetBasisText, 'Households (estimated)')
      assert.equal(CONTAINER.perPerson, null, 'no per-person figure is shown for a household line')
      assert.equal(CONTAINER.referencePerPerson, null)
    })

    it('does not round a headcount that divides exactly, and rounds one person over up', async () => {
      assert.equal((await info(await createCamp('Exact Camp', 25))).estimatedHouseholds, 5)
      assert.equal((await info(await createCamp('One Over Camp', 26))).estimatedHouseholds, 6)
      assert.equal((await info(await createCamp('One Person Camp', 1))).estimatedHouseholds, 1)
    })

    it('uses a recorded count as it is, and never presents it as an estimate', async () => {
      const c = await createCamp('Recorded Camp', 23, 4)
      const h = await info(c)
      assert.equal(h.recordedHouseholds, 4)
      assert.equal(h.estimatedHouseholds, null, 'no estimate beside a real count')
      assert.equal(h.householdBasis, 'RECORDED')
      const { CONTAINER } = await stockOf(c)
      assert.equal(Number(CONTAINER.required), 8)
      assert.equal(CONTAINER.targetBasisText, 'Households (recorded)')
    })

    it('goes back to an estimate when the count is removed', async () => {
      const c = await createCamp('Cleared Camp', 23, 4)
      await editCamp(c, { households: null })
      const h = await info(c)
      assert.equal(h.recordedHouseholds, null)
      assert.equal(h.estimatedHouseholds, 5)
    })

    it('refuses impossible counts and keeps what was there', async () => {
      const c = await createCamp('Invalid Camp', 23, 4)
      for (const [data, expected] of [
        [{ households: 24 }, 'HOUSEHOLDS_EXCEED_HEADCOUNT'],
        [{ headcount: 3 }, 'HOUSEHOLDS_EXCEED_HEADCOUNT'],
        [{ households: 0 }, null],
        [{ households: -2 }, null]
      ]) {
        const res = await outcome(editCamp(c, data))
        assert.equal(res.status, 400, JSON.stringify(data))
        if (expected) assert.equal(code(res), expected, JSON.stringify(data))
      }
      assert.equal((await info(c)).recordedHouseholds, 4)
      const fraction = await outcome(editCamp(c, { households: 1.5 }))
      assert.equal(fraction.status, 400)
      assert.equal(code(fraction), 'HOUSEHOLDS_WHOLE_NUMBER')
      assert.equal((await info(c)).recordedHouseholds, 4)
    })

    it('a camp without people has no estimate and stays not assessed', async () => {
      const c = await createCamp('Empty Camp', 0)
      const h = await info(c)
      assert.equal(h.estimatedHouseholds, null)
      assert.equal(h.householdsUsed, null)
      assert.equal((await stockOf(c)).CONTAINER.assessment, 'NOT_ASSESSED')
    })
  })

  describe('classification', () => {
    it('classifies containers against 2 per household, with the B3 thresholds and strict comparisons', async () => {
      const c = await createCamp('Classify Camp', 23)
      assert.equal((await stockOf(c)).CONTAINER.assessment, 'NOT_COUNTED')
      for (const [quantity, state, shortfall, pct] of [[0, 'CRITICAL', 10, 0], [4, 'CRITICAL', 6, 40], [5, 'ATTENTION', 5, 50], [8, 'ATTENTION', 2, 80], [9, 'MET', 1, 90], [10, 'MET', 0, 100]]) {
        await count(c, 'CONTAINER', quantity)
        const { CONTAINER } = await stockOf(c)
        assert.equal(CONTAINER.assessment, state, String(quantity))
        assert.equal(Number(CONTAINER.shortfall), shortfall, String(quantity))
        assert.equal(Number(CONTAINER.coveragePct), pct, String(quantity))
      }
    })

    it('changes no other indicator', async () => {
      const c = await createCamp('Other Lines Camp', 23)
      const lines = await stockOf(c)
      for (const code of ['WATER', 'FOOD', 'SOAP', 'LAUNDRY', 'SHELTER', 'TOILET', 'TAP']) {
        assert.equal(lines[code].targetBasis, code === 'FOOD' ? 'FOOD_ENERGY' : 'REFERENCE_FIGURE', code)
        assert.equal(Number(lines[code].required).toFixed(1), (23 * Number(lines[code].referencePerPerson)).toFixed(1), code)
      }
      assert.equal(Number(lines.WATER.required), 345)
      assert.equal(lines.NET.assessment, 'NOT_DECIDED', 'applicability is unchanged')
    })

    it('missing household information never affects an unrelated indicator', async () => {
      const c = await createCamp('Unrelated Camp', 100)
      await count(c, 'WATER', 0)
      assert.equal((await stockOf(c)).WATER.assessment, 'CRITICAL')
    })

    it('an applicability decision stays authoritative for containers', async () => {
      const c = await createCamp('Container Applicability Camp', 23)
      await count(c, 'CONTAINER', 0)
      const { data: d } = await POST(`${camp(c)}/ReliefService.proposeApplicability`,
        { standard: 'CONTAINER', applicability: 'NOT_APPLICABLE', reason: 'Issued by the host', source: 'Host letter', reviewDate: day(60) }, coordinator)
      await approve(d.ID)
      const { CONTAINER } = await stockOf(c)
      assert.equal(CONTAINER.assessment, 'NOT_APPLICABLE')
      assert.equal(CONTAINER.required, null)
    })
  })

  describe('local targets take precedence (B4.2 unchanged)', () => {
    it('a local target in force stays a per-person figure, and withdrawal returns to households', async () => {
      const c = await createCamp('Local Over Households Camp', 23, 4)
      await count(c, 'CONTAINER', 10)
      assert.equal(Number((await stockOf(c)).CONTAINER.required), 8)
      const { data: t } = await proposeTarget(c)
      assert.equal(Number(t.referencePerPerson), 0.4, 'the stored baseline is unchanged')
      assert.equal(Number((await stockOf(c)).CONTAINER.required), 8, 'a proposal does not count')
      await approve(t.ID)
      let { CONTAINER } = await stockOf(c)
      assert.equal(CONTAINER.targetBasis, 'LOCAL_TARGET')
      assert.equal(Number(CONTAINER.perPerson), 1)
      assert.equal(Number(CONTAINER.required), 23, '23 people at the local target; the household count is not used')
      assert.equal(Number(CONTAINER.referencePerPerson), 0.4)
      const { data: w } = await POST(`${camp(c)}/ReliefService.proposeTargetWithdrawal`, { standard: 'CONTAINER', reason: 'Back to normal' }, coordinator)
      await approve(w.ID)
      ;({ CONTAINER } = await stockOf(c))
      assert.equal(CONTAINER.targetBasis, 'HOUSEHOLD')
      assert.equal(Number(CONTAINER.required), 8)
    })

    it('a local target on a household line flags outstanding requests even when its figure equals the old per-person equivalent', async () => {
      const c = await createCamp('Equivalent Camp', 23)
      await count(c, 'CONTAINER', 0)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = (await GET(`${camp(c)}/requests?$filter=standard_code eq 'CONTAINER'`, coordinator)).data.value
      const { data: t } = await proposeTarget(c, { targetPerPerson: 0.4 })
      await approve(t.ID)
      assert.equal((await GET(`${R}/Requests(${r.ID})`, coordinator)).data.review_code, 'PENDING')
    })

    it('leaves a per-person local target on another indicator alone', async () => {
      const c = await createCamp('Water Target Camp', 23)
      const { data: t } = await proposeTarget(c, { standard: 'WATER', targetPerPerson: 30 })
      await approve(t.ID)
      await changeSize(4)
      assert.equal(Number((await stockOf(c)).WATER.required), 690, 'a household change never touches a per-person target')
      await changeSize(5)
    })
  })

  describe('the household assumption', () => {
    after(async () => { if (Number((await assumption()).householdSize) !== 5) await changeSize(5, 'restore') })

    it('starts at 5, labelled apart from the planning settings', async () => {
      const a = await assumption()
      assert.equal(Number(a.householdSize), 5)
      assert.equal(a.ID, 'CURRENT')
      const { data: settings } = await GET(`${R}/PlanningSettings('CURRENT')`, coordinator)
      assert.ok(!('householdSize' in settings), 'not one of the B3 planning settings')
    })

    it('a change re-estimates camps without a count, leaves counted camps alone, and is logged', async () => {
      const estimated = await createCamp('Size Estimated Camp', 23)
      const counted = await createCamp('Size Counted Camp', 23, 4)
      for (const c of [estimated, counted]) await count(c, 'CONTAINER', 9)
      const before = await assumption()
      const res = await changeSize(4, 'Registration shows smaller families')
      assert.equal(res.data.version, before.version + 1)
      assert.ok(res.data.linesChanged >= 1)
      assert.equal((await info(estimated)).estimatedHouseholds, 6, '23 at 4 per household, rounded up')
      assert.equal(Number((await stockOf(estimated)).CONTAINER.required), 12)
      assert.equal((await stockOf(estimated)).CONTAINER.assessment, 'ATTENTION', '9 of 12 is 75 %')
      assert.equal((await info(counted)).recordedHouseholds, 4)
      assert.equal(Number((await stockOf(counted)).CONTAINER.required), 8)
      const [log] = await cds.run(SELECT.from('reliefgrid.HouseholdAssumptionChanges').where({ version: before.version + 1 }))
      assert.equal(log.proposedBy, 'admin', 'the initiator')
      assert.equal(log.changedBy, 'admin2', 'the approver')
      assert.ok(log.proposedAt && log.changedAt && log.proposal_ID)
      assert.equal(log.reason, 'Registration shows smaller families')
      assert.equal(Number(log.previousSize), 5)
      assert.equal(Number(log.newSize), 4)
      await changeSize(5, 'restore')
    })

    it('accepts an average with one decimal and rounds households up from it', async () => {
      const c = await createCamp('Average Size Camp', 23)
      await changeSize(4.6, 'Census average')
      assert.equal(Number((await assumption()).householdSize), 4.6)
      assert.equal((await info(c)).estimatedHouseholds, 5, '23 / 4.6 is exactly 5')
      await changeSize(4.5, 'Census average revised')
      assert.equal((await info(c)).estimatedHouseholds, 6, '23 / 4.5 is 5.1')
      await changeSize(5, 'restore')
    })

    it('divides exactly where binary fractions would not: 115 people at 4.6 is 25 households', async () => {
      const c = await createCamp('Binary Fraction Camp', 115)
      await changeSize(4.6, 'Census average')
      assert.equal((await info(c)).estimatedHouseholds, 25)
      await changeSize(5, 'restore')
    })

    it('rounds up correctly for every headcount and several sizes', () => {
      for (const size of [1, 2, 4.5, 4.6, 5, 7.3]) for (let n = 1; n <= 400; n++) {
        // the expression in CampHouseholds: whole tenths of a person, so no binary fraction is compared
        const tenths = Math.round(size * 10)
        const q = Math.trunc(n * 10.0 / tenths)
        const exact = BigInt(n * 10) % BigInt(tenths) === 0n
        const expected = Number(BigInt(n * 10) / BigInt(tenths)) + (exact ? 0 : 1)
        assert.equal(q + (q * tenths < n * 10 ? 1 : 0), expected, `${n} / ${size}`)
      }
    })

    it('refuses invalid values, a missing reason, an unchanged value and a stale version', async () => {
      for (const [value, expected] of [[0, 'HOUSEHOLD_SIZE_INVALID'], [0.5, 'HOUSEHOLD_SIZE_INVALID'], [-1, 'HOUSEHOLD_SIZE_INVALID'], [4.55, 'HOUSEHOLD_SIZE_INVALID']]) {
        const res = await outcome(changeSize(value))
        assert.equal(res.status, 400, String(value))
        assert.ok([expected, 'ASSERT_FORMAT', 'ASSERT_DATA_TYPE'].includes(code(res)), `${value}: ${code(res)}`)
      }
      assert.equal((await outcome(changeSize(4, ' '))).status, 400)
      const same = await outcome(changeSize(5))
      assert.equal(same.status, 409)
      assert.equal(code(same), 'HOUSEHOLD_UNCHANGED')
      const { version } = await assumption()
      const stale = await outcome(changeSize(4, 'stale', admin, version - 1))
      assert.equal(stale.status, 409)
      assert.equal(code(stale), 'HOUSEHOLD_CHANGED_MEANWHILE')
      assert.equal(Number((await assumption()).householdSize), 5)
    })

    it('of two simultaneous proposals only one is accepted, and only that one can take effect', async () => {
      const { version } = await assumption()
      const results = await Promise.all([outcome(proposeSize(4, 'first', admin, version)), outcome(proposeSize(6, 'second', admin2, version))])
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
      const accepted = results.find(r => r.status === 200).data
      assert.equal(code(results.find(r => r.status === 409)), 'HOUSEHOLD_PROPOSAL_PENDING')
      assert.equal((await table('HouseholdSizeProposals', { status: 'PENDING' })).length, 1)
      await approveSize(accepted.ID, accepted.proposedBy === 'admin' ? admin2 : admin)
      assert.equal((await assumption()).version, version + 1)
      await changeSize(5, 'restore')
    })
  })

  describe('assessment history', () => {
    it('keeps the household basis of every assessment, and a later change never rewrites it', async () => {
      const c = await createCamp('History Households Camp', 23)
      await count(c, 'CONTAINER', 6)
      const first = (await records(c)).at(-1)
      assert.equal(first.recordedHouseholds, null)
      assert.equal(first.estimatedHouseholds, 5)
      assert.equal(first.householdBasis, 'ESTIMATED')
      assert.equal(Number(first.householdSize), 5)
      assert.ok(first.householdAssumptionVersion >= 1)
      const line = await lineOf(first.ID, 'CONTAINER')
      assert.equal(line.requirementBasis, 'HOUSEHOLD')
      assert.equal(Number(line.perHousehold), 2)
      assert.equal(line.perPerson, null)
      assert.equal(Number(line.requirement), 10)
      assert.equal((await lineOf(first.ID, 'WATER')).perHousehold, null)
      const snapshot = [await table('AssessmentRecords', { ID: first.ID }), await table('AssessmentRecordLines', { record_ID: first.ID })]

      await changeSize(4, 'Smaller families')
      const afterSize = (await records(c)).at(-1)
      assert.equal(afterSize.trigger, 'HOUSEHOLD_ASSUMPTION_CHANGED')
      assert.equal(afterSize.estimatedHouseholds, 6)
      assert.equal(Number(afterSize.householdSize), 4)
      assert.deepEqual([await table('AssessmentRecords', { ID: first.ID }), await table('AssessmentRecordLines', { record_ID: first.ID })], snapshot, 'still 5 people per household, as calculated')
      await changeSize(5, 'restore')

      await editCamp(c, { households: 7 })
      const afterCount = (await records(c)).at(-1)
      assert.equal(afterCount.trigger, 'HOUSEHOLDS_CHANGED')
      assert.equal(afterCount.triggerText, 'Households changed')
      assert.equal(afterCount.recordedHouseholds, 7)
      assert.equal(afterCount.estimatedHouseholds, null)
      assert.equal(afterCount.householdBasis, 'RECORDED')
      assert.deepEqual([await table('AssessmentRecords', { ID: first.ID }), await table('AssessmentRecordLines', { record_ID: first.ID })], snapshot, 'the earlier assessment is unchanged')
    })

    it('the assessment history screen names household changes in plain words', async () => {
      const c = await createCamp('History Words Camp', 23)
      await editCamp(c, { households: 4 })
      const { data } = await GET(`${camp(c)}/assessmentRecords?$orderby=assessedAt desc&$top=1&$expand=lines`, coordinator)
      assert.equal(data.value[0].triggerText, 'Households changed')
      assert.equal(data.value[0].lines.find(l => l.standardCode === 'CONTAINER').requirementBasisText, 'Households')
    })

    it('rolls a size change back completely when the assessment cannot be written', async () => {
      const c = await createCamp('Rollback Size Camp', 23)
      let fail = true
      cds.db.before('CREATE', 'reliefgrid.AssessmentRecords', () => { if (fail) { fail = false; throw new Error('injected failure') } })
      const before = await assumption()
      const logs = (await table('HouseholdAssumptionChanges')).length
      const recs = (await records(c)).length
      const { data: p } = await proposeSize(3, 'will fail')
      const res = await outcome(approveSize(p.ID))
      assert.ok(res.status >= 400, String(res.status))
      assert.equal(fail, false, 'the failure was injected')
      assert.equal(Number((await assumption()).householdSize), Number(before.householdSize))
      assert.equal((await assumption()).version, before.version)
      assert.equal((await table('HouseholdAssumptionChanges')).length, logs)
      assert.equal((await records(c)).length, recs)
      const [still] = await table('HouseholdSizeProposals', { ID: p.ID })
      assert.equal(still.status, 'PENDING', 'the failed approval left the proposal waiting')
      assert.equal((await assumption()).pendingProposal_ID, p.ID)
      await POST(`${PROPOSAL(p.ID)}/ReliefService.withdraw`, {}, admin)
    })
  })

  describe('requests and pledges', () => {
    it('raises container requests from households and keeps that basis', async () => {
      const c = await createCamp('Household Request Camp', 23)
      await count(c, 'CONTAINER', 2)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = (await GET(`${camp(c)}/requests?$filter=standard_code eq 'CONTAINER'`, coordinator)).data.value
      assert.equal(Number(r.quantity), 8, '2 per household for 5 households, less 2 on hand')
      assert.equal(Number(r.basisRequirement), 10)
      assert.match(r.basisSource, /^2 containers per household for 5 estimated households at 5 people per household/)
    })

    it('a household change never changes a request quantity, pledge, delivery or stock; it only opens a review', async () => {
      const c = await createCamp('Household Pledge Camp', 23)
      await count(c, 'CONTAINER', 2)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = (await GET(`${camp(c)}/requests?$filter=standard_code eq 'CONTAINER'`, coordinator)).data.value
      const { data: p } = await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Household Donor', quantity: 3 }, donor)
      await POST(`${R}/Pledges(${p.ID})/ReliefService.confirmDelivery`, { receivedQuantity: 1 }, coordinator)
      // everything a review never touches: the request's quantities, status and basis, its pledges and deliveries
      const KEPT = ['ID', 'quantity', 'pledgedQuantity', 'deliveredQuantity', 'status_code', 'priority_code', 'neededBy', 'basisAssessment_ID',
        'basisRequirement', 'basisSource', 'basisSettingsVersion', 'basisTargetDays', 'basisCalculatedAt', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy']
      const snapshot = async () => [(await table('Requests', { camp_ID: c })).map(q => Object.fromEntries(KEPT.map(k => [k, q[k]]))), await table('Pledges', { request_ID: r.ID })]
      const quantity = (await stockOf(c)).CONTAINER.quantity
      let before = await snapshot()
      await editCamp(c, { households: 3 })
      assert.deepEqual(await snapshot(), before, 'recording households changed nothing on the request, its pledges or deliveries')
      assert.equal((await GET(`${R}/Requests(${r.ID})`, coordinator)).data.review_code, 'PENDING', 'the requirement went from 10 to 6 containers')
      // the coordinator's own decision on the review is recorded on the request, as in B4.1
      await POST(`${R}/Requests(${r.ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'Still needed' }, coordinator)
      await editCamp(c, { households: null })
      await POST(`${R}/Requests(${r.ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'Still needed' }, coordinator)
      before = await snapshot()
      await changeSize(4, 'Smaller families')
      assert.deepEqual(await snapshot(), before, 'a household-size change changed nothing on the request, its pledges or deliveries')
      assert.equal((await GET(`${R}/Requests(${r.ID})`, coordinator)).data.review_code, 'PENDING', 'the estimate went from 5 to 6 households')
      assert.equal((await stockOf(c)).CONTAINER.quantity, quantity)
      await changeSize(5, 'restore')
    })
  })

  describe('security', () => {
    it('only an Administrator changes the household size, and donors see none of it', async () => {
      const denied = await outcome(proposeSize(4, 'not allowed', coordinator, 1))
      assert.equal(denied.status, 403)
      assert.equal((await outcome(POST(`${SIZE}/ReliefService.proposeSize`, { householdSize: 4, reason: 'x', version: 1 }, donor))).status, 403)
      assert.equal((await outcome(POST(`${SIZE}/ReliefService.changeSize`, { householdSize: 4, reason: 'x', version: 1 }, admin))).status >= 400, true, 'the one-person change no longer exists')
      for (const p of [SIZE, `${R}/HouseholdAssumptionChanges`, `${R}/HouseholdSizeProposals`, `${R}/CampHouseholds`]) assert.equal((await outcome(GET(p, donor))).status, 403, p)
      const { data: md } = await GET(`${D}/$metadata`, donor)
      assert.doesNotMatch(md, /CampHouseholds|HouseholdAssumption|HouseholdSizeProposals|recordedHouseholds|estimatedHouseholds|householdSize|householdBasis/, 'donors can read reference figures, never camp households or the assumption')
    })

    it('the unqualified action, entity writes, $batch and estimates sent by a client are all refused', async () => {
      const c = await createCamp('Household Security Camp', 23)
      const { version } = await assumption()
      const before = async () => [await table('HouseholdAssumption'), await table('HouseholdAssumptionChanges'), await table('HouseholdSizeProposals')]
      const start = await before()
      const json = { headers: { 'content-type': 'application/json' } }
      const routes = [
        ['unqualified action as coordinator', () => POST(`${SIZE}/proposeSize`, { householdSize: 4, reason: 'x', version }, coordinator)],
        ['POST proposal', () => POST(`${R}/HouseholdSizeProposals`, { proposedSize: 3, reason: 'x', basedOnVersion: version, proposedBy: 'x', proposedAt: new Date().toISOString() }, admin)],
        ['$batch POST proposal', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'POST', url: 'HouseholdSizeProposals', headers: { 'content-type': 'application/json' }, body: { proposedSize: 3, reason: 'x', basedOnVersion: version } }] }, { ...admin, ...json })],
        ['PATCH assumption', () => PATCH(SIZE, { householdSize: 3 }, admin)],
        ['PUT assumption', () => PUT(SIZE, { householdSize: 3, version }, admin)],
        ['POST assumption', () => POST(`${R}/HouseholdAssumption`, { ID: 'OTHER', householdSize: 3 }, admin)],
        ['DELETE assumption', () => axios.delete(SIZE, admin)],
        ['POST log', () => POST(`${R}/HouseholdAssumptionChanges`, { changedBy: 'x', changedAt: new Date().toISOString(), reason: 'x' }, admin)],
        ['$batch PATCH', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'PATCH', url: "HouseholdAssumption('CURRENT')", headers: { 'content-type': 'application/json' }, body: { householdSize: 3 } }] }, { ...admin, ...json })]
      ]
      for (const [label, attempt] of routes) {
        const res = await outcome(attempt())
        const statuses = res.data?.responses ? res.data.responses.map(r => r.status) : [res.status]
        assert.ok(statuses.every(s => !ok(s)), `${label} answered ${statuses}`)
        assert.deepEqual(await before(), start, label)
      }
      assert.equal((await outcome(PATCH(`${R}/CampHouseholds(${c})`, { estimatedHouseholds: 99 }, admin))).status >= 400, true)
      assert.equal((await info(c)).estimatedHouseholds, 5)
    })
  })
})
