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
const db = cds.entities ? () => cds.entities('reliefgrid') : null

async function createCamp(name, headcount = 100) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}
const stockOf = async campID => Object.fromEntries((await GET(`${camp(campID)}/stock`, coordinator)).data.value.map(s => [s.standard_code, s]))
const count = async (campID, code, quantity) => POST(`${R}/Stock(${(await stockOf(campID))[code].ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(code) ? { functionalUnits: quantity } : {}) }, coordinator)
const propose = (campID, body, user = coordinator) => POST(`${camp(campID)}/ReliefService.proposeApplicability`,
  { standard: 'NET', applicability: 'NOT_APPLICABLE', reason: 'No malaria risk in this district', source: 'District health office, letter 12/2026', reviewDate: day(90), ...body }, user)
const getDecision = async ID => (await GET(decision(ID), coordinator)).data
/** Calls a decision action as UI5 does: with the decision's ETag as If-Match (CAP requires it). */
const act = async (ID, action, body, user, etag) => {
  const tag = etag ?? (await GET(decision(ID), admin)).data['@odata.etag']
  return POST(`${decision(ID)}/ReliefService.${action}`, body, { ...user, headers: { 'if-match': tag } })
}
const approve = async (ID, user = admin) => act(ID, 'approve', { version: (await getDecision(ID)).version }, user)
const reject = async (ID, reason, user = admin) => act(ID, 'rejectProposal', { reason, version: (await getDecision(ID)).version }, user)
const lastRecord = async campID => (await cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }).orderBy({ assessedAt: 'desc' }).limit(1)))[0]
const recordLine = async (recordID, code) => cds.run(SELECT.one.from('reliefgrid.AssessmentRecordLines').where({ record_ID: recordID, standardCode: code }))

describe('B4.1 applicability', () => {
  describe('state sequence', () => {
    let campID
    before(async () => { campID = await createCamp('Sequence Camp') })

    it('shows mosquito nets as Applicability not decided, with no requirement, cover or shortfall', async () => {
      const { NET, WATER } = await stockOf(campID)
      assert.equal(NET.assessment, 'NOT_DECIDED')
      assert.equal(NET.status, 'Applicability not decided')
      assert.equal(NET.cover, 'Not decided')
      for (const f of ['required', 'severity', 'daysOfCover', 'coveragePct', 'shortfall']) assert.equal(NET[f], null, f)
      assert.equal(WATER.assessment, 'NOT_COUNTED', 'other indicators apply by default')
      const { data: std } = await GET(`${R}/Standards('NET')`, coordinator)
      assert.equal(std.perPerson, null, 'no net ratio in the reference data')
      assert.equal(std.applicability, 'DECISION_REQUIRED')
    })

    it('keeps Not assessed first: a camp without people is not assessed, nets included', async () => {
      const empty = await createCamp('Sequence Empty Camp', 0)
      const { NET } = await stockOf(empty)
      assert.equal(NET.assessment, 'NOT_ASSESSED')
    })

    it('a counted net quantity is still not classified while applicability is not decided', async () => {
      await count(campID, 'NET', 0)
      const { NET } = await stockOf(campID)
      assert.equal(NET.assessment, 'NOT_DECIDED', 'a counted zero is not a shortage before applicability is decided')
      assert.equal(Number(NET.quantity), 0, 'the count is kept')
    })

    it('raises no net request and refuses a manual one', async () => {
      await count(campID, 'WATER', 0)
      const res = await POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator)
      assert.equal(res.data.needsDecision, 1)
      const { data } = await GET(`${camp(campID)}/requests`, coordinator)
      assert.deepEqual(data.value.map(r => r.standard_code), ['WATER'])
      const manual = await outcome(POST(`${camp(campID)}/ReliefService.requestSupplies`, { standard: 'NET', quantity: 10 }, coordinator))
      assert.equal(manual.status, 409)
      assert.equal(code(manual), 'INDICATOR_NOT_ESTABLISHED')
    })

    it('Applicable alone establishes no requirement', async () => {
      const { data: d } = await propose(campID, { applicability: 'APPLICABLE', reason: 'Malaria-endemic district', source: '' })
      await approve(d.ID)
      const { NET } = await stockOf(campID)
      assert.equal(NET.assessment, 'NO_REQUIREMENT')
      assert.equal(NET.status, 'Requirement not established')
      assert.equal(NET.required, null)
      assert.equal(NET.shortfall, null)
      const h = (await GET(`${camp(campID)}/health`, coordinator)).data
      assert.equal(h.noRequirementIndicators, 1)
      assert.equal(h.notDecidedIndicators, 0)
    })

    it('Not applicable excludes an indicator that applies by default, and leaves the others as they were', async () => {
      const before = await stockOf(campID)
      await count(campID, 'TOILET', 0)
      const toiletBefore = (await stockOf(campID)).TOILET.assessment
      const { data: d } = await propose(campID, { standard: 'SHELTER', reason: 'Families housed in a school building', source: 'Site assessment 3 Nov' })
      await approve(d.ID)
      const after = await stockOf(campID)
      assert.equal(after.SHELTER.assessment, 'NOT_APPLICABLE')
      assert.equal(after.TOILET.assessment, toiletBefore)
      assert.equal(after.WATER.assessment, before.WATER.assessment)
      const h = (await GET(`${camp(campID)}/health`, coordinator)).data
      assert.equal(h.notApplicableIndicators, 1)
    })
  })

  describe('workflow and authorization', () => {
    let campID
    before(async () => { campID = await createCamp('Workflow Camp') })

    it('lets a coordinator propose, and refuses the coordinator as approver', async () => {
      const { data: d } = await propose(campID, {})
      assert.equal(d.status_code, 'PENDING')
      assert.equal(d.proposedBy, 'coordinator')
      assert.equal(d.previousApplicable, null)
      const res = await outcome(approve(d.ID, coordinator))
      assert.equal(res.status, 403)
      assert.equal((await getDecision(d.ID)).status_code, 'PENDING')
      await reject(d.ID, 'Needs the district letter attached')
    })

    it('refuses a coordinator who tries to approve or reject someone else\'s proposal', async () => {
      const other = await createCamp('Role Camp')
      const { data: d } = await propose(other, {}, admin)
      for (const action of ['approve', 'rejectProposal']) {
        const res = await outcome(act(d.ID, action, { version: d.version, reason: 'not mine to decide' }, coordinator))
        assert.equal(res.status, 403, action)
      }
      assert.equal((await getDecision(d.ID)).status_code, 'PENDING')
    })

    it('refuses self-approval and self-rejection for an Administrator, and lets another Administrator approve', async () => {
      const { data: d } = await propose(campID, {}, admin)
      const self = await outcome(approve(d.ID, admin))
      assert.equal(self.status, 403)
      assert.equal(code(self), 'DECISION_SELF_APPROVAL')
      assert.equal((await outcome(reject(d.ID, 'own', admin))).status, 403)
      const { data: view } = await GET(decision(d.ID), admin)
      assert.equal(view.canApprove, false)
      assert.match(view.approvalNote, /another Administrator must approve/)
      const { data: other } = await GET(decision(d.ID), admin2)
      assert.equal(other.canApprove, true)
      const res = await approve(d.ID, admin2)
      assert.equal(res.data.status_code, 'APPROVED')
      assert.equal(res.data.approvedBy, 'admin2')
      assert.ok(res.data.inForceFrom)
      assert.equal((await stockOf(campID)).NET.assessment, 'NOT_APPLICABLE')
    })

    it('records the decision in the assessment history in the same step', async () => {
      const [d] = (await GET(`${camp(campID)}/decisions?$filter=status_code eq 'APPROVED'`, coordinator)).data.value
      const rec = await lastRecord(campID)
      assert.equal(rec.trigger, 'DECISION_EFFECTIVE')
      assert.equal(rec.triggerID, d.ID)
      assert.equal(rec.actor, 'admin2')
      const line = await recordLine(rec.ID, 'NET')
      assert.equal(line.state, 'NOT_APPLICABLE')
      assert.equal(line.applicabilityDecisionID, d.ID)
      assert.equal(line.applicabilityDecisionVersion, d.version)
      assert.equal(line.applicable, false)
      assert.equal(line.applicabilityRule, 'DECISION_REQUIRED')
    })

    it('requires a reason, a source for Not applicable, a value and a future review date', async () => {
      const cases = [
        // a blank reason is refused by the mandatory check before the handler runs
        [{ reason: ' ' }, ['ASSERT_MANDATORY', 'DECISION_REASON_REQUIRED']],
        [{ source: '' }, 'DECISION_SOURCE_REQUIRED'],
        [{ applicability: 'MAYBE' }, 'DECISION_VALUE_REQUIRED'],
        [{ reviewDate: day(0) }, 'DECISION_REVIEW_DATE_FUTURE'],
        [{ reviewDate: day(5), effectiveFrom: day(10) }, 'DECISION_REVIEW_AFTER_EFFECTIVE'],
        [{ effectiveFrom: day(-1) }, 'DECISION_BACKDATED']
      ]
      const other = await createCamp('Validation Camp')
      for (const [body, expected] of cases) {
        const res = await outcome(propose(other, body))
        assert.equal(res.status, 400, JSON.stringify(body))
        assert.ok([expected].flat().includes(code(res)), `${JSON.stringify(body)}: ${code(res)}`)
      }
      const missing = await outcome(POST(`${camp(other)}/ReliefService.proposeApplicability`,
        { standard: 'NET', applicability: 'APPLICABLE', reason: 'x' }, coordinator))
      assert.equal(missing.status, 400, 'review date is mandatory')
    })

    it('allows only one open proposal per camp and indicator', async () => {
      const other = await createCamp('One Open Camp')
      await propose(other, {})
      const res = await outcome(propose(other, {}))
      assert.equal(res.status, 409)
      assert.equal(code(res), 'DECISION_ALREADY_OPEN')
    })

    it('refuses a stale approval, rejection and submission (409)', async () => {
      const other = await createCamp('Stale Camp')
      const { data: d } = await propose(other, {})
      const v = d.version
      await reject(d.ID, 'first review')
      for (const [action, body] of [['approve', { version: v }], ['rejectProposal', { version: v, reason: 'again' }]]) {
        const res = await outcome(act(d.ID, action, body, admin2))
        assert.equal(res.status, 409, action)
        assert.equal(code(res), 'DECISION_CHANGED_MEANWHILE')
      }
      const { data: draft } = await propose(other, { saveAsDraft: true })
      await act(draft.ID, 'submit', { version: draft.version }, coordinator)
      const stale = await outcome(act(draft.ID, 'submit', { version: draft.version }, coordinator))
      assert.equal(stale.status, 409)
    })

    it('requires the ETag as If-Match (UI5 sends it), and refuses a stale one', async () => {
      const other = await createCamp('ETag Camp')
      const { data: d } = await propose(other, {})
      const res0 = await GET(decision(d.ID), admin)
      const etag = res0.data['@odata.etag'] ?? res0.headers.etag
      assert.ok(etag, 'the decision carries an ETag')
      const none = await outcome(POST(`${decision(d.ID)}/ReliefService.approve`, {}, admin))
      assert.equal(none.status, 428, 'CAP requires If-Match on every decision action')
      const stale = await outcome(POST(`${decision(d.ID)}/ReliefService.approve`, {}, { ...admin, headers: { 'if-match': 'W/"999"' } }))
      assert.equal(stale.status, 412, 'a stale If-Match is refused before the handler runs')
      assert.equal((await getDecision(d.ID)).status_code, 'PENDING')
      const res = await POST(`${decision(d.ID)}/ReliefService.approve`, {}, { ...admin, headers: { 'if-match': etag } })
      assert.equal(res.data.status_code, 'APPROVED')
    })

    it('keeps drafts private to the proposer until submitted, and keeps withdrawn and rejected proposals', async () => {
      const other = await createCamp('Draft Camp')
      const { data: d } = await propose(other, { saveAsDraft: true })
      assert.equal(d.status_code, 'DRAFT')
      const notMine = await outcome(act(d.ID, 'reviseDraft',
        { applicability: 'APPLICABLE', reason: 'x', reviewDate: day(30), version: d.version }, admin))
      assert.equal(notMine.status, 403)
      await act(d.ID, 'reviseDraft', { applicability: 'APPLICABLE', reason: 'Revised', reviewDate: day(60), version: d.version }, coordinator)
      const revised = await getDecision(d.ID)
      assert.equal(revised.applicable, true)
      assert.equal(revised.reason, 'Revised')
      await act(d.ID, 'withdrawProposal', { version: revised.version }, coordinator)
      assert.equal((await getDecision(d.ID)).status_code, 'WITHDRAWN')
      const all = (await GET(`${camp(other)}/decisions`, coordinator)).data.value
      assert.equal(all.length, 1, 'withdrawn proposals stay in the history')
      const rejected = (await GET(`${R}/CampDecisions?$filter=status_code eq 'REJECTED'`, coordinator)).data.value
      assert.ok(rejected.length >= 2 && rejected.every(r => r.rejectionReason && r.rejectedBy))
    })

    it('ends an approved decision only through an approved withdrawal or a new decision', async () => {
      const other = await createCamp('Withdrawal Camp')
      const nothing = await outcome(POST(`${camp(other)}/ReliefService.proposeWithdrawal`, { standard: 'NET', reason: 'x' }, coordinator))
      assert.equal(code(nothing), 'DECISION_NOTHING_TO_WITHDRAW')
      const { data: first } = await propose(other, {})
      await approve(first.ID)
      const { data: replace } = await propose(other, { applicability: 'APPLICABLE', reason: 'New outbreak', source: '' })
      assert.equal(replace.previousApplicable, false)
      await approve(replace.ID)
      assert.equal((await getDecision(first.ID)).status_code, 'SUPERSEDED')
      assert.equal((await getDecision(first.ID)).endedBy_ID, replace.ID)
      const { data: w } = await POST(`${camp(other)}/ReliefService.proposeWithdrawal`, { standard: 'NET', reason: 'Outbreak over' }, coordinator)
      assert.equal((await stockOf(other)).NET.assessment, 'NO_REQUIREMENT', 'nothing changes before approval')
      await approve(w.ID)
      assert.equal((await getDecision(replace.ID)).status_code, 'WITHDRAWN')
      assert.equal((await stockOf(other)).NET.assessment, 'NOT_DECIDED')
      const inForce = (await GET(`${camp(other)}/decisions?$filter=status_code eq 'APPROVED' and intent eq 'DECIDE'`, coordinator)).data.value
      assert.equal(inForce.length, 0)
    })

    it('closure: no acting on someone else\'s proposal, no unqualified or navigation bypass, no spoofed identity', async () => {
      const other = await createCamp('Bypass Camp')
      const { data: draft } = await propose(other, { saveAsDraft: true })
      for (const [action, body] of [['submit', {}], ['withdrawProposal', {}], ['reviseDraft', { applicability: 'APPLICABLE', reason: 'x', reviewDate: day(30) }]]) {
        const res = await outcome(act(draft.ID, action, { ...body, version: draft.version }, admin2))
        assert.equal(res.status, 403, action)
        assert.equal(code(res), 'DECISION_PROPOSER_ONLY', action)
      }
      await act(draft.ID, 'submit', { version: draft.version }, coordinator)
      const pending = await getDecision(draft.ID)
      const tag = { headers: { 'if-match': pending['@odata.etag'] } }
      const routes = [
        ['unqualified approve', () => POST(`${decision(draft.ID)}/approve`, { version: pending.version }, { ...coordinator, ...tag })],
        ['navigation approve', () => POST(`${camp(other)}/decisions(${draft.ID})/ReliefService.approve`, { version: pending.version }, { ...coordinator, ...tag })],
        ['unqualified withdraw by another user', () => POST(`${decision(draft.ID)}/withdrawProposal`, { version: pending.version }, { ...admin2, ...tag })],
        ['$batch approve by a donor', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'POST', url: `CampDecisions(${draft.ID})/ReliefService.approve`,
          headers: { 'content-type': 'application/json', 'if-match': pending['@odata.etag'] }, body: { version: pending.version } }] },
        { ...donor, headers: { 'content-type': 'application/json' } })]
      ]
      for (const [label, attempt] of routes) {
        const res = await outcome(attempt())
        const statuses = res.data?.responses ? res.data.responses.map(r => r.status) : [res.status]
        assert.ok(statuses.every(s => !ok(s)), `${label} answered ${statuses}`)
      }
      const still = await getDecision(draft.ID)
      assert.equal(still.status_code, 'PENDING')
      assert.equal(still.version, pending.version)
      // a donor cannot propose a withdrawal or resolve a review
      assert.equal((await outcome(POST(`${camp(other)}/ReliefService.proposeWithdrawal`, { standard: 'NET', reason: 'x' }, donor))).status, 403)
      const [anyRequest] = (await GET(`${R}/Requests?$top=1`, coordinator)).data.value
      assert.equal((await outcome(POST(`${R}/Requests(${anyRequest.ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'x' }, donor))).status, 403)
      // the identity comes from the session, never from the client
      const spoof = await outcome(POST(`${camp(await createCamp('Spoof Camp'))}/ReliefService.proposeApplicability`,
        { standard: 'NET', applicability: 'APPLICABLE', reason: 'Spoof', reviewDate: day(30), proposedBy: 'admin2', approvedBy: 'admin2', status_code: 'APPROVED' }, coordinator))
      if (ok(spoof.status)) {
        const d = await getDecision(spoof.data.ID)
        assert.equal(d.proposedBy, 'coordinator')
        assert.equal(d.status_code, 'PENDING')
        assert.equal(d.approvedBy, null)
      }
    })

    it('keeps donors out of decisions, reviews and approvals', async () => {
      const [d] = (await GET(`${R}/CampDecisions?$top=1`, coordinator)).data.value
      for (const p of [`${R}/CampDecisions`, `${R}/RequestReviews`, decision(d.ID), `${R}/attention()`])
        assert.equal((await outcome(GET(p, donor))).status, 403, p)
      for (const action of ['approve', 'rejectProposal', 'submit'])
        assert.equal((await outcome(act(d.ID, action, { version: 1, reason: 'x' }, donor))).status, 403, action)
      assert.equal((await outcome(propose(campID, {}, donor))).status, 403)
      const { data } = await GET(`${D}/$metadata`, donor)
      assert.doesNotMatch(data, /CampDecisions|RequestReviews|reviewDecision|currentReview|needsReview|approvedBy|proposedBy/)
    })
  })

  describe('effective dates and reviews', () => {
    let campID
    before(async () => { campID = await createCamp('Schedule Camp') })

    it('schedules a future decision without affecting today, then brings it into force on its date', async () => {
      const { data: now } = await propose(campID, { applicability: 'APPLICABLE', reason: 'Endemic', source: '' })
      await approve(now.ID)
      const { data: later } = await propose(campID, { effectiveFrom: day(3), reviewDate: day(60) })
      const res = await approve(later.ID)
      assert.equal(res.data.status_code, 'SCHEDULED')
      const { data: view } = await GET(decision(later.ID), coordinator)
      assert.match(view.displayStatus, /^Scheduled from/)
      assert.equal((await stockOf(campID)).NET.assessment, 'NO_REQUIREMENT', 'the decision in force still applies')
      assert.equal((await getDecision(now.ID)).status_code, 'APPROVED')
      const before = (await cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }))).length
      assert.equal(await require('../srv/lib/decisions').activateDue(), 0, 'not before its date')

      // the date arrives (moved here; the clock is not)
      await cds.run(UPDATE('reliefgrid.CampDecisions', later.ID).with({ effectiveFrom: day(0) }))
      assert.equal(await require('../srv/lib/decisions').activateDue(), 1)
      assert.equal((await getDecision(later.ID)).status_code, 'APPROVED')
      assert.equal((await getDecision(now.ID)).status_code, 'SUPERSEDED')
      assert.equal((await stockOf(campID)).NET.assessment, 'NOT_APPLICABLE')
      const recs = await cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }))
      assert.equal(recs.length, before + 1)
      assert.equal((await lastRecord(campID)).triggerID, later.ID)
    })

    it('keeps an overdue decision in force and only reports it', async () => {
      const [d] = (await GET(`${camp(campID)}/decisions?$filter=status_code eq 'APPROVED'`, coordinator)).data.value
      await cds.run(UPDATE('reliefgrid.CampDecisions', d.ID).with({ reviewDate: day(-1) }))
      const state = (await stockOf(campID)).NET.assessment
      const { data: view } = await GET(decision(d.ID), coordinator)
      assert.equal(view.reviewOverdue, true)
      assert.equal(view.displayStatus, 'In force, review overdue')
      assert.equal(view.status_code, 'APPROVED')
      assert.equal((await stockOf(campID)).NET.assessment, state, 'no silent reclassification')
      const { data: attention } = await GET(`${R}/attention()`, coordinator)
      assert.ok(attention.value.some(i => i.kind === 'REVIEW_OVERDUE' && i.decisionID === d.ID))
      assert.ok((await GET(`${R}/overview()`, coordinator)).data.overdueReviews >= 1)
    })
  })

  describe('requests when an indicator stops applying', () => {
    let campID, requests
    before(async () => {
      campID = await createCamp('Review Camp', 200)
      for (const c of ['WATER', 'SOAP', 'FOOD', 'LAUNDRY']) await count(campID, c, 0)
      await POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator)
      requests = Object.fromEntries((await GET(`${camp(campID)}/requests`, coordinator)).data.value.map(r => [r.standard_code, r]))
      // WATER partly pledged, SOAP fully pledged, FOOD partly pledged and partly delivered, LAUNDRY unpledged
      const pledge = (r, quantity) => POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Review Donor', quantity }, donor)
      await pledge(requests.WATER, 1000)
      await pledge(requests.SOAP, Number(requests.SOAP.quantity))
      const { data: p } = await pledge(requests.FOOD, 100)
      await POST(`${R}/Pledges(${p.ID})/ReliefService.confirmDelivery`, { receivedQuantity: 100 }, coordinator)
      for (const c of ['WATER', 'SOAP', 'FOOD', 'LAUNDRY']) {
        const { data: d } = await propose(campID, { standard: c, reason: `${c} supplied by the host school`, source: 'Host agreement' })
        await approve(d.ID)
      }
    })
    const req = async ID => (await GET(`${R}/Requests(${ID})?$expand=currentReview,pledges`, coordinator)).data

    it('flags outstanding requests for review and cancels nothing', async () => {
      for (const c of ['WATER', 'SOAP', 'FOOD', 'LAUNDRY']) {
        const r = await req(requests[c].ID)
        assert.equal(r.review_code, 'PENDING', c)
        assert.equal(r.needsReview, true)
        assert.notEqual(r.status_code, 'CANCELLED', c)
        assert.equal(r.currentReview.cause, 'NOT_APPLICABLE')
        assert.ok(r.currentReview.decision_ID)
        assert.equal(r.basisAssessment_ID, requests[c].basisAssessment_ID, 'calculation basis unchanged')
      }
      const { data: board } = await GET(`${D}/Requests?$filter=campName eq 'Review Camp'`, donor)
      assert.equal(board.value.length, 0, 'not a pledge opportunity while under review')
      const pledge = await outcome(POST(`${D}/Requests(${requests.LAUNDRY.ID})/DonorService.pledge`, { donor: 'Late Donor', quantity: 1 }, donor))
      assert.equal(pledge.status, 404, 'hidden from donors')
      const cancel = await outcome(POST(`${R}/Requests(${requests.LAUNDRY.ID})/ReliefService.cancel`, {}, coordinator))
      assert.equal(code(cancel), 'REQUEST_UNDER_REVIEW')
    })

    it('requires a reason, cancels an unpledged request, keeps pledges, and never cancels a fully pledged one', async () => {
      const noReason = await outcome(POST(`${R}/Requests(${requests.LAUNDRY.ID})/ReliefService.resolveReview`, { resolution: 'CANCEL', reason: ' ' }, coordinator))
      assert.equal(noReason.status, 400)
      await POST(`${R}/Requests(${requests.LAUNDRY.ID})/ReliefService.resolveReview`, { resolution: 'CANCEL', reason: 'Not needed' }, coordinator)
      const laundry = await req(requests.LAUNDRY.ID)
      assert.equal(laundry.status_code, 'CANCELLED')
      assert.equal(laundry.review_code, 'CANCELLED')
      assert.equal(laundry.currentReview.resolvedBy, 'coordinator')
      assert.equal(laundry.currentReview.resolutionReason, 'Not needed')

      const waterBefore = await req(requests.WATER.ID)
      await POST(`${R}/Requests(${requests.WATER.ID})/ReliefService.resolveReview`, { resolution: 'CANCEL', reason: 'Only the pledged part' }, coordinator)
      const water = await req(requests.WATER.ID)
      assert.equal(water.review_code, 'REMAINDER_CANCELLED')
      assert.equal(Number(water.quantity), Number(waterBefore.pledgedQuantity))
      assert.deepEqual(water.pledges, waterBefore.pledges, 'donor pledges unchanged')

      const soap = await outcome(POST(`${R}/Requests(${requests.SOAP.ID})/ReliefService.resolveReview`, { resolution: 'CANCEL', reason: 'try' }, coordinator))
      assert.equal(soap.status, 409)
      assert.equal(code(soap), 'REVIEW_FULLY_PLEDGED')
      await POST(`${R}/Requests(${requests.SOAP.ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'Donor delivers anyway' }, coordinator)
      assert.equal((await req(requests.SOAP.ID)).review_code, 'KEPT')
    })

    it('never reverses a delivery or the stock it added', async () => {
      const stockBefore = (await stockOf(campID)).FOOD
      const before = await req(requests.FOOD.ID)
      await POST(`${R}/Requests(${requests.FOOD.ID})/ReliefService.resolveReview`, { resolution: 'CANCEL', reason: 'Remainder not needed' }, coordinator)
      const after = await req(requests.FOOD.ID)
      assert.equal(Number(after.deliveredQuantity), Number(before.deliveredQuantity))
      assert.equal(Number(after.quantity), Math.max(Number(before.pledgedQuantity), Number(before.deliveredQuantity)))
      assert.deepEqual(after.pledges, before.pledges)
      assert.equal((await stockOf(campID)).FOOD.quantity, stockBefore.quantity)
      const reviews = (await GET(`${R}/Requests(${requests.FOOD.ID})/reviews`, coordinator)).data.value
      assert.equal(reviews.length, 1)
      assert.equal(reviews[0].resolution_code, 'REMAINDER_CANCELLED')
    })
  })

  describe('Keep (closure review)', () => {
    let campID, request, decisionID
    const req = async () => (await GET(`${R}/Requests(${request.ID})?$expand=currentReview,pledges`, coordinator)).data
    const board = async () => (await GET(`${D}/Requests?$filter=ID eq ${request.ID}`, donor)).data.value
    const reviews = async () => (await GET(`${R}/Requests(${request.ID})/reviews?$orderby=flaggedAt`, coordinator)).data.value
    const sweep = () => cds.tx(() => require('../srv/lib/decisions').flagAllUnestablished('system'))
    before(async () => {
      campID = await createCamp('Keep Camp', 200)
      await count(campID, 'WATER', 0)
      await POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator)
      request = (await GET(`${camp(campID)}/requests?$filter=standard_code eq 'WATER'`, coordinator)).data.value[0]
      await POST(`${D}/Requests(${request.ID})/DonorService.pledge`, { donor: 'Keep Donor', quantity: 100 }, donor)
      const { data: d } = await propose(campID, { standard: 'WATER', reason: 'Water piped by the municipality', source: 'Municipal agreement' })
      await approve(d.ID)
      decisionID = d.ID
    })

    it('Keep ends the review but never offers a request for a non-applicable indicator to donors', async () => {
      assert.equal((await req()).review_code, 'PENDING')
      const pledgesBefore = (await req()).pledges
      await POST(`${R}/Requests(${request.ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'Keep until the pipe is tested' }, coordinator)
      const kept = await req()
      assert.equal(kept.review_code, 'KEPT')
      assert.equal(kept.needsReview, false)
      assert.equal(kept.status_code, 'PARTIAL', 'the request stays active, with its pledge')
      assert.deepEqual(kept.pledges, pledgesBefore)
      assert.equal(kept.currentReview.resolvedBy, 'coordinator')
      assert.equal((await stockOf(campID)).WATER.assessment, 'NOT_APPLICABLE')
      assert.equal((await board()).length, 0, 'not on the Pledge Board while the indicator does not apply')
      const pledge = await outcome(POST(`${D}/Requests(${request.ID})/DonorService.pledge`, { donor: 'Late Donor', quantity: 1 }, donor))
      assert.equal(pledge.status, 404)
    })

    it('a Keep is not undone at start-up while nothing has changed', async () => {
      assert.equal(await sweep(), 0)
      assert.equal((await req()).review_code, 'KEPT')
      assert.equal((await reviews()).length, 1, 'no new review row')
    })

    it('the start-up sweep flags a newly found request without re-flagging a kept one for the same indicator', async () => {
      // a request recorded before the indicator stopped being established (as after an upgrade)
      const ID = cds.utils.uuid()
      await cds.run(INSERT.into('reliefgrid.Requests').entries({ ID, camp_ID: campID, standard_code: 'WATER', quantity: 10, pledgedQuantity: 0,
        deliveredQuantity: 0, priority_code: 2, status_code: 'OPEN' }))
      assert.equal(await sweep(), 1)
      assert.equal((await cds.run(SELECT.one.from('reliefgrid.Requests').where({ ID }))).review_code, 'PENDING')
      assert.equal((await req()).review_code, 'KEPT', 'the kept request stays kept')
      assert.equal((await reviews()).length, 1)
      await POST(`${R}/Requests(${ID})/ReliefService.resolveReview`, { resolution: 'CANCEL', reason: 'Recorded by mistake' }, coordinator)
    })

    it('resolving twice is refused, and of two simultaneous resolutions only one goes through', async () => {
      const again = await outcome(POST(`${R}/Requests(${request.ID})/ReliefService.resolveReview`, { resolution: 'CANCEL', reason: 'again' }, coordinator))
      assert.equal(again.status, 409)
      assert.equal(code(again), 'REVIEW_NOT_PENDING')
      const other = await createCamp('Keep Race Camp', 200)
      await count(other, 'SOAP', 0)
      await POST(`${camp(other)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = (await GET(`${camp(other)}/requests?$filter=standard_code eq 'SOAP'`, coordinator)).data.value
      const { data: d } = await propose(other, { standard: 'SOAP', reason: 'Soap supplied by the host', source: 'Host agreement' })
      await approve(d.ID)
      const results = await Promise.all(['KEEP', 'CANCEL'].map(resolution =>
        outcome(POST(`${R}/Requests(${r.ID})/ReliefService.resolveReview`, { resolution, reason: 'race' }, coordinator))))
      assert.deepEqual(results.map(x => x.status).sort(), [200, 409])
      const rows = await cds.run(SELECT.from('reliefgrid.RequestReviews').where({ request_ID: r.ID }))
      assert.equal(rows.length, 1)
      assert.notEqual(rows[0].resolution_code, 'PENDING')
    })

    it('a request still waiting for its review stays off the Pledge Board even after the indicator applies again', async () => {
      const other = await createCamp('Pending Review Camp', 200)
      await count(other, 'SOAP', 0)
      await POST(`${camp(other)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = (await GET(`${camp(other)}/requests?$filter=standard_code eq 'SOAP'`, coordinator)).data.value
      const { data: d } = await propose(other, { standard: 'SOAP', reason: 'Soap supplied by the host', source: 'Host agreement' })
      await approve(d.ID)
      const { data: w } = await POST(`${camp(other)}/ReliefService.proposeWithdrawal`, { standard: 'SOAP', reason: 'Host stopped' }, coordinator)
      await approve(w.ID)
      assert.equal((await stockOf(other)).SOAP.assessment, 'CRITICAL')
      assert.equal((await GET(`${R}/Requests(${r.ID})`, coordinator)).data.review_code, 'PENDING', 'the review is not dropped by itself')
      assert.equal((await GET(`${D}/Requests?$filter=ID eq ${r.ID}`, donor)).data.value.length, 0)
      const pledge = await outcome(POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Early Donor', quantity: 1 }, donor))
      assert.ok(!ok(pledge.status))
      await POST(`${R}/Requests(${r.ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'Needed again' }, coordinator)
      assert.equal((await GET(`${D}/Requests?$filter=ID eq ${r.ID}`, donor)).data.value.length, 1, 'offered once the review is resolved')
    })

    it('when the indicator applies again the kept request is offered again; a later change reviews it again', async () => {
      const { data: w } = await POST(`${camp(campID)}/ReliefService.proposeWithdrawal`, { standard: 'WATER', reason: 'Pipe failed' }, coordinator)
      await approve(w.ID)
      assert.equal((await getDecision(decisionID)).status_code, 'WITHDRAWN')
      assert.equal((await stockOf(campID)).WATER.assessment, 'CRITICAL')
      assert.equal((await board()).length, 1, 'derived from the indicator: offered again without a new review')
      const { data: again } = await propose(campID, { standard: 'WATER', reason: 'Pipe repaired', source: 'Municipal engineer report' })
      await approve(again.ID)
      const r = await req()
      assert.equal(r.review_code, 'PENDING')
      assert.equal(r.currentReview.decision_ID, again.ID)
      const history = await reviews()
      assert.equal(history.length, 2, 'every review is kept')
      assert.equal(history[0].resolution_code, 'KEPT')
      assert.equal(history[0].resolutionReason, 'Keep until the pipe is tested')
      assert.equal((await board()).length, 0)
    })
  })

  describe('immutability', () => {
    it('refuses every write route to decisions and reviews, for every role', async () => {
      const campID = await createCamp('Immutable Camp')
      const { data: d } = await propose(campID, {})
      const [review] = (await GET(`${R}/RequestReviews?$top=1`, coordinator)).data.value
      const json = { headers: { 'content-type': 'application/json' } }
      for (const user of [admin, coordinator]) {
        const routes = [
          ['POST decision', () => POST(`${R}/CampDecisions`, { camp_ID: campID, standard_code: 'NET', status_code: 'APPROVED', applicable: true }, user)],
          ['PATCH decision', () => PATCH(decision(d.ID), { status_code: 'APPROVED' }, user)],
          ['PUT decision', () => PUT(decision(d.ID), { ...d, status_code: 'APPROVED' }, user)],
          ['DELETE decision', () => axios.delete(decision(d.ID), user)],
          ['POST via camp navigation', () => POST(`${camp(campID)}/decisions`, { standard_code: 'NET', status_code: 'APPROVED', applicable: true }, user)],
          ['PATCH via stock navigation', () => PATCH(`${R}/Stock(${d.ID})/applicability`, { applicable: true }, user)],
          ['PATCH review', () => PATCH(`${R}/RequestReviews(${review.ID})`, { resolution_code: 'KEPT' }, user)],
          ['DELETE review', () => axios.delete(`${R}/RequestReviews(${review.ID})`, user)],
          ['$batch PATCH decision', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'PATCH', url: `CampDecisions(${d.ID})`, headers: { 'content-type': 'application/json' }, body: { status_code: 'APPROVED' } }] }, { ...user, ...json })],
          ['$batch POST decision', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'POST', url: 'CampDecisions', headers: { 'content-type': 'application/json' }, body: { camp_ID: campID, standard_code: 'NET' } }] }, { ...user, ...json })]
        ]
        for (const [label, attempt] of routes) {
          const before = [await cds.run(SELECT.from('reliefgrid.CampDecisions').orderBy('ID')), await cds.run(SELECT.from('reliefgrid.RequestReviews').orderBy('ID'))]
          const res = await outcome(attempt())
          const statuses = res.data?.responses ? res.data.responses.map(r => r.status) : [res.status]
          assert.ok(statuses.every(s => !ok(s)), `${user.auth.username} ${label} answered ${statuses}`)
          assert.deepEqual([await cds.run(SELECT.from('reliefgrid.CampDecisions').orderBy('ID')), await cds.run(SELECT.from('reliefgrid.RequestReviews').orderBy('ID'))], before, label)
        }
      }
      // deep update through a camp draft
      await POST(`${camp(campID)}/ReliefService.draftEdit`, { PreserveChanges: true }, coordinator)
      const key = `${R}/Camps(ID=${campID},IsActiveEntity=false)`
      const before = await cds.run(SELECT.from('reliefgrid.CampDecisions').orderBy('ID'))
      await outcome(PATCH(key, { decisions: [{ standard_code: 'WATER', status_code: 'APPROVED', applicable: false }] }, coordinator))
      await outcome(POST(`${key}/ReliefService.draftActivate`, {}, coordinator))
      assert.deepEqual(await cds.run(SELECT.from('reliefgrid.CampDecisions').orderBy('ID')), before, 'deep update through a camp draft')
    })

    it('declares decisions and reviews read-only, with approval and rejection reserved for Administrators', () => {
      for (const name of ['ReliefService.CampDecisions', 'ReliefService.RequestReviews']) assert.equal(cds.model.definitions[name]['@readonly'], true)
      const actions = cds.model.definitions['ReliefService.CampDecisions'].actions
      assert.equal(actions.approve['@requires'], 'Administrator')
      assert.equal(actions.rejectProposal['@requires'], 'Administrator')
    })
  })

  describe('transactions and concurrency', () => {
    let failOn = null
    // runs once, inside the transaction, just before the next write to a decision: what another instance could do in between
    let interleave = null
    before(() => {
      for (const entity of ['reliefgrid.AssessmentRecords', 'reliefgrid.RequestReviews'])
        cds.db.before('CREATE', entity, () => { if (failOn === entity) { failOn = null; throw new Error('injected failure') } })
      cds.db.before('UPDATE', 'reliefgrid.CampDecisions', async () => { if (interleave) { const f = interleave; interleave = null; await f() } })
    })
    const snapshot = async campID => ({
      decisions: await cds.run(SELECT.from('reliefgrid.CampDecisions').where({ camp_ID: campID }).orderBy('ID')),
      requests: await cds.run(SELECT.from('reliefgrid.Requests').where({ camp_ID: campID }).orderBy('ID')),
      reviews: await cds.run(SELECT.from('reliefgrid.RequestReviews').orderBy('ID')),
      records: await cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }).orderBy('ID'))
    })

    for (const entity of ['reliefgrid.AssessmentRecords', 'reliefgrid.RequestReviews']) {
      it(`rolls an approval back completely when writing ${entity.split('.')[1]} fails`, async () => {
        const campID = await createCamp(`Rollback ${entity}`)
        await count(campID, 'WATER', 0)
        await POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator)
        const { data: d } = await propose(campID, { standard: 'WATER', reason: 'Piped supply', source: 'Utility' })
        const before = await snapshot(campID)
        failOn = entity
        const res = await outcome(approve(d.ID))
        assert.equal(failOn, null, 'the failing write was reached')
        assert.ok(!ok(res.status))
        assert.deepEqual(await snapshot(campID), before)
        assert.equal((await stockOf(campID)).WATER.assessment, 'CRITICAL')
      })
    }

    it('lets only one of two simultaneous submissions for the same camp and indicator become pending', async () => {
      const campID = await createCamp('Submit Race Camp')
      const { data: a } = await propose(campID, { saveAsDraft: true })
      const { data: b } = await propose(campID, { saveAsDraft: true, applicability: 'APPLICABLE', source: '' })
      const results = await Promise.all([a, b].map(d => outcome(act(d.ID, 'submit', { version: d.version }, coordinator))))
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
      assert.equal(code(results.find(r => r.status === 409)), 'DECISION_ALREADY_OPEN')
      const pending = await cds.run(SELECT.from('reliefgrid.CampDecisions').where({ camp_ID: campID, status_code: 'PENDING' }))
      assert.equal(pending.length, 1)
    })

    it('activates a due scheduled decision once when the scheduler runs twice at the same time', async () => {
      const campID = await createCamp('Scheduler Race Camp')
      const { data: d } = await propose(campID, { effectiveFrom: day(2), reviewDate: day(60) })
      await approve(d.ID)
      await cds.run(UPDATE('reliefgrid.CampDecisions', d.ID).with({ effectiveFrom: day(0) }))
      const { activateDue } = require('../srv/lib/decisions')
      const runs = await Promise.all([activateDue(), activateDue()])
      assert.equal(runs[0] + runs[1], 1)
      const records = await cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID, triggerID: d.ID }))
      assert.equal(records.length, 1, 'one assessment record')
      assert.equal((await getDecision(d.ID)).status_code, 'APPROVED')
    })

    it('refuses a decision change when another instance changed the decision after it was read (compare-and-set)', async () => {
      const campID = await createCamp('CAS Camp')
      const { data: d } = await propose(campID, {})
      interleave = () => cds.run(UPDATE('reliefgrid.CampDecisions', d.ID).with({ version: { '+=': 1 } }))
      const res = await outcome(approve(d.ID, admin))
      assert.equal(interleave, null, 'the interleaved change ran')
      assert.equal(res.status, 409)
      assert.equal(code(res), 'DECISION_CHANGED_MEANWHILE')
      const after = await getDecision(d.ID)
      assert.equal(after.status_code, 'PENDING')
      assert.equal(after.version, d.version, 'rolled back as a whole')
      assert.equal((await stockOf(campID)).NET.assessment, 'NOT_DECIDED')
    })

    it('does not activate a scheduled decision that another instance claimed after it was read', async () => {
      const campID = await createCamp('Claim Camp')
      const { data: d } = await propose(campID, { effectiveFrom: day(2), reviewDate: day(60) })
      await approve(d.ID)
      await cds.run(UPDATE('reliefgrid.CampDecisions', d.ID).with({ effectiveFrom: day(0) }))
      interleave = () => cds.run(UPDATE('reliefgrid.CampDecisions', d.ID).with({ version: { '+=': 1 } }))
      assert.equal(await require('../srv/lib/decisions').activateDue(), 0)
      assert.equal(interleave, null, 'the interleaved claim ran')
      assert.equal((await getDecision(d.ID)).status_code, 'SCHEDULED', 'left to the instance that claimed it')
      const records = await cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID, triggerID: d.ID }))
      assert.equal(records.length, 0)
    })

    it('lets only one of two simultaneous approvals through', async () => {
      const campID = await createCamp('Race Camp')
      const { data: d } = await propose(campID, {})
      const results = await Promise.all([outcome(approve(d.ID, admin)), outcome(approve(d.ID, admin2))])
      const statuses = results.map(r => r.status).sort()
      // the loser is refused as stale: by CAP's If-Match check (412) or by the version check (409), depending on timing
      assert.equal(statuses[0], 200)
      assert.ok([409, 412].includes(statuses[1]), String(statuses))
      const inForce = await cds.run(SELECT.from('reliefgrid.CampDecisions').where({ camp_ID: campID, status_code: 'APPROVED' }))
      assert.equal(inForce.length, 1)
    })

    it('refuses a second proposal approved over a decision that changed meanwhile', async () => {
      const campID = await createCamp('Context Camp')
      const { data: a } = await propose(campID, {})
      // a second pending proposal, as two simultaneous submissions could produce
      const b = { ...(await cds.run(SELECT.one.from('reliefgrid.CampDecisions').where({ ID: a.ID }))), ID: cds.utils.uuid(), applicable: true }
      await cds.run(INSERT.into('reliefgrid.CampDecisions').entries(b))
      await approve(a.ID)
      const res = await outcome(approve(b.ID))
      assert.equal(res.status, 409)
      assert.equal(code(res), 'DECISION_CONTEXT_CHANGED')
      const inForce = await cds.run(SELECT.from('reliefgrid.CampDecisions').where({ camp_ID: campID, status_code: 'APPROVED' }))
      assert.equal(inForce.length, 1)
    })
  })

  // Fiori elements calls bound actions through the camp page's navigation path; the action must act on its own entity.
  describe('actions reached through the camp page', () => {
    it('record count, cancel, confirm delivery, approve and resolve review all act on the right record', async () => {
      const campID = await createCamp('Navigation Camp', 100)
      const path = `${camp(campID)}`
      const { WATER, SOAP } = await stockOf(campID)
      await POST(`${path}/stock(${WATER.ID})/ReliefService.recordCount`, { quantity: 0 }, coordinator)
      await POST(`${path}/stock(${SOAP.ID})/ReliefService.recordCount`, { quantity: 0 }, coordinator)
      assert.equal(Number((await stockOf(campID)).WATER.quantity), 0, 'record count through camp/stock')
      await POST(`${path}/ReliefService.raiseRequests`, {}, coordinator)
      const reqs = Object.fromEntries((await GET(`${path}/requests`, coordinator)).data.value.map(r => [r.standard_code, r]))
      await POST(`${path}/requests(${reqs.SOAP.ID})/ReliefService.cancel`, {}, coordinator)
      assert.equal((await GET(`${R}/Requests(${reqs.SOAP.ID})`, coordinator)).data.status_code, 'CANCELLED', 'cancel through camp/requests')
      const { data: p } = await POST(`${D}/Requests(${reqs.WATER.ID})/DonorService.pledge`, { donor: 'Navigation Donor', quantity: 100 }, donor)
      await POST(`${path}/requests(${reqs.WATER.ID})/pledges(${p.ID})/ReliefService.confirmDelivery`, { receivedQuantity: 100 }, coordinator)
      assert.equal((await GET(`${R}/Pledges(${p.ID})`, coordinator)).data.status_code, 'DELIVERED', 'confirm delivery through camp/requests/pledges')
      const { data: d } = await propose(campID, { standard: 'WATER', reason: 'Piped supply', source: 'Utility' })
      const tag = (await GET(decision(d.ID), admin)).data['@odata.etag']
      await POST(`${path}/decisions(${d.ID})/ReliefService.approve`, { version: d.version }, { ...admin, headers: { 'if-match': tag } })
      assert.equal((await getDecision(d.ID)).status_code, 'APPROVED', 'approve through camp/decisions')
      await POST(`${path}/requests(${reqs.WATER.ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'Keep' }, coordinator)
      assert.equal((await GET(`${R}/Requests(${reqs.WATER.ID})`, coordinator)).data.review_code, 'KEPT', 'resolve review through camp/requests')
    })
  })

  describe('Command Center data', () => {
    it('reports undecided indicators, pending and scheduled decisions and requests to review consistently', async () => {
      const { data: o } = await GET(`${R}/overview()`, coordinator)
      const { data: a } = await GET(`${R}/attention()`, coordinator)
      const n = kind => a.value.filter(i => i.kind === kind).length
      assert.equal(o.decisionsNeeded, n('NOT_DECIDED'))
      assert.equal(o.pendingDecisions, n('PENDING'))
      assert.equal(o.scheduledDecisions, n('SCHEDULED'))
      assert.equal(o.overdueReviews, n('REVIEW_OVERDUE'))
      assert.equal(o.requestsToReview, n('REQUEST_REVIEW'))
      assert.ok(o.decisionsNeeded > 0 && o.pendingDecisions > 0)
    })
  })
})
