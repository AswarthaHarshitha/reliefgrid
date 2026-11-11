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
const table = (name, where = {}) => cds.run(SELECT.from(`reliefgrid.${name}`).where(where))
const { activateDue } = require('../srv/lib/decisions')

async function createCamp(name, headcount = 100) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}
const stockOf = async campID => Object.fromEntries((await GET(`${camp(campID)}/stock`, coordinator)).data.value.map(s => [s.standard_code, s]))
const count = async (campID, c, quantity) => POST(`${R}/Stock(${(await stockOf(campID))[c].ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(c) ? { functionalUnits: quantity } : {}) }, coordinator)
const phaseOf = async campID => (await GET(`${camp(campID)}/phaseInfo`, coordinator)).data
const proposePhase = (campID, body = {}, user = coordinator) => POST(`${camp(campID)}/ReliefService.proposePhase`,
  { responsePhase: 'FIRST_PHASE', reason: 'Rapid-onset flood, communal toilets being built', source: 'WASH cluster sitrep 4', effectiveFrom: day(0), reviewDate: day(30), ...body }, user)
const getDecision = async ID => (await GET(decision(ID), admin)).data
const act = async (ID, action, body, user, etag) => {
  const tag = etag ?? (await GET(decision(ID), admin)).data['@odata.etag']
  return POST(`${decision(ID)}/ReliefService.${action}`, body, { ...user, headers: { 'if-match': tag } })
}
const approve = async (ID, user = admin) => act(ID, 'approve', { version: (await getDecision(ID)).version }, user)
const records = campID => cds.run(SELECT.from('reliefgrid.AssessmentRecords').where({ camp_ID: campID }).orderBy('assessedAt'))
const lineOf = async (recordID, standardCode) => (await table('AssessmentRecordLines', { record_ID: recordID, standardCode }))[0]

describe('B4.4 response phase', () => {
  describe('default and figures', () => {
    it('a camp without a decision is in the medium term by default, and says so', async () => {
      const c = await createCamp('Default Phase Camp')
      const p = await phaseOf(c)
      assert.equal(p.responsePhase, 'MEDIUM_TERM')
      assert.equal(p.responsePhaseBasis, 'DEFAULT', 'the default is never presented as a decision')
      assert.equal(p.responsePhaseText, 'Medium term (default, no decision)')
      assert.equal(p.phaseDecisionID, null)
      const { TOILET, WATER } = await stockOf(c)
      assert.equal(Number(TOILET.perPerson), 0.05)
      assert.equal(Number(TOILET.required), 5, '1 per 20 people for 100 people')
      assert.equal(TOILET.targetBasis, 'REFERENCE_FIGURE')
      assert.equal(TOILET.targetBasisText, 'Medium-term figure')
      assert.equal(WATER.targetBasisText, 'Reference figure', 'other indicators are not phase-dependent')
    })

    it('keeps the first-phase figure and its source in the reference data, beside the medium-term figure', async () => {
      const { data } = await GET(`${R}/Standards('TOILET')`, coordinator)
      assert.equal(Number(data.perPerson), 0.05)
      assert.equal(Number(data.perPersonFirstPhase), 0.02)
      assert.match(data.firstPhaseReference, /p\. 118: communal toilets at a minimum of 1 per 50 people in the first phases of a rapid-onset crisis/)
      const others = (await GET(`${R}/Standards?$filter=perPersonFirstPhase ne null`, coordinator)).data.value
      assert.deepEqual(others.map(s => s.code), ['TOILET'])
    })
  })

  describe('proposal and approval', () => {
    let c, d
    before(async () => { c = await createCamp('Phase Workflow Camp'); await count(c, 'TOILET', 3) })

    it('needs a phase, a reason, an effective date and a future review date; it names no indicator', async () => {
      for (const [body, expected] of [
        [{ responsePhase: 'EMERGENCY' }, ['PHASE_VALUE_REQUIRED', 'ASSERT_RANGE', 'ASSERT_ENUM']],
        [{ responsePhase: null }, ['PHASE_VALUE_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ reason: ' ' }, ['DECISION_REASON_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ effectiveFrom: null }, ['PHASE_EFFECTIVE_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ effectiveFrom: day(-1) }, ['DECISION_BACKDATED']],
        [{ reviewDate: null }, ['DECISION_REVIEW_DATE_REQUIRED', 'ASSERT_MANDATORY', 'ASSERT_NOT_NULL']],
        [{ reviewDate: day(0) }, ['DECISION_REVIEW_DATE_FUTURE']]
      ]) {
        const res = await outcome(proposePhase(c, body))
        assert.equal(res.status, 400, JSON.stringify(body))
        assert.ok(expected.includes(code(res)), `${JSON.stringify(body)}: ${code(res)}`)
      }
      assert.equal((await table('CampDecisions', { camp_ID: c })).length, 0)
      const res = await proposePhase(c)
      d = res.data
      assert.equal(d.kind, 'PHASE')
      assert.equal(d.standard_code, null)
      assert.equal(d.responsePhase, 'FIRST_PHASE')
      assert.equal(d.previousResponsePhase, null)
      assert.equal(d.status_code, 'PENDING')
      const v = await getDecision(d.ID)
      assert.equal(v.subjectText, 'Response phase')
      assert.equal(v.kindText, 'Response phase')
      assert.equal(v.valueText, 'First phase of a rapid-onset crisis (toilets: 1 per 50 people)')
      assert.equal(v.previousText, 'Medium term (default, no decision)')
    })

    it('a coordinator cannot approve, and nobody approves their own proposal', async () => {
      assert.equal((await outcome(approve(d.ID, coordinator))).status, 403)
      const { data: own } = await proposePhase(await createCamp('Own Phase Camp'), {}, admin)
      const self = await outcome(approve(own.ID, admin))
      assert.equal(code(self), 'DECISION_SELF_APPROVAL')
      assert.equal((await phaseOf(c)).responsePhase, 'MEDIUM_TERM', 'nothing changes before approval')
    })

    it('another Administrator approves; the first-phase figure then applies to toilets only', async () => {
      const res = await approve(d.ID, admin2)
      assert.equal(res.data.status_code, 'APPROVED')
      const p = await phaseOf(c)
      assert.equal(p.responsePhase, 'FIRST_PHASE')
      assert.equal(p.responsePhaseBasis, 'DECIDED')
      assert.equal(p.responsePhaseText, 'First phase of a rapid-onset crisis')
      assert.equal(p.phaseDecisionID, d.ID)
      const { TOILET, WATER, TAP } = await stockOf(c)
      assert.equal(Number(TOILET.perPerson), 0.02)
      assert.equal(Number(TOILET.required), 2, '1 per 50 people for 100 people')
      assert.equal(TOILET.targetBasis, 'PHASE_FIGURE')
      assert.equal(TOILET.targetBasisText, 'First-phase figure')
      assert.equal(TOILET.assessment, 'MET', '3 toilets for 2 required')
      assert.equal(Number(WATER.required), 1500)
      assert.equal(Number(TAP.required), 0.4)
    })

    it('a later decision supersedes it; a withdrawal returns the camp to the default', async () => {
      const { data: medium } = await proposePhase(c, { responsePhase: 'MEDIUM_TERM', reason: 'Camp stabilised' })
      assert.equal(medium.previousResponsePhase, 'FIRST_PHASE')
      assert.equal(medium.previousDecision_ID, d.ID)
      await approve(medium.ID)
      assert.equal((await getDecision(d.ID)).status_code, 'SUPERSEDED')
      let p = await phaseOf(c)
      assert.equal(p.responsePhase, 'MEDIUM_TERM')
      assert.equal(p.responsePhaseBasis, 'DECIDED')
      assert.equal(p.responsePhaseText, 'Medium term')
      assert.equal((await stockOf(c)).TOILET.assessment, 'ATTENTION', '3 of 5 is 60 %')
      const missing = await outcome(POST(`${camp(c)}/ReliefService.proposePhaseWithdrawal`, { reason: 'x' }, coordinator))
      assert.equal(missing.status, 400)
      const { data: w } = await POST(`${camp(c)}/ReliefService.proposePhaseWithdrawal`, { reason: 'Decision no longer needed', effectiveFrom: day(0) }, coordinator)
      await approve(w.ID)
      assert.equal((await getDecision(medium.ID)).status_code, 'WITHDRAWN')
      p = await phaseOf(c)
      assert.equal(p.responsePhaseBasis, 'DEFAULT')
      const nothing = await outcome(POST(`${camp(c)}/ReliefService.proposePhaseWithdrawal`, { reason: 'again', effectiveFrom: day(0) }, coordinator))
      assert.equal(code(nothing), 'PHASE_NOTHING_TO_WITHDRAW')
    })

    it('a scheduled phase does not apply before its date, then takes effect once', async () => {
      const s = await createCamp('Scheduled Phase Camp')
      const { data: f } = await proposePhase(s, { effectiveFrom: day(3), reviewDate: day(40) })
      assert.equal((await approve(f.ID)).data.status_code, 'SCHEDULED')
      assert.equal((await phaseOf(s)).responsePhase, 'MEDIUM_TERM')
      assert.equal(await activateDue(), 0)
      await cds.run(UPDATE('reliefgrid.CampDecisions', f.ID).with({ effectiveFrom: day(0) }))
      const runs = await Promise.all([activateDue(), activateDue()])
      assert.equal(runs[0] + runs[1], 1)
      assert.equal((await phaseOf(s)).responsePhase, 'FIRST_PHASE')
    })
  })

  describe('with the other decision kinds', () => {
    it('phase, applicability and local target proposals wait side by side; a local target on toilets takes precedence', async () => {
      const c = await createCamp('Three Kinds Camp')
      const { data: phase } = await proposePhase(c)
      const { data: target } = await POST(`${camp(c)}/ReliefService.proposeTarget`,
        { standard: 'TOILET', targetPerPerson: 0.04, reason: 'Night-time safety', source: 'Protection cluster', reviewDate: day(60) }, coordinator)
      const { data: appl } = await POST(`${camp(c)}/ReliefService.proposeApplicability`,
        { standard: 'NET', applicability: 'APPLICABLE', reason: 'Malaria', reviewDate: day(60) }, coordinator)
      assert.ok(phase.ID && target.ID && appl.ID)
      await approve(target.ID)
      await approve(phase.ID)
      const { TOILET } = await stockOf(c)
      assert.equal(TOILET.targetBasis, 'LOCAL_TARGET')
      assert.equal(Number(TOILET.required), 4, 'the local target, not the first-phase figure')
      assert.equal(Number(TOILET.referencePerPerson), 0.02, 'the baseline the local target replaces is now the first-phase figure')
      const all = (await GET(`${camp(c)}/stock`, coordinator)).data.value
      assert.equal(all.length, 9, 'one line per indicator')
    })

    it('an applicability decision stays authoritative', async () => {
      const c = await createCamp('Phase Not Applicable Camp')
      const { data: na } = await POST(`${camp(c)}/ReliefService.proposeApplicability`,
        { standard: 'TOILET', applicability: 'NOT_APPLICABLE', reason: 'Host facilities', source: 'Host letter', reviewDate: day(60) }, coordinator)
      await approve(na.ID)
      const { data: f } = await proposePhase(c)
      await approve(f.ID)
      assert.equal((await stockOf(c)).TOILET.assessment, 'NOT_APPLICABLE')
    })
  })

  describe('requests', () => {
    it('a phase change that changes the toilet requirement flags outstanding toilet requests; nothing is cancelled', async () => {
      const c = await createCamp('Phase Request Camp')
      await count(c, 'TOILET', 1)
      await count(c, 'WATER', 0)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const reqs = Object.fromEntries((await GET(`${camp(c)}/requests`, coordinator)).data.value.map(r => [r.standard_code, r]))
      assert.equal(Number(reqs.TOILET.quantity), 4)
      await POST(`${D}/Requests(${reqs.TOILET.ID})/DonorService.pledge`, { donor: 'Phase Donor', quantity: 1 }, donor)
      const before = (await GET(`${R}/Requests(${reqs.TOILET.ID})?$expand=pledges`, coordinator)).data
      const { data: f } = await proposePhase(c)
      await approve(f.ID)
      const after = (await GET(`${R}/Requests(${reqs.TOILET.ID})?$expand=pledges,currentReview`, coordinator)).data
      assert.equal(after.review_code, 'PENDING')
      assert.equal(after.currentReview.cause, 'PHASE_CHANGED')
      assert.equal(after.currentReview.decision_ID, f.ID)
      assert.equal(after.quantity, before.quantity)
      assert.deepEqual(after.pledges, before.pledges)
      assert.equal((await GET(`${R}/Requests(${reqs.WATER.ID})`, coordinator)).data.review_code, null, 'water is not phase-dependent')
      assert.equal((await GET(`${D}/Requests?$filter=ID eq ${reqs.TOILET.ID}`, donor)).data.value.length, 0)
    })

    it('no request is flagged where a local target replaces the phase figure', async () => {
      const c = await createCamp('Phase Target Request Camp')
      const { data: t } = await POST(`${camp(c)}/ReliefService.proposeTarget`,
        { standard: 'TOILET', targetPerPerson: 0.05, reason: 'Keep 1 per 20', source: 'Cluster note', reviewDate: day(60) }, coordinator)
      await approve(t.ID)
      await count(c, 'TOILET', 1)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
      const [r] = (await GET(`${camp(c)}/requests?$filter=standard_code eq 'TOILET'`, coordinator)).data.value
      const { data: f } = await proposePhase(c)
      await approve(f.ID)
      assert.equal((await GET(`${R}/Requests(${r.ID})`, coordinator)).data.review_code, null)
    })
  })

  describe('history', () => {
    it('every assessment keeps the phase it used, decided or default, and earlier records are never rewritten', async () => {
      const c = await createCamp('Phase History Camp')
      await count(c, 'TOILET', 3)
      const first = (await records(c)).at(-1)
      assert.equal(first.responsePhase, 'MEDIUM_TERM')
      assert.equal(first.responsePhaseBasis, 'DEFAULT')
      assert.equal(first.phaseDecisionID, null)
      assert.equal((await lineOf(first.ID, 'TOILET')).requirementBasis, 'REFERENCE_FIGURE')
      const snapshot = [await table('AssessmentRecords', { ID: first.ID }), await table('AssessmentRecordLines', { record_ID: first.ID })]
      const { data: f } = await proposePhase(c)
      await approve(f.ID)
      const after = (await records(c)).at(-1)
      assert.equal(after.trigger, 'DECISION_EFFECTIVE')
      assert.equal(after.responsePhase, 'FIRST_PHASE')
      assert.equal(after.responsePhaseBasis, 'DECIDED')
      assert.equal(after.phaseDecisionID, f.ID)
      assert.equal(after.phaseDecisionVersion, (await getDecision(f.ID)).version)
      const toilet = await lineOf(after.ID, 'TOILET')
      assert.equal(toilet.requirementBasis, 'PHASE_FIGURE')
      assert.equal(Number(toilet.perPerson), 0.02)
      assert.equal(Number(toilet.requirement), 2)
      assert.deepEqual([await table('AssessmentRecords', { ID: first.ID }), await table('AssessmentRecordLines', { record_ID: first.ID })], snapshot)
      await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator).catch(() => {})
    })

    it('rolls a phase approval back completely when the assessment cannot be written', async () => {
      const c = await createCamp('Phase Rollback Camp')
      const { data: f } = await proposePhase(c)
      let fail = true
      cds.db.before('CREATE', 'reliefgrid.AssessmentRecords', () => { if (fail) { fail = false; throw new Error('injected failure') } })
      const before = [await table('CampDecisions', { camp_ID: c }), await table('AssessmentRecords', { camp_ID: c })]
      const res = await outcome(approve(f.ID))
      assert.ok(res.status >= 400)
      assert.equal(fail, false)
      assert.deepEqual([await table('CampDecisions', { camp_ID: c }), await table('AssessmentRecords', { camp_ID: c })], before)
      assert.equal((await phaseOf(c)).responsePhase, 'MEDIUM_TERM')
    })
  })

  describe('reviews and the Command Center', () => {
    it('a phase decision can be reviewed; its pending and overdue items name the response phase', async () => {
      const c = await createCamp('Phase Review Camp')
      const { data: f } = await proposePhase(c)
      let attention = (await GET(`${R}/attention()`, coordinator)).data.value
      const pending = attention.find(i => i.decisionID === f.ID)
      assert.equal(pending.kind, 'PENDING')
      assert.equal(pending.decisionKind, 'PHASE')
      assert.equal(pending.standardName, 'Response phase')
      assert.equal(pending.standardCode, null)
      await approve(f.ID)
      await cds.run(UPDATE('reliefgrid.CampDecisions', f.ID).with({ reviewDate: day(-2) }))
      attention = (await GET(`${R}/attention()`, coordinator)).data.value
      assert.ok(attention.some(i => i.decisionID === f.ID && i.kind === 'REVIEW_OVERDUE'))
      assert.equal((await phaseOf(c)).responsePhase, 'FIRST_PHASE', 'an overdue review changes nothing')
      await act(f.ID, 'completeReview', { outcome: 'CONFIRMED', explanation: 'Still building', nextReviewDate: day(20), version: (await getDecision(f.ID)).version }, admin)
      assert.equal((await getDecision(f.ID)).reviewState, 'COMPLETED')
    })
  })

  describe('security and concurrency', () => {
    it('donors cannot propose or read phases; phase data cannot be written through any route', async () => {
      const c = await createCamp('Phase Security Camp')
      assert.equal((await outcome(proposePhase(c, {}, donor))).status, 403)
      assert.equal((await outcome(GET(`${R}/CampPhases`, donor))).status, 403)
      const { data: md } = await GET(`${D}/$metadata`, donor)
      assert.doesNotMatch(md, /CampPhases|responsePhase|ResponsePhases/)
      const { data: f } = await proposePhase(c)
      const json = { headers: { 'content-type': 'application/json' } }
      for (const [label, attempt] of [
        ['PATCH phase info', () => PATCH(`${R}/CampPhases(${c})`, { responsePhase: 'FIRST_PHASE' }, admin)],
        ['PATCH decision', () => PATCH(decision(f.ID), { responsePhase: 'MEDIUM_TERM', status_code: 'APPROVED' }, admin)],
        ['POST decision', () => POST(`${R}/CampDecisions`, { camp_ID: c, kind: 'PHASE', responsePhase: 'FIRST_PHASE', status_code: 'APPROVED' }, admin)],
        ['PATCH standard', () => PATCH(`${R}/Standards('TOILET')`, { perPersonFirstPhase: 0.001 }, admin)],
        ['$batch', () => POST(`${R}/$batch`, { requests: [{ id: '1', method: 'PATCH', url: `CampDecisions(${f.ID})`, headers: { 'content-type': 'application/json' }, body: { status_code: 'APPROVED' } }] }, { ...admin, ...json })]
      ]) {
        const before = [await table('CampDecisions'), await table('Standards', { code: 'TOILET' })]
        const res = await outcome(attempt())
        const statuses = res.data?.responses ? res.data.responses.map(r => r.status) : [res.status]
        assert.ok(statuses.every(s => !ok(s)), `${label}: ${statuses}`)
        assert.deepEqual([await table('CampDecisions'), await table('Standards', { code: 'TOILET' })], before, label)
      }
      const other = await createCamp('Phase Other Camp')
      const cross = await outcome(POST(`${camp(other)}/decisions(${f.ID})/ReliefService.approve`, { version: f.version }, { ...admin2, headers: { 'if-match': '*' } }))
      assert.equal(cross.status, 404)
      const missing = await outcome(POST(`${decision(f.ID)}/ReliefService.approve`, { version: f.version }, admin2))
      assert.equal(missing.status, 428)
      assert.equal((await getDecision(f.ID)).status_code, 'PENDING')
    })

    it('only one of two simultaneous phase submissions for a camp becomes pending', async () => {
      const c = await createCamp('Phase Race Camp')
      const { data: a } = await proposePhase(c, { saveAsDraft: true })
      const { data: b } = await proposePhase(c, { saveAsDraft: true, responsePhase: 'MEDIUM_TERM' })
      const results = await Promise.all([a, b].map(d => outcome(act(d.ID, 'submit', { version: d.version }, coordinator))))
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
      assert.equal((await table('CampDecisions', { camp_ID: c, kind: 'PHASE', status_code: 'PENDING' })).length, 1)
    })

    it('a phase draft is revised only through its own action, by its proposer', async () => {
      const c = await createCamp('Phase Draft Camp')
      const { data: d } = await proposePhase(c, { saveAsDraft: true })
      const wrongKind = await outcome(act(d.ID, 'reviseDraft', { applicability: 'APPLICABLE', reason: 'x', reviewDate: day(30), version: d.version }, coordinator))
      assert.equal(code(wrongKind), 'DECISION_KIND_MISMATCH')
      const other = await outcome(act(d.ID, 'revisePhaseDraft', { responsePhase: 'MEDIUM_TERM', reason: 'x', effectiveFrom: day(0), reviewDate: day(30), version: d.version }, admin))
      assert.equal(code(other), 'DECISION_PROPOSER_ONLY')
      await act(d.ID, 'revisePhaseDraft', { responsePhase: 'MEDIUM_TERM', reason: 'Revised', effectiveFrom: day(1), reviewDate: day(30), version: d.version }, coordinator)
      const v = await getDecision(d.ID)
      assert.equal(v.responsePhase, 'MEDIUM_TERM')
      assert.equal(v.canRevisePhase, false, 'the admin reading it is not the proposer')
    })
  })
})
