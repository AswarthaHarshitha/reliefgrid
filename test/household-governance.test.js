process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const admin2 = { auth: { username: 'admin2', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`
const SIZE = `${R}/HouseholdAssumption('CURRENT')`
const PROPOSAL = ID => `${R}/HouseholdSizeProposals(${ID})`
const outcome = p => p.then(r => r, e => e.response ?? e)
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
const count = async (campID, c, quantity) => POST(`${R}/Stock(${(await stockOf(campID))[c].ID})/ReliefService.recordCount`, { quantity }, coordinator)
const assumption = async () => (await GET(SIZE, coordinator)).data
const proposeSize = async (householdSize, reason = 'Registration data', user = admin, version) =>
  POST(`${SIZE}/ReliefService.proposeSize`, { householdSize, reason, version: version ?? (await assumption()).version }, user)
const approveSize = (ID, user = admin2) => POST(`${PROPOSAL(ID)}/ReliefService.approve`, {}, user)
const rejectSize = (ID, reason = 'Not supported by the registration', user = admin2) => POST(`${PROPOSAL(ID)}/ReliefService.rejectProposal`, { reason }, user)
const withdrawSize = (ID, user = admin) => POST(`${PROPOSAL(ID)}/ReliefService.withdraw`, {}, user)
const changeSize = async (size, reason = 'Registration data') => approveSize((await proposeSize(size, reason)).data.ID)
const restore = async () => {
  for (const p of await table('HouseholdSizeProposals', { status: 'PENDING' })) await withdrawSize(p.ID, p.proposedBy === 'admin' ? admin : admin2)
  if (Number((await assumption()).householdSize) !== 5) await changeSize(5, 'restore')
}
const requestsOf = async (campID, standard = 'CONTAINER') =>
  (await GET(`${camp(campID)}/requests?$filter=standard_code eq '${standard}'&$expand=currentReview`, coordinator)).data.value
const raise = async campID => POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator)
const keep = ID => POST(`${R}/Requests(${ID})/ReliefService.resolveReview`, { resolution: 'KEEP', reason: 'Still needed' }, coordinator)
const decide = async ID => {
  const d = (await GET(`${R}/CampDecisions(${ID})`, admin)).data
  return POST(`${R}/CampDecisions(${ID})/ReliefService.approve`, { version: d.version }, { ...admin, headers: { 'if-match': d['@odata.etag'] } })
}

describe('B4.3 governance: household size needs two Administrators', () => {
  after(restore)

  it('a proposal changes nothing until another Administrator approves it', async () => {
    const c = await createCamp('Proposal Camp', 23)
    await count(c, 'CONTAINER', 6)
    await raise(c)
    const before = await assumption()
    const records = (await table('AssessmentRecords', { camp_ID: c })).length
    const { data: p } = await proposeSize(4, 'Registration shows smaller families')
    assert.equal(p.status, 'PENDING')
    assert.equal(p.statusText, 'Waiting for approval')
    assert.equal(p.proposedBy, 'admin')
    assert.equal(Number(p.proposedSize), 4)
    assert.equal(Number(p.previousSize), 5)
    assert.equal(p.basedOnVersion, before.version)
    const pending = await assumption()
    assert.equal(Number(pending.householdSize), 5, 'the size in force is unchanged')
    assert.equal(pending.version, before.version)
    assert.equal(pending.pendingProposal_ID, p.ID)
    assert.equal(Number((await stockOf(c)).CONTAINER.required), 10)
    assert.equal((await table('AssessmentRecords', { camp_ID: c })).length, records, 'no assessment is written for a proposal')
    assert.equal((await requestsOf(c))[0].review_code, null, 'no request is flagged for a proposal')
    assert.equal((await table('HouseholdAssumptionChanges', { proposal_ID: p.ID })).length, 0)

    const { data: result } = await approveSize(p.ID)
    assert.equal(result.version, before.version + 1)
    assert.equal(result.requestsFlagged, 1)
    const [log] = await table('HouseholdAssumptionChanges', { proposal_ID: p.ID })
    assert.equal(log.proposedBy, 'admin')
    assert.equal(log.changedBy, 'admin2')
    assert.equal(log.reason, 'Registration shows smaller families')
    assert.equal(Number(log.previousSize), 5)
    assert.equal(Number(log.newSize), 4)
    assert.equal(log.version, before.version + 1)
    assert.ok(log.proposedAt <= log.changedAt)
    const [done] = await table('HouseholdSizeProposals', { ID: p.ID })
    assert.equal(done.status, 'APPROVED')
    assert.equal(done.decidedBy, 'admin2')
    assert.equal(done.resultingVersion, before.version + 1)
    const now = await assumption()
    assert.equal(Number(now.householdSize), 4)
    assert.equal(now.pendingProposal_ID, null)
    await changeSize(5, 'restore')
  })

  it('the proposer can neither approve nor reject their own proposal; coordinators can do neither', async () => {
    const { data: p } = await proposeSize(4)
    const self = await outcome(approveSize(p.ID, admin))
    assert.equal(self.status, 403)
    assert.equal(code(self), 'HOUSEHOLD_SELF_APPROVAL')
    const selfReject = await outcome(rejectSize(p.ID, 'no', admin))
    assert.equal(selfReject.status, 403)
    assert.equal(code(selfReject), 'HOUSEHOLD_SELF_REJECTION')
    for (const attempt of [() => approveSize(p.ID, coordinator), () => rejectSize(p.ID, 'no', coordinator), () => withdrawSize(p.ID, coordinator),
      () => approveSize(p.ID, donor), () => POST(`${SIZE}/ReliefService.proposeSize`, { householdSize: 6, reason: 'x', version: 1 }, coordinator)])
      assert.equal((await outcome(attempt())).status, 403)
    const notProposer = await outcome(withdrawSize(p.ID, admin2))
    assert.equal(notProposer.status, 403)
    assert.equal(code(notProposer), 'HOUSEHOLD_WITHDRAW_NOT_PROPOSER')
    assert.equal((await table('HouseholdSizeProposals', { ID: p.ID }))[0].status, 'PENDING')
    assert.equal(Number((await assumption()).householdSize), 5)
    await withdrawSize(p.ID)
  })

  it('a rejection needs a reason, changes nothing, and ends the proposal for good', async () => {
    const before = await assumption()
    const logs = (await table('HouseholdAssumptionChanges')).length
    const { data: p } = await proposeSize(6)
    assert.equal((await outcome(rejectSize(p.ID, ' '))).status, 400)
    await rejectSize(p.ID, 'Registration does not support it')
    const [rejected] = await table('HouseholdSizeProposals', { ID: p.ID })
    assert.equal(rejected.status, 'REJECTED')
    assert.equal(rejected.decidedBy, 'admin2')
    assert.equal(rejected.decisionReason, 'Registration does not support it')
    const now = await assumption()
    assert.equal(Number(now.householdSize), 5)
    assert.equal(now.version, before.version)
    assert.equal(now.pendingProposal_ID, null)
    assert.equal((await table('HouseholdAssumptionChanges')).length, logs)
    for (const attempt of [() => approveSize(p.ID), () => rejectSize(p.ID), () => withdrawSize(p.ID)]) {
      const res = await outcome(attempt())
      assert.equal(res.status, 409)
      assert.equal(code(res), 'HOUSEHOLD_PROPOSAL_NOT_PENDING')
    }
  })

  it('a withdrawal by the proposer changes nothing and frees the way for a new proposal', async () => {
    const { data: p } = await proposeSize(6)
    const second = await outcome(proposeSize(7, 'another', admin2))
    assert.equal(second.status, 409)
    assert.equal(code(second), 'HOUSEHOLD_PROPOSAL_PENDING')
    await withdrawSize(p.ID)
    assert.equal((await table('HouseholdSizeProposals', { ID: p.ID }))[0].status, 'WITHDRAWN')
    assert.equal(Number((await assumption()).householdSize), 5)
    const { data: q } = await proposeSize(7, 'another', admin2)
    await withdrawSize(q.ID, admin2)
  })

  it('of a simultaneous approval and rejection exactly one takes effect', async () => {
    const before = await assumption()
    const { data: p } = await proposeSize(4)
    const results = await Promise.all([outcome(approveSize(p.ID)), outcome(rejectSize(p.ID))])
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
    const [final] = await table('HouseholdSizeProposals', { ID: p.ID })
    const approved = final.status === 'APPROVED'
    assert.equal(Number((await assumption()).householdSize), approved ? 4 : 5)
    assert.equal((await assumption()).version, before.version + (approved ? 1 : 0))
    assert.equal((await table('HouseholdAssumptionChanges', { proposal_ID: p.ID })).length, approved ? 1 : 0)
    await restore()
  })

  it('of two simultaneous approvals only one goes through', async () => {
    const before = await assumption()
    const { data: p } = await proposeSize(4)
    const results = await Promise.all([outcome(approveSize(p.ID)), outcome(approveSize(p.ID))])
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
    assert.equal((await assumption()).version, before.version + 1)
    assert.equal((await table('HouseholdAssumptionChanges', { proposal_ID: p.ID })).length, 1)
    await restore()
  })

  it('an approval is refused when the household size moved on after the proposal, and nothing changes', async () => {
    const { data: p } = await proposeSize(4)
    // a change that did not go through this proposal (for example older code on the same database)
    await cds.run(UPDATE('reliefgrid.HouseholdAssumption').set({ version: { '+=': 1 } }).where({ ID: 'CURRENT' }))
    const before = await assumption()
    const res = await outcome(approveSize(p.ID))
    assert.equal(res.status, 409)
    assert.equal(code(res), 'HOUSEHOLD_CHANGED_MEANWHILE')
    assert.equal(Number((await assumption()).householdSize), 5)
    assert.equal((await assumption()).version, before.version)
    assert.equal((await table('HouseholdSizeProposals', { ID: p.ID }))[0].status, 'PENDING')
    await withdrawSize(p.ID)
  })

  it('the change history is append-only: an earlier entry is never rewritten', async () => {
    await changeSize(4, 'first')
    const history = await table('HouseholdAssumptionChanges')
    const proposals = (await table('HouseholdSizeProposals')).filter(p => p.status !== 'PENDING')
    await changeSize(5, 'restore')
    const later = await table('HouseholdAssumptionChanges')
    for (const row of history) assert.deepEqual(later.find(l => l.ID === row.ID), row)
    const laterProposals = await table('HouseholdSizeProposals')
    for (const row of proposals) assert.deepEqual(laterProposals.find(l => l.ID === row.ID), row, 'a decided proposal is never changed')
    for (const attempt of [() => axios.delete(`${R}/HouseholdAssumptionChanges(${history[0].ID})`, admin), () => axios.delete(PROPOSAL(proposals[0].ID), admin),
      () => PATCH(PROPOSAL(proposals[0].ID), { status: 'PENDING' }, admin), () => PATCH(`${R}/HouseholdAssumptionChanges(${history[0].ID})`, { reason: 'x' }, admin)])
      assert.ok((await outcome(attempt())).status >= 400)
  })

  it('the Command Center lists a waiting proposal with its reason until it is decided', async () => {
    const { data: p } = await proposeSize(6, 'New census figures')
    const item = (await GET(`${R}/attention()`, admin2)).data.value.find(i => i.kind === 'HOUSEHOLD_SIZE_PENDING')
    assert.equal(item.proposalID, p.ID)
    assert.match(item.reason, /^5 → 6 people per household, proposed by admin: New census figures$/)
    await withdrawSize(p.ID)
    assert.equal((await GET(`${R}/attention()`, admin2)).data.value.some(i => i.kind === 'HOUSEHOLD_SIZE_PENDING'), false)
  })
})

describe('B4.3 governance: household changes open a review of container requests', () => {
  after(restore)

  it('recording households that change the requirement flags the open container request, with the reason in words', async () => {
    const c = await createCamp('Flag On Count Camp', 23)
    await count(c, 'CONTAINER', 2)
    await count(c, 'WATER', 100)
    await raise(c)
    const [r] = await requestsOf(c)
    const [water] = await requestsOf(c, 'WATER')
    await editCamp(c, { households: 3 })
    const [flagged] = await requestsOf(c)
    assert.equal(flagged.review_code, 'PENDING')
    assert.equal(flagged.needsReview, true)
    assert.equal(flagged.currentReview.cause, 'HOUSEHOLDS_CHANGED')
    assert.equal(flagged.currentReview.causeText, 'Households changed')
    assert.equal(flagged.currentReview.detail, 'Recorded households changed from none recorded to 3: requirement 10 containers → 6 containers')
    assert.equal(flagged.currentReview.flaggedBy, 'coordinator')
    assert.equal(flagged.quantity, r.quantity, 'the quantity is never changed by a household change')
    assert.equal(flagged.basisSource, r.basisSource, 'the original basis stays')
    assert.equal(flagged.basisRequirement, r.basisRequirement)
    assert.equal((await requestsOf(c, 'WATER'))[0].review_code, water.review_code, 'other indicators are never flagged')
    const item = (await GET(`${R}/attention()`, coordinator)).data.value.find(i => i.requestID === r.ID)
    assert.equal(item.kind, 'REQUEST_REVIEW')
    assert.equal(item.reason, flagged.currentReview.detail)
    const open = (await GET(`${D}/Requests`, donor)).data.value
    assert.equal(open.some(o => o.ID === r.ID), false, 'a request under review is not offered to donors')
  })

  it('does not flag a request when the requirement stays the same', async () => {
    const c = await createCamp('Same Requirement Camp', 23)
    await count(c, 'CONTAINER', 2)
    await raise(c)
    await editCamp(c, { households: 5 })
    assert.equal((await requestsOf(c))[0].review_code, null, '5 recorded households are the 5 estimated: still 10 containers')
    await editCamp(c, { headcount: 25 })
    assert.equal((await requestsOf(c))[0].review_code, null, 'a recorded count is used as it is; a headcount change alone flags nothing')
  })

  it('B4.2 precedence: with a local target in force, a household change does not change the requirement and flags nothing', async () => {
    const c = await createCamp('Target Precedence Camp', 23)
    await count(c, 'CONTAINER', 0)
    const { data: t } = await POST(`${camp(c)}/ReliefService.proposeTarget`,
      { standard: 'CONTAINER', targetPerPerson: 1, reason: 'Two sites', source: 'WASH cluster note', reviewDate: day(90) }, coordinator)
    await decide(t.ID)
    await raise(c)
    const [r] = await requestsOf(c)
    assert.equal(r.review_code, null)
    await editCamp(c, { households: 3 })
    await changeSize(4)
    assert.equal((await requestsOf(c))[0].review_code, null)
    assert.equal(Number((await stockOf(c)).CONTAINER.required), 23)
    await changeSize(5, 'restore')
  })

  it('B4.1 precedence: a container line decided not applicable has no requirement to change, so nothing more is flagged', async () => {
    const c = await createCamp('Not Applicable Containers Camp', 23)
    await count(c, 'CONTAINER', 0)
    await raise(c)
    const { data: d } = await POST(`${camp(c)}/ReliefService.proposeApplicability`,
      { standard: 'CONTAINER', applicability: 'NOT_APPLICABLE', reason: 'Issued by the host', source: 'Host letter', reviewDate: day(60) }, coordinator)
    await decide(d.ID)
    const [r] = await requestsOf(c)
    assert.equal(r.currentReview.cause, 'NOT_APPLICABLE')
    await keep(r.ID)
    const reviews = (await table('RequestReviews', { request_ID: r.ID })).length
    await editCamp(c, { households: 3 })
    assert.equal((await table('RequestReviews', { request_ID: r.ID })).length, reviews)
    assert.equal((await requestsOf(c))[0].review_code, 'KEPT')
  })

  it('an approved household-size change flags the requests of estimated camps only, linked to the change', async () => {
    const estimated = await createCamp('Size Flag Estimated Camp', 23)
    const counted = await createCamp('Size Flag Counted Camp', 23, 5)
    for (const c of [estimated, counted]) { await count(c, 'CONTAINER', 0); await raise(c) }
    const { data: p } = await proposeSize(4, 'Smaller families')
    const { data: result } = await approveSize(p.ID)
    assert.ok(result.requestsFlagged >= 1)
    const [e] = await requestsOf(estimated)
    assert.equal(e.currentReview.cause, 'HOUSEHOLD_SIZE')
    assert.equal(e.currentReview.causeText, 'Household size changed')
    assert.equal(e.currentReview.detail, 'Household size changed from 5 to 4 people per household: requirement 10 containers → 12 containers')
    assert.equal(e.currentReview.flaggedBy, 'admin2')
    const [log] = await table('HouseholdAssumptionChanges', { proposal_ID: p.ID })
    assert.equal(e.currentReview.householdChange_ID, log.ID)
    assert.equal((await requestsOf(counted))[0].review_code, null, 'a recorded count is not affected by the household size')
    await changeSize(5, 'restore')
  })

  it('a request already waiting for review is not flagged twice; once kept, the next change asks again', async () => {
    const c = await createCamp('Twice Camp', 23)
    await count(c, 'CONTAINER', 0)
    await raise(c)
    const [r] = await requestsOf(c)
    await editCamp(c, { households: 3 })
    await editCamp(c, { households: 4 })
    assert.equal((await table('RequestReviews', { request_ID: r.ID })).length, 1)
    await keep(r.ID)
    await editCamp(c, { households: 6 })
    const reviews = await table('RequestReviews', { request_ID: r.ID })
    assert.equal(reviews.length, 2)
    assert.equal((await requestsOf(c))[0].currentReview.detail, 'Recorded households changed from 4 to 6: requirement 8 containers → 12 containers')
    assert.equal(reviews.find(v => v.resolution_code === 'KEPT').resolutionReason, 'Still needed', 'the earlier review keeps its outcome')
  })

  it('removing a recorded count returns to the estimate and says so; cancelled and delivered requests are left alone', async () => {
    const c = await createCamp('Back To Estimate Camp', 23, 3)
    await count(c, 'CONTAINER', 0)
    await raise(c)
    const [r] = await requestsOf(c)
    await POST(`${R}/Requests(${r.ID})/ReliefService.cancel`, {}, coordinator).catch(() => {})
    const cancelled = (await requestsOf(c))[0]
    if (cancelled.status_code === 'CANCELLED') {
      await editCamp(c, { households: null })
      assert.equal((await requestsOf(c))[0].review_code, null, 'a cancelled request is not reviewed')
      await editCamp(c, { households: 3 })
    }
    await raise(c)
    const open = (await requestsOf(c)).find(q => q.status_code === 'OPEN')
    await editCamp(c, { households: null })
    const flagged = (await requestsOf(c)).find(q => q.ID === open.ID)
    assert.equal(flagged.review_code, 'PENDING')
    assert.equal(flagged.currentReview.detail, 'Recorded households changed from 3 to none recorded (estimated from the headcount): requirement 6 containers → 10 containers')
  })
})
