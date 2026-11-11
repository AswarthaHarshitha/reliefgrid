process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH, PUT, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const admin2 = { auth: { username: 'admin2', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`
const decision = ID => `${R}/CampDecisions(${ID})`

const outcome = p => p.then(r => r, e => e.response ?? e)
const ok = s => s >= 200 && s < 300
const code = res => res.data?.error?.code
const day = offset => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10)
const db = (entity, where) => cds.run(SELECT.from(`reliefgrid.${entity}`).where(where))
const one = async (entity, where) => (await db(entity, where))[0]

async function createCamp(name, headcount = 100) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}
const stockOf = async campID => Object.fromEntries((await GET(`${camp(campID)}/stock`, coordinator)).data.value.map(s => [s.standard_code, s]))
const count = async (campID, code, quantity) => POST(`${R}/Stock(${(await stockOf(campID))[code].ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(code) ? { functionalUnits: quantity } : {}) }, coordinator)
const proposeTarget = (campID, body = {}, user = coordinator) => POST(`${camp(campID)}/ReliefService.proposeTarget`,
  { standard: 'WATER', targetPerPerson: 30, reason: 'Hot season and no other water source', source: 'WASH cluster assessment, 3 Nov 2026', reviewDate: day(90), ...body }, user)
const proposeApplicability = (campID, body = {}, user = coordinator) => POST(`${camp(campID)}/ReliefService.proposeApplicability`,
  { standard: 'WATER', applicability: 'NOT_APPLICABLE', reason: 'Piped supply', source: 'Utility letter', reviewDate: day(90), ...body }, user)
const getDecision = async ID => (await GET(decision(ID), admin)).data
const act = async (ID, action, body, user, etag) => {
  const tag = etag ?? (await GET(decision(ID), admin)).data['@odata.etag']
  return POST(`${decision(ID)}/ReliefService.${action}`, body, { ...user, headers: { 'if-match': tag } })
}
const approve = async (ID, user = admin) => act(ID, 'approve', { version: (await getDecision(ID)).version }, user)
const reject = async (ID, reason = 'Not justified', user = admin) => act(ID, 'rejectProposal', { reason, version: (await getDecision(ID)).version }, user)
const review = async (ID, body, user = admin) => act(ID, 'completeReview', { version: (await getDecision(ID)).version, ...body }, user)
const records = campID => cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }).orderBy('assessedAt'))
const lineOf = (recordID, standardCode) => one('AssessmentRecordLines', { record_ID: recordID, standardCode })
const { activateDue } = require('../srv/lib/decisions')

describe('B4.2 local targets', () => {
  describe('proposal, validation and drafts', () => {
    let campID
    before(async () => { campID = await createCamp('Target Validation Camp') })

    it('requires a value, a reason, a source and a future review date, and refuses values it would have to coerce', async () => {
      for (const [body, expected] of [
        [{ targetPerPerson: null }, ['TARGET_VALUE_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ targetPerPerson: 0 }, ['TARGET_VALUE_INVALID']],
        [{ targetPerPerson: -5 }, ['TARGET_VALUE_INVALID']],
        [{ targetPerPerson: '1e3' }, ['TARGET_VALUE_INVALID', 'ASSERT_FORMAT', 'ASSERT_DATA_TYPE']],
        [{ targetPerPerson: 'abc' }, ['TARGET_VALUE_INVALID', 'ASSERT_FORMAT', 'ASSERT_DATA_TYPE']],
        [{ targetPerPerson: '20.1234567' }, ['TARGET_VALUE_INVALID', 'ASSERT_FORMAT', 'ASSERT_DATA_TYPE']],
        [{ reason: ' ' }, ['DECISION_REASON_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ source: '' }, ['TARGET_SOURCE_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ reviewDate: null }, ['DECISION_REVIEW_DATE_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ reviewDate: day(0) }, ['DECISION_REVIEW_DATE_FUTURE']],
        [{ effectiveFrom: day(-1) }, ['DECISION_BACKDATED']],
        [{ effectiveFrom: day(30), reviewDate: day(20) }, ['DECISION_REVIEW_AFTER_EFFECTIVE']]
      ]) {
        const res = await outcome(proposeTarget(campID, body))
        assert.equal(res.status, 400, JSON.stringify(body))
        assert.ok(expected.includes(code(res)), `${JSON.stringify(body)}: ${code(res)}`)
      }
      assert.equal((await db('CampDecisions', { camp_ID: campID })).length, 0, 'nothing saved')
    })

    it('refuses a local target for an indicator without a reference figure: a target never creates a requirement', async () => {
      const res = await outcome(proposeTarget(campID, { standard: 'NET', targetPerPerson: 0.5 }))
      assert.equal(res.status, 409)
      assert.equal(code(res), 'TARGET_NO_REFERENCE')
    })

    it('keeps the draft private to its proposer, and keeps the kinds apart', async () => {
      const { data: d } = await proposeTarget(campID, { saveAsDraft: true })
      assert.equal(d.status_code, 'DRAFT')
      assert.equal(d.kind, 'TARGET')
      assert.equal(Number(d.referencePerPerson), 15)
      const other = await outcome(act(d.ID, 'reviseTargetDraft', { targetPerPerson: 25, reason: 'x', source: 'y', reviewDate: day(30), version: d.version }, admin))
      assert.equal(code(other), 'DECISION_PROPOSER_ONLY')
      const wrongKind = await outcome(act(d.ID, 'reviseDraft', { applicability: 'APPLICABLE', reason: 'x', reviewDate: day(30), version: d.version }, coordinator))
      assert.equal(code(wrongKind), 'DECISION_KIND_MISMATCH')
      await act(d.ID, 'reviseTargetDraft', { targetPerPerson: 25, reason: 'Revised after the site visit', source: 'Site visit report', reviewDate: day(60), version: d.version }, coordinator)
      const revised = await getDecision(d.ID)
      assert.equal(Number(revised.targetPerPerson), 25)
      assert.equal(revised.canReviseTarget, false, 'the admin reading it is not the proposer')
      await act(d.ID, 'submit', { version: revised.version }, coordinator)
      assert.equal((await getDecision(d.ID)).status_code, 'PENDING')
      assert.equal((await stockOf(campID)).WATER.targetBasis, 'REFERENCE_FIGURE', 'a pending proposal never counts')
      await reject(d.ID)
      assert.equal((await stockOf(campID)).WATER.targetBasis, 'REFERENCE_FIGURE', 'a rejected proposal never counts')
    })

    it('never changes the reference figure', async () => {
      const { data } = await GET(`${R}/Standards('WATER')`, coordinator)
      assert.equal(Number(data.perPerson), 15)
    })
  })

  describe('target precedence', () => {
    let a, b, targetID
    before(async () => {
      a = await createCamp('Target Camp A')
      b = await createCamp('Target Camp B')
      for (const c of [a, b]) await count(c, 'WATER', 5000)
    })

    it('an approved local target in force replaces the reference figure for its camp only', async () => {
      assert.equal((await stockOf(a)).WATER.assessment, 'ATTENTION', '5000 litres for 100 people at 15 l is 3.3 days')
      const { data: d } = await proposeTarget(a)
      targetID = d.ID
      const res = await approve(d.ID)
      assert.equal(res.data.status_code, 'APPROVED')
      const { WATER } = await stockOf(a)
      assert.equal(Number(WATER.perPerson), 30)
      assert.equal(Number(WATER.referencePerPerson), 15)
      assert.equal(WATER.targetBasis, 'LOCAL_TARGET')
      assert.equal(WATER.targetBasisText, 'Local target')
      assert.equal(Number(WATER.required), 3000)
      assert.equal(WATER.assessment, 'CRITICAL', '5000 litres at 30 l is 1.7 days')
      assert.equal(Number(WATER.daysOfCover), 1.7)
      const other = (await stockOf(b)).WATER
      assert.equal(Number(other.perPerson), 15, 'never another camp')
      assert.equal(other.targetBasis, 'REFERENCE_FIGURE')
      assert.equal(other.assessment, 'ATTENTION')
      assert.equal((await stockOf(a)).SOAP.targetBasis, 'REFERENCE_FIGURE', 'never another indicator')
    })

    it('a scheduled local target does not count before its date, then takes effect once', async () => {
      const { data: d } = await proposeTarget(a, { targetPerPerson: 20, effectiveFrom: day(3), reviewDate: day(60) })
      assert.equal(d.previousDecision_ID, targetID)
      assert.equal(Number(d.previousTargetPerPerson), 30)
      const res = await approve(d.ID)
      assert.equal(res.data.status_code, 'SCHEDULED')
      assert.equal(Number((await stockOf(a)).WATER.perPerson), 30, 'the target in force still applies')
      assert.equal(await activateDue(), 0, 'not before its date')
      await cds.run(UPDATE('reliefgrid.CampDecisions', d.ID).with({ effectiveFrom: day(0) }))
      const runs = await Promise.all([activateDue(), activateDue()])
      assert.equal(runs[0] + runs[1], 1, 'activated once')
      assert.equal(Number((await stockOf(a)).WATER.perPerson), 20)
      const old = await getDecision(targetID)
      assert.equal(old.status_code, 'SUPERSEDED')
      assert.equal(old.endedBy_ID, d.ID)
      assert.equal(old.reviewState, 'SUPERSEDED')
      const inForce = await db('CampDecisions', { camp_ID: a, kind: 'TARGET', status_code: 'APPROVED', intent: 'DECIDE' })
      assert.equal(inForce.length, 1, 'one local target in force')
      targetID = d.ID
    })

    it('a withdrawal, once approved, returns the camp to the reference figure', async () => {
      const nothing = await outcome(POST(`${camp(b)}/ReliefService.proposeTargetWithdrawal`, { standard: 'WATER', reason: 'x' }, coordinator))
      assert.equal(code(nothing), 'TARGET_NOTHING_TO_WITHDRAW')
      const { data: w } = await POST(`${camp(a)}/ReliefService.proposeTargetWithdrawal`, { standard: 'WATER', reason: 'Rains started' }, coordinator)
      assert.equal(Number((await stockOf(a)).WATER.perPerson), 20, 'nothing changes before approval')
      await approve(w.ID)
      const ended = await getDecision(targetID)
      assert.equal(ended.status_code, 'WITHDRAWN')
      assert.equal(ended.reviewState, 'WITHDRAWN')
      const { WATER } = await stockOf(a)
      assert.equal(Number(WATER.perPerson), 15)
      assert.equal(WATER.targetBasis, 'REFERENCE_FIGURE')
    })

    it('applicability stays authoritative: a local target never makes an indicator apply, nor assesses an empty camp', async () => {
      const c = await createCamp('Target Applicability Camp')
      await count(c, 'WATER', 5000)
      const { data: t } = await proposeTarget(c)
      const { data: n } = await proposeApplicability(c)
      assert.ok(t.ID && n.ID, 'a target and an applicability proposal can wait side by side')
      await approve(t.ID)
      await approve(n.ID)
      const all = (await GET(`${camp(c)}/stock`, coordinator)).data.value
      assert.equal(all.filter(s => s.standard_code === 'WATER').length, 1, 'one line per indicator, with one decision of each kind in force')
      assert.equal(all.length, 9)
      const { WATER } = await stockOf(c)
      assert.equal(WATER.assessment, 'NOT_APPLICABLE')
      for (const f of ['required', 'daysOfCover', 'shortfall', 'severity']) assert.equal(WATER[f], null, f)
      assert.equal(WATER.targetBasis, 'LOCAL_TARGET', 'the target stays in force, and is simply not used')
      const empty = await createCamp('Target Empty Camp', 0)
      const { data: e } = await proposeTarget(empty)
      await approve(e.ID)
      assert.equal((await stockOf(empty)).WATER.assessment, 'NOT_ASSESSED')
      const uncounted = await createCamp('Target Uncounted Camp')
      const { data: u } = await proposeTarget(uncounted)
      await approve(u.ID)
      const line = (await stockOf(uncounted)).WATER
      assert.equal(line.assessment, 'NOT_COUNTED')
      assert.equal(line.severity, null)
    })

    it('a counted zero stays a real zero with a local target', async () => {
      const c = await createCamp('Target Zero Camp')
      await count(c, 'WATER', 0)
      const { data: t } = await proposeTarget(c, { targetPerPerson: 10 })
      await approve(t.ID)
      const { WATER } = await stockOf(c)
      assert.equal(WATER.assessment, 'CRITICAL')
      assert.equal(Number(WATER.required), 1000)
    })
  })

  describe('assessment history', () => {
    let campID, firstRecord, first
    before(async () => {
      campID = await createCamp('Target History Camp')
      await count(campID, 'WATER', 5000)
    })

    it('records the exact target basis used, in the same step as the decision takes effect', async () => {
      const before = (await records(campID)).length
      const { data: d } = await proposeTarget(campID)
      await approve(d.ID)
      const all = await records(campID)
      assert.equal(all.length, before + 1)
      firstRecord = all.at(-1)
      assert.equal(firstRecord.trigger, 'DECISION_EFFECTIVE')
      assert.equal(firstRecord.triggerID, d.ID)
      const line = await lineOf(firstRecord.ID, 'WATER')
      assert.equal(line.requirementBasis, 'LOCAL_TARGET')
      assert.equal(Number(line.perPerson), 30)
      assert.equal(Number(line.referencePerPerson), 15)
      assert.equal(line.targetDecisionID, d.ID)
      assert.equal(line.targetDecisionVersion, (await getDecision(d.ID)).version)
      assert.ok(line.targetEffectiveFrom)
      assert.equal(line.targetSource, 'WASH cluster assessment, 3 Nov 2026')
      assert.equal(Number(line.requirement), 3000)
      assert.equal(line.state, 'CRITICAL')
      const soap = await lineOf(firstRecord.ID, 'SOAP')
      assert.equal(soap.requirementBasis, 'REFERENCE_FIGURE')
      assert.equal(soap.targetDecisionID, null)
      first = await cds.run(SELECT.from('reliefgrid.AssessmentRecordLines').where({ record_ID: firstRecord.ID }).orderBy('ID'))
    })

    it('a later target never rewrites an earlier assessment; new assessments use the new target', async () => {
      const { data: d2 } = await proposeTarget(campID, { targetPerPerson: 22 })
      await approve(d2.ID)
      const latest = (await records(campID)).at(-1)
      assert.notEqual(latest.ID, firstRecord.ID)
      assert.equal(Number((await lineOf(latest.ID, 'WATER')).perPerson), 22)
      assert.deepEqual(await cds.run(SELECT.from('reliefgrid.AssessmentRecordLines').where({ record_ID: firstRecord.ID }).orderBy('ID')), first,
        'the earlier record still shows 30 litres, exactly as calculated')
      await count(campID, 'WATER', 4000)
      const afterCount = (await records(campID)).at(-1)
      assert.equal(afterCount.trigger, 'STOCK_COUNTED')
      assert.equal(Number((await lineOf(afterCount.ID, 'WATER')).perPerson), 22)
    })
  })

  describe('requests and pledges', () => {
    let campID, request
    before(async () => {
      campID = await createCamp('Target Request Camp')
      await count(campID, 'WATER', 1000)
    })

    it('raises requests from the local target in force, and keeps it in the request basis', async () => {
      const { data: t } = await proposeTarget(campID)
      await approve(t.ID)
      await POST(`${camp(campID)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
      request = (await GET(`${camp(campID)}/requests?$filter=standard_code eq 'WATER'`, coordinator)).data.value[0]
      assert.equal(Number(request.quantity), 100 * 30 * 7 - 1000, '7 days at 30 l for 100 people, less the 1000 l on hand')
      assert.equal(Number(request.basisRequirement), 3000)
      assert.match(request.basisSource, /^Local target 30 litres per person per day \(decision /)
      assert.match(request.basisSource, /reference figure 15/)
    })

    it('a change of the requirement flags outstanding requests for review; pledges and deliveries stay; nothing is cancelled', async () => {
      const { data: p } = await POST(`${D}/Requests(${request.ID})/DonorService.pledge`, { donor: 'Target Donor', quantity: 2000 }, donor)
      await POST(`${R}/Pledges(${p.ID})/ReliefService.confirmDelivery`, { receivedQuantity: 1500 }, coordinator)
      const before = (await GET(`${R}/Requests(${request.ID})?$expand=pledges`, coordinator)).data
      const { data: t2 } = await proposeTarget(campID, { targetPerPerson: 20 })
      await approve(t2.ID)
      const after = (await GET(`${R}/Requests(${request.ID})?$expand=pledges,currentReview`, coordinator)).data
      assert.equal(after.review_code, 'PENDING')
      assert.equal(after.currentReview.cause, 'TARGET_CHANGED')
      assert.equal(after.currentReview.decision_ID, t2.ID)
      assert.equal(after.status_code, before.status_code)
      assert.equal(after.quantity, before.quantity)
      assert.deepEqual(after.pledges, before.pledges)
      assert.equal(after.deliveredQuantity, before.deliveredQuantity)
      assert.equal(after.basisAssessment_ID, before.basisAssessment_ID, 'the calculation basis is kept')
      assert.equal((await GET(`${D}/Requests?$filter=ID eq ${request.ID}`, donor)).data.value.length, 0, 'not offered while under review')
      await POST(`${R}/Requests(${request.ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'Still needed at the new target' }, coordinator)
      assert.equal((await GET(`${D}/Requests?$filter=ID eq ${request.ID}`, donor)).data.value.length, 1, 'offered again: the indicator is established')
    })

    it('a decision that leaves the requirement unchanged flags nothing', async () => {
      const { data: same } = await proposeTarget(campID, { targetPerPerson: 20, reason: 'Confirmed again with the cluster' })
      await approve(same.ID)
      assert.equal((await GET(`${R}/Requests(${request.ID})`, coordinator)).data.review_code, 'KEPT')
    })
  })

  describe('periodic review', () => {
    let campID, d
    before(async () => {
      campID = await createCamp('Target Review Camp')
      await count(campID, 'WATER', 5000)
      d = (await proposeTarget(campID)).data
      await approve(d.ID)
    })

    it('distinguishes a review not yet due, due today and overdue, and an overdue review changes nothing by itself', async () => {
      assert.equal((await getDecision(d.ID)).reviewState, 'NOT_DUE')
      await cds.run(UPDATE('reliefgrid.CampDecisions', d.ID).with({ reviewDate: day(0) }))
      let v = await getDecision(d.ID)
      assert.equal(v.reviewState, 'DUE_TODAY')
      assert.equal(v.displayStatus, 'In force, review due today')
      assert.ok((await GET(`${R}/attention()`, coordinator)).data.value.some(i => i.kind === 'REVIEW_DUE' && i.decisionID === d.ID && i.decisionKind === 'TARGET'))
      await cds.run(UPDATE('reliefgrid.CampDecisions', d.ID).with({ reviewDate: day(-3) }))
      const before = await stockOf(campID)
      const recordsBefore = (await records(campID)).length
      v = await getDecision(d.ID)
      assert.equal(v.reviewState, 'OVERDUE')
      assert.equal(v.status_code, 'APPROVED')
      assert.equal(v.displayStatus, 'In force, review overdue')
      assert.deepEqual(await stockOf(campID), before, 'still the local target, same classification')
      assert.equal((await records(campID)).length, recordsBefore)
      const attention = (await GET(`${R}/attention()`, coordinator)).data.value
      assert.ok(attention.some(i => i.kind === 'REVIEW_OVERDUE' && i.decisionID === d.ID && i.decisionKind === 'TARGET' && i.date === day(-3)))
      assert.ok((await GET(`${R}/overview()`, coordinator)).data.overdueReviews >= 1)
    })

    it('only an Administrator records a review, with an explanation and a future next review date', async () => {
      const v = await getDecision(d.ID)
      const byCoordinator = await outcome(act(d.ID, 'completeReview', { outcome: 'CONFIRMED', explanation: 'x', nextReviewDate: day(30), version: v.version }, coordinator))
      assert.equal(byCoordinator.status, 403)
      for (const [body, expected] of [
        [{ outcome: 'CONFIRMED', explanation: ' ', nextReviewDate: day(30) }, ['REVIEW_EXPLANATION_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ outcome: 'CONFIRMED', explanation: 'Still hot', nextReviewDate: null }, ['REVIEW_NEXT_DATE_REQUIRED']],
        [{ outcome: 'CONFIRMED', explanation: 'Still hot', nextReviewDate: day(0) }, ['DECISION_REVIEW_DATE_FUTURE']],
        [{ outcome: 'MAYBE', explanation: 'Still hot', nextReviewDate: day(30) }, ['REVIEW_OUTCOME_REQUIRED']]
      ]) {
        const res = await outcome(review(d.ID, body))
        assert.equal(res.status, 400, JSON.stringify(body))
        assert.ok(expected.includes(code(res)), code(res))
      }
      assert.equal((await db('DecisionReviews', { decision_ID: d.ID })).length, 0)
    })

    it('a confirming review keeps the decision unchanged and sets the next review date; it is recorded and auditable', async () => {
      const before = await one('CampDecisions', { ID: d.ID })
      await review(d.ID, { outcome: 'CONFIRMED', explanation: 'Hot season continues, cluster confirms the figure', nextReviewDate: day(45) })
      const after = await one('CampDecisions', { ID: d.ID })
      for (const f of ['status_code', 'targetPerPerson', 'reviewDate', 'effectiveFrom', 'inForceFrom', 'approvedBy', 'source', 'reason'])
        assert.deepEqual(after[f], before[f], f)
      assert.equal(after.version, before.version + 1, 'the version moves on, so a review on a stale page is refused')
      const [r] = await db('DecisionReviews', { decision_ID: d.ID })
      assert.equal(r.reviewedBy, 'admin')
      assert.equal(r.outcome_code, 'CONFIRMED')
      assert.equal(r.nextReviewDate, day(45))
      assert.equal(r.decisionVersion, after.version)
      const v = await getDecision(d.ID)
      assert.equal(v.reviewState, 'COMPLETED')
      assert.equal(v.reviewDue, day(45))
      assert.match(v.reviewStateText, /^Reviewed .* by admin: confirmed, next review /)
      assert.equal(v.displayStatus, 'In force')
      assert.ok(!(await GET(`${R}/attention()`, coordinator)).data.value.some(i => i.decisionID === d.ID))
      const stale = await outcome(act(d.ID, 'completeReview', { outcome: 'CONFIRMED', explanation: 'again', nextReviewDate: day(50), version: before.version }, admin2, `W/"${before.version}"`))
      assert.ok([409, 412].includes(stale.status))
    })

    it('a review that proposes a change keeps the decision in force until the change is approved, and is due again if it is rejected', async () => {
      const none = await outcome(review(d.ID, { outcome: 'CHANGE_PROPOSED', explanation: 'Should change' }))
      assert.equal(code(none), 'REVIEW_NO_CHANGE_PROPOSED')
      const { data: replacement } = await proposeTarget(campID, { targetPerPerson: 18, reason: 'Rains expected', source: 'Met office forecast' }, admin)
      await review(d.ID, { outcome: 'CHANGE_PROPOSED', explanation: 'Forecast shows rains' }, admin2)
      let v = await getDecision(d.ID)
      assert.equal(v.reviewState, 'COMPLETED')
      assert.equal(v.reviewDue, null)
      assert.match(v.reviewStateText, /change proposed, waiting for approval/)
      const [, r] = await cds.run(SELECT.from('reliefgrid.DecisionReviews').where({ decision_ID: d.ID }).orderBy('reviewedAt'))
      assert.equal(r.resultingDecision_ID, replacement.ID)
      assert.equal(Number((await stockOf(campID)).WATER.perPerson), 30, 'reviewing is not approving')
      await reject(replacement.ID, 'Forecast uncertain', admin2)
      v = await getDecision(d.ID)
      assert.ok(['OVERDUE', 'DUE_TODAY'].includes(v.reviewState), v.reviewState)
      const pending = await outcome(review(replacement.ID, { outcome: 'CONFIRMED', explanation: 'x', nextReviewDate: day(30) }))
      assert.equal(code(pending), 'REVIEW_NOT_IN_FORCE')
    })

    it('applicability decisions in force can be reviewed the same way', async () => {
      const c = await createCamp('Applicability Review Camp')
      const { data: a } = await proposeApplicability(c, { standard: 'SOAP', reason: 'Soap from the host', source: 'Host agreement' })
      await approve(a.ID)
      await review(a.ID, { outcome: 'CONFIRMED', explanation: 'Host still supplies soap', nextReviewDate: day(40) })
      const v = await getDecision(a.ID)
      assert.equal(v.reviewState, 'COMPLETED')
      assert.equal(v.reviewDue, day(40))
      assert.equal(v.kindText, 'Applicability')
    })
  })

  describe('scheduling', () => {
    it('a missed scheduler run is caught up at the next run; a decision whose context changed is not activated', async () => {
      const c = await createCamp('Target Missed Run Camp')
      await count(c, 'WATER', 5000)
      const { data: s } = await proposeTarget(c, { effectiveFrom: day(2), reviewDate: day(60) })
      await approve(s.ID)
      // the server was down on the effective date: the date is long past at the next run
      await cds.run(UPDATE('reliefgrid.CampDecisions', s.ID).with({ effectiveFrom: day(-4) }))
      assert.equal(await activateDue(), 1)
      assert.equal((await getDecision(s.ID)).status_code, 'APPROVED')
      assert.equal(Number((await stockOf(c)).WATER.perPerson), 30)

      const { data: s2 } = await proposeTarget(c, { targetPerPerson: 25, effectiveFrom: day(2), reviewDate: day(60) })
      await approve(s2.ID)
      // the decision it was approved against is no longer in force (data changed outside the workflow)
      await cds.run(UPDATE('reliefgrid.CampDecisions', s.ID).with({ status_code: 'WITHDRAWN' }))
      await cds.run(UPDATE('reliefgrid.CampDecisions', s2.ID).with({ effectiveFrom: day(0) }))
      const recordsBefore = (await records(c)).length
      assert.equal(await activateDue(), 0)
      assert.equal((await getDecision(s2.ID)).status_code, 'SCHEDULED')
      assert.equal((await records(c)).length, recordsBefore)
      const attention = (await GET(`${R}/attention()`, coordinator)).data.value
      assert.ok(attention.some(i => i.kind === 'SCHEDULED_BLOCKED' && i.decisionID === s2.ID))
    })
  })

  describe('security and concurrency', () => {
    let a, b, pendingA
    before(async () => {
      a = await createCamp('Target Security Camp A')
      b = await createCamp('Target Security Camp B')
      pendingA = (await proposeTarget(a)).data
    })

    it('coordinators propose but never approve or reject; nobody approves their own proposal', async () => {
      assert.equal((await outcome(approve(pendingA.ID, coordinator))).status, 403)
      assert.equal((await outcome(reject(pendingA.ID, 'x', coordinator))).status, 403)
      const { data: own } = await proposeTarget(b, {}, admin)
      const self = await outcome(approve(own.ID, admin))
      assert.equal(self.status, 403)
      assert.equal(code(self), 'DECISION_SELF_APPROVAL')
      const selfReject = await outcome(reject(own.ID, 'x', admin))
      assert.equal(code(selfReject), 'DECISION_SELF_REJECTION')
      await approve(own.ID, admin2)
      assert.equal((await getDecision(own.ID)).approvedBy, 'admin2')
    })

    it('donors cannot see or change local targets through any route', async () => {
      for (const p of [`${R}/CampDecisions`, decision(pendingA.ID), `${R}/DecisionReviews`, `${R}/localTargets()`, `${R}/attention()`])
        assert.equal((await outcome(GET(p, donor))).status, 403, p)
      assert.equal((await outcome(proposeTarget(a, {}, donor))).status, 403)
      assert.equal((await outcome(POST(`${camp(a)}/ReliefService.proposeTargetWithdrawal`, { standard: 'WATER', reason: 'x' }, donor))).status, 403)
      for (const action of ['approve', 'rejectProposal', 'completeReview', 'reviseTargetDraft'])
        assert.equal((await outcome(act(pendingA.ID, action, { version: 1, reason: 'x', outcome: 'CONFIRMED', explanation: 'x' }, donor))).status, 403, action)
      const { data: md } = await GET(`${D}/$metadata`, donor)
      assert.doesNotMatch(md, /targetPerPerson|referencePerPerson|DecisionReviews|targetBasis|localTargets/)
      const board = (await GET(`${D}/Requests?$top=1`, donor)).data.value[0]
      if (board) assert.ok(!('targetPerPerson' in board) && !('perPerson' in board))
    })

    it('decisions and reviews cannot be written as entities, through navigation, deep updates or $batch', async () => {
      const json = { headers: { 'content-type': 'application/json' } }
      const routes = [
        ['POST decision', () => POST(`${R}/CampDecisions`, { camp_ID: a, kind: 'TARGET', standard_code: 'WATER', status_code: 'APPROVED', targetPerPerson: 99 }, admin)],
        ['PATCH decision value', () => PATCH(decision(pendingA.ID), { targetPerPerson: 99 }, admin)],
        ['PUT decision', () => PUT(decision(pendingA.ID), { ...pendingA, status_code: 'APPROVED' }, admin)],
        ['DELETE decision', () => axios.delete(decision(pendingA.ID), admin)],
        ['POST review', () => POST(`${R}/DecisionReviews`, { decision_ID: pendingA.ID, outcome_code: 'CONFIRMED', explanation: 'x', reviewedBy: 'admin', reviewedAt: new Date().toISOString() }, admin)],
        ['PATCH via stock target', () => PATCH(`${R}/Stock(${pendingA.ID})/target`, { targetPerPerson: 99 }, admin)],
        ['POST via camp navigation', () => POST(`${camp(a)}/decisions`, { kind: 'TARGET', standard_code: 'WATER', status_code: 'APPROVED', targetPerPerson: 99 }, admin)],
        ['PATCH standard', () => PATCH(`${R}/Standards('WATER')`, { perPerson: 99 }, admin)],
        ['$batch PATCH decision', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'PATCH', url: `CampDecisions(${pendingA.ID})`, headers: { 'content-type': 'application/json' }, body: { targetPerPerson: 99 } }] }, { ...admin, ...json })]
      ]
      for (const [label, attempt] of routes) {
        const before = [await db('CampDecisions', {}), await db('DecisionReviews', {}), await db('Standards', { code: 'WATER' })]
        const res = await outcome(attempt())
        const statuses = res.data?.responses ? res.data.responses.map(r => r.status) : [res.status]
        assert.ok(statuses.every(s => !ok(s)), `${label} answered ${statuses}`)
        assert.deepEqual([await db('CampDecisions', {}), await db('DecisionReviews', {}), await db('Standards', { code: 'WATER' })], before, label)
      }
      await POST(`${camp(a)}/ReliefService.draftEdit`, { PreserveChanges: true }, coordinator)
      const key = `${R}/Camps(ID=${a},IsActiveEntity=false)`
      const before = await db('CampDecisions', {})
      await outcome(PATCH(key, { decisions: [{ standard_code: 'SOAP', kind: 'TARGET', status_code: 'APPROVED', targetPerPerson: 99 }] }, coordinator))
      await outcome(POST(`${key}/ReliefService.draftActivate`, {}, coordinator))
      assert.deepEqual(await db('CampDecisions', {}), before, 'deep update through a camp draft')
    })

    it('one camp cannot read or act on another camp\'s local target through its own path', async () => {
      const read = await outcome(GET(`${camp(b)}/decisions(${pendingA.ID})`, admin))
      assert.equal(read.status, 404)
      const tag = (await getDecision(pendingA.ID))['@odata.etag']
      for (const action of ['approve', 'rejectProposal']) {
        // with the real ETag CAP's own check already refuses (412); with "*" CAP does not compare, and the camp check refuses
        const body = action === 'approve' ? { version: pendingA.version } : { version: pendingA.version, reason: 'cross-camp' }
        const res = await outcome(POST(`${camp(b)}/decisions(${pendingA.ID})/ReliefService.${action}`, body, { ...admin2, headers: { 'if-match': tag } }))
        assert.ok([404, 412].includes(res.status), `${action}: ${res.status}`)
        const star = await outcome(POST(`${camp(b)}/decisions(${pendingA.ID})/ReliefService.${action}`, body, { ...admin2, headers: { 'if-match': '*' } }))
        assert.equal(star.status, 404, `${action} with If-Match *`)
        assert.equal(code(star), 'DECISION_NOT_FOUND')
      }
      assert.equal((await getDecision(pendingA.ID)).status_code, 'PENDING')
      // through its own camp it works
      await POST(`${camp(a)}/decisions(${pendingA.ID})/ReliefService.approve`, { version: pendingA.version }, { ...admin2, headers: { 'if-match': tag } })
      assert.equal((await getDecision(pendingA.ID)).status_code, 'APPROVED')
    })

    it('ignores client-supplied identity and status fields', async () => {
      const res = await outcome(proposeTarget(b, { standard: 'SOAP', targetPerPerson: 10, proposedBy: 'admin2', approvedBy: 'admin2', status_code: 'APPROVED', kind: 'APPLICABILITY' }))
      if (ok(res.status)) {
        const d = await getDecision(res.data.ID)
        assert.equal(d.proposedBy, 'coordinator')
        assert.equal(d.status_code, 'PENDING')
        assert.equal(d.approvedBy, null)
        assert.equal(d.kind, 'TARGET')
      }
    })

    it('requires the ETag and refuses a stale one', async () => {
      const { data: d } = await proposeTarget(await createCamp('Target ETag Camp'))
      const missing = await outcome(POST(`${decision(d.ID)}/ReliefService.approve`, { version: d.version }, admin))
      assert.equal(missing.status, 428)
      const stale = await outcome(act(d.ID, 'approve', { version: d.version }, admin, 'W/"999"'))
      assert.equal(stale.status, 412)
      // "If-Match: *" names no version, so it never replaces the version the caller saw
      const star = await outcome(POST(`${decision(d.ID)}/ReliefService.approve`, {}, { ...admin, headers: { 'if-match': '*' } }))
      assert.equal(star.status, 400)
      assert.equal(code(star), 'DECISION_VERSION_REQUIRED')
      assert.equal((await getDecision(d.ID)).status_code, 'PENDING')
    })

    it('only one of two simultaneous target submissions becomes pending, and one of two approvals goes through', async () => {
      const c = await createCamp('Target Race Camp')
      const { data: x } = await proposeTarget(c, { saveAsDraft: true })
      const { data: y } = await proposeTarget(c, { saveAsDraft: true, targetPerPerson: 25 })
      const submits = await Promise.all([x, y].map(d => outcome(act(d.ID, 'submit', { version: d.version }, coordinator))))
      assert.deepEqual(submits.map(r => r.status).sort(), [200, 409])
      const pending = (await db('CampDecisions', { camp_ID: c, kind: 'TARGET', status_code: 'PENDING' }))[0]
      const approvals = await Promise.all([outcome(approve(pending.ID, admin)), outcome(approve(pending.ID, admin2))])
      const statuses = approvals.map(r => r.status).sort()
      assert.equal(statuses[0], 200)
      assert.ok([409, 412].includes(statuses[1]))
      assert.equal((await db('CampDecisions', { camp_ID: c, kind: 'TARGET', status_code: 'APPROVED' })).length, 1)
    })
  })

  describe('assessment history screen', () => {
    let a, b, record
    before(async () => {
      a = await createCamp('History Screen Camp A')
      b = await createCamp('History Screen Camp B')
      await count(a, 'WATER', 5000)
      const { data: t } = await proposeTarget(a)
      await approve(t.ID)
      record = (await GET(`${camp(a)}/assessmentRecords?$orderby=assessedAt desc&$top=1&$expand=lines`, coordinator)).data.value[0]
    })

    it('shows a camp\'s records in plain words, with the figure and basis each line used', () => {
      assert.equal(record.triggerText, 'Decision took effect')
      const water = record.lines.find(l => l.standardCode === 'WATER')
      assert.equal(water.stateText, 'Critical')
      assert.equal(water.requirementBasisText, 'Local target')
      assert.equal(Number(water.perPerson), 30)
      assert.equal(Number(water.referencePerPerson), 15)
      assert.equal(record.lines.find(l => l.standardCode === 'SOAP').requirementBasisText, 'Reference figure')
    })

    it('is read-only on every route, stays within its camp, and is closed to donors', async () => {
      const key = `${R}/AssessmentRecords(${record.ID})`
      const routes = [
        ['POST record', () => POST(`${R}/AssessmentRecords`, { camp_ID: a, trigger: 'BASELINE', assessedAt: new Date().toISOString() }, admin)],
        ['POST via camp', () => POST(`${camp(a)}/assessmentRecords`, { trigger: 'BASELINE', assessedAt: new Date().toISOString() }, admin)],
        ['PATCH record', () => PATCH(key, { actor: 'someone else' }, admin)],
        ['DELETE record', () => axios.delete(key, admin)],
        ['PATCH line', () => PATCH(`${R}/AssessmentRecordLines(${record.lines[0].ID})`, { perPerson: 1 }, admin)]
      ]
      for (const [label, attempt] of routes) {
        const before = [await db('AssessmentRecords', {}), await db('AssessmentRecordLines', {})]
        const res = await outcome(attempt())
        assert.ok(!ok(res.status), `${label} answered ${res.status}`)
        assert.deepEqual([await db('AssessmentRecords', {}), await db('AssessmentRecordLines', {})], before, label)
      }
      assert.equal((await outcome(GET(`${camp(b)}/assessmentRecords(${record.ID})`, admin))).status, 404, 'not through another camp')
      for (const p of [`${camp(a)}/assessmentRecords`, key, `${R}/AssessmentRecordLines`]) assert.equal((await outcome(GET(p, donor))).status, 403, p)
    })
  })

  describe('page refresh after actions', () => {
    it('declares side effects on the real binding parameter, so pages re-read after an action', async () => {
      for (const [path, user] of [[R, admin], [D, donor]]) {
        const { data: md } = await GET(`${path}/$metadata`, user)
        const paths = [...md.matchAll(/<(?:NavigationPropertyPath|String|PropertyPath)>(_it(?:\/[^<]*)?|in(?:\/[^<]*)?)<\//g)].map(m => m[1])
        assert.ok(paths.length > 0, path)
        assert.deepEqual(paths.filter(p => p.startsWith('_it')), [], `${path}: "_it" matches nothing, the binding parameter is "in"`)
      }
      const { data: md } = await GET(`${R}/$metadata`, admin)
      const review = md.slice(md.indexOf('completeReview(ReliefService.CampDecisions'))
      assert.match(review.slice(0, 900), /<NavigationPropertyPath>in\/reviews<\/NavigationPropertyPath>/)
    })
  })

  describe('transactions', () => {
    let failOn = null
    before(() => {
      cds.db.before('CREATE', 'reliefgrid.AssessmentRecords', () => { if (failOn) { failOn = null; throw new Error('injected failure') } })
    })

    it('rolls a target approval back completely when the assessment record cannot be written', async () => {
      const c = await createCamp('Target Rollback Camp')
      await count(c, 'WATER', 1000)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
      const { data: t } = await proposeTarget(c)
      const snapshot = async () => ({
        decisions: await cds.run(SELECT.from('reliefgrid.CampDecisions').where({ camp_ID: c }).orderBy('ID')),
        requests: await cds.run(SELECT.from('reliefgrid.Requests').where({ camp_ID: c }).orderBy('ID')),
        records: await cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: c }).orderBy('ID')),
        reviews: await cds.run(SELECT.from('reliefgrid.RequestReviews').orderBy('ID'))
      })
      const before = await snapshot()
      failOn = true
      const res = await outcome(approve(t.ID))
      assert.ok(res.status >= 500 || res.status === 400, String(res.status))
      assert.deepEqual(await snapshot(), before)
      assert.equal((await stockOf(c)).WATER.targetBasis, 'REFERENCE_FIGURE')
    })
  })

  describe('Command Center data', () => {
    it('lists local targets with their state, and counts those in force and the camps that have one', async () => {
      const { data: list } = await GET(`${R}/localTargets()`, coordinator)
      const states = new Set(list.value.map(i => i.status))
      for (const s of ['APPROVED', 'SCHEDULED', 'PENDING', 'SUPERSEDED', 'WITHDRAWN']) assert.ok(states.has(s) || s === 'SCHEDULED' || s === 'PENDING', s)
      assert.ok(list.value.every(i => i.status !== 'DRAFT' && i.status !== 'REJECTED'))
      const live = list.value.filter(i => i.status === 'APPROVED')
      assert.ok(live.every(i => i.displayStatus.startsWith('In force') && i.intent === 'DECIDE'), 'a withdrawal that took effect is not itself shown as in force')
      assert.ok(live.some(i => i.reviewState === 'OVERDUE' || i.reviewState === 'DUE_TODAY'), 'the review states reach the Command Center')
      const order = list.value.map(i => i.status)
      assert.equal(order.indexOf('APPROVED'), 0, 'in force first')
      const { data: o } = await GET(`${R}/overview()`, coordinator)
      const inForce = await db('CampDecisions', { kind: 'TARGET', status_code: 'APPROVED', intent: 'DECIDE' })
      assert.equal(o.localTargetsInForce, inForce.length)
      assert.equal(o.campsWithLocalTargets, new Set(inForce.map(d => d.camp_ID)).size)
    })
  })
})
