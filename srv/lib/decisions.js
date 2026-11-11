const cds = require('@sap/cds')
const assessment = require('./assessment')
const supply = require('./supply')

/** Line states in which an indicator is not established for a camp; no gap or request is calculated. */
const UNESTABLISHED = ['NOT_DECIDED', 'NOT_APPLICABLE', 'NO_REQUIREMENT']
/** Requests that still expect goods and can therefore need a review. */
const OUTSTANDING = ['OPEN', 'PARTIAL', 'PLEDGED']
/** Decision kinds, governed separately: one decision of each kind can be in force per camp and indicator. */
const KINDS = ['APPLICABILITY', 'TARGET', 'PHASE']
/** Response phases (B4.4); without a decision a camp is in the medium term. */
const PHASES = ['FIRST_PHASE', 'MEDIUM_TERM']
const DEFAULT_PHASE = 'MEDIUM_TERM'
/** Request review cause when a response-phase decision changed a phase-dependent requirement (B4.4). */
const PHASE_CHANGED = 'PHASE_CHANGED'
/** Request review cause when a local target decision changed the requirement per person (B4.2). */
const TARGET_CHANGED = 'TARGET_CHANGED'

/** Today as an ISO date (UTC); effective and review dates are compared on whole days. */
/** Today in the operation time zone (ARCH-08). */
const today = () => require('./clock').today()
const now = () => new Date().toISOString()
const fail = (status, message, args, target) => cds.error({ status, message, args, target })

const entities = () => cds.entities('reliefgrid')

/**
 * Changes a decision only if it still has the version the caller read
 * (compare-and-set), so no change is lost and nothing happens twice, whatever
 * the database's locking or the number of application instances.
 */
async function transition(ID, version, data) {
  const { CampDecisions } = entities()
  const n = await UPDATE(CampDecisions).with({ ...data, version: version + 1 }).where({ ID, version })
  if (n !== 1) {
    const now = await SELECT.one.from(CampDecisions).columns('version').where({ ID })
    fail(409, 'DECISION_CHANGED_MEANWHILE', [now?.version])
  }
}

/**
 * Serialises decision changes for one camp: a row lock on the camp on SAP
 * HANA (and other databases with row locks); SQLite already admits one
 * writer at a time. Taken after the decision row, never before it.
 */
const lockCamp = campID => SELECT.one.from(entities().Camps).columns('ID', 'status_code').where({ ID: campID }).forUpdate()

/** The decision of one kind in force for a camp and indicator, if any. */
async function inForce(campID, standardCode, kind = 'APPLICABILITY') {
  const { CampDecisions } = entities()
  return SELECT.one.from(CampDecisions)
    .where({ camp_ID: campID, standard_code: standardCode, kind, status_code: 'APPROVED', intent: 'DECIDE' })
}

async function openProposal(campID, standardCode, exceptID, kind = 'APPLICABILITY') {
  const { CampDecisions } = entities()
  const where = { camp_ID: campID, standard_code: standardCode, kind, status_code: { in: ['PENDING', 'SCHEDULED'] } }
  if (exceptID) where.ID = { '!=': exceptID }
  return SELECT.one.from(CampDecisions).columns('ID', 'status_code').where(where)
}

/** Checks the dates of a proposal against today; returns nothing, or fails with 400. */
function checkDates({ intent, reviewDate, effectiveFrom }) {
  const t = today()
  if (effectiveFrom && effectiveFrom < t) fail(400, 'DECISION_BACKDATED', [effectiveFrom], 'effectiveFrom')
  if (intent === 'DECIDE') {
    if (!reviewDate) fail(400, 'DECISION_REVIEW_DATE_REQUIRED', [], 'reviewDate')
    if (reviewDate <= t) fail(400, 'DECISION_REVIEW_DATE_FUTURE', [reviewDate], 'reviewDate')
    if (effectiveFrom && reviewDate <= effectiveFrom) fail(400, 'DECISION_REVIEW_AFTER_EFFECTIVE', [reviewDate, effectiveFrom], 'reviewDate')
  }
}

/**
 * A local requirement per person, exactly as entered: a positive decimal that
 * fits the stored precision (Decimal(12, 6)). Anything else is refused, never
 * rounded or coerced. No upper or lower figure is imposed beyond that: the
 * value is a governed decision with a reason, a source and a second approver.
 */
function parseTarget(value) {
  if (value === null || value === undefined || value === '') fail(400, 'TARGET_VALUE_REQUIRED', [], 'targetPerPerson')
  const text = String(value).trim()
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(text) || !(Number(text) > 0)) fail(400, 'TARGET_VALUE_INVALID', [text], 'targetPerPerson')
  return text
}

/** Validates the content of a proposal and resolves what it would replace (the decision of the same kind in force). */
async function prepare({ campID, standardCode, kind = 'APPLICABILITY', intent, applicable, targetPerPerson, responsePhase, source, reason, reviewDate, effectiveFrom }) {
  const { Standards } = entities()
  if (!KINDS.includes(kind)) fail(400, 'DECISION_KIND_UNKNOWN')
  const camp = await lockCamp(campID)
  if (!camp) fail(404, 'CAMP_NOT_FOUND')
  if (camp.status_code !== 'ACTIVE') fail(409, 'CAMP_CLOSED')
  // a response phase is camp-wide: it names no indicator
  if (kind === 'PHASE') standardCode = null
  const standard = kind === 'PHASE' ? { code: null, perPerson: null } : await SELECT.one.from(Standards).columns('code', 'perPerson').where({ code: standardCode })
  if (!standard) fail(400, 'UNKNOWN_STANDARD', [], 'standard')
  if (!reason?.trim()) fail(400, 'DECISION_REASON_REQUIRED', [], 'reason')
  // the owner's rule for phase changes: a reason and an effective date
  if (kind === 'PHASE' && !effectiveFrom) fail(400, 'PHASE_EFFECTIVE_REQUIRED', [], 'effectiveFrom')

  const current = await inForce(campID, standardCode, kind)
  let target = null
  let phase = null
  if (intent === 'DECIDE' && kind === 'PHASE') {
    if (!PHASES.includes(responsePhase)) fail(400, 'PHASE_VALUE_REQUIRED', [], 'responsePhase')
    phase = responsePhase
    applicable = null
  } else if (intent === 'DECIDE' && kind === 'APPLICABILITY') {
    if (applicable !== true && applicable !== false) fail(400, 'DECISION_VALUE_REQUIRED', [], 'applicability')
    if (applicable === false && !source?.trim()) fail(400, 'DECISION_SOURCE_REQUIRED', [], 'source')
  } else if (intent === 'DECIDE') {
    // A local target replaces a reference figure; it never creates a requirement where there is none.
    if (standard.perPerson === null) fail(409, 'TARGET_NO_REFERENCE', [standardCode], 'standard')
    target = parseTarget(targetPerPerson)
    if (!source?.trim()) fail(400, 'TARGET_SOURCE_REQUIRED', [], 'source')
    applicable = null
  } else {
    if (!current) fail(409, { TARGET: 'TARGET_NOTHING_TO_WITHDRAW', PHASE: 'PHASE_NOTHING_TO_WITHDRAW' }[kind] ?? 'DECISION_NOTHING_TO_WITHDRAW')
    applicable = null
    reviewDate = null
  }
  checkDates({ intent, reviewDate, effectiveFrom })
  return {
    camp_ID: campID,
    standard_code: standardCode,
    kind,
    intent,
    applicable,
    targetPerPerson: target,
    referencePerPerson: kind === 'TARGET' ? standard.perPerson : null,
    source: source?.trim() || null,
    reason: reason.trim(),
    reviewDate: reviewDate || null,
    effectiveFrom: effectiveFrom || null,
    previousDecision_ID: current?.ID ?? null,
    previousApplicable: current && kind === 'APPLICABILITY' ? current.applicable : null,
    previousTargetPerPerson: current && kind === 'TARGET' ? current.targetPerPerson : null,
    responsePhase: phase,
    previousResponsePhase: current && kind === 'PHASE' ? current.responsePhase : null,
    withdraws_ID: intent === 'WITHDRAW' ? current.ID : null
  }
}

/** Creates a proposal (draft or submitted) by the signed-in user. */
async function propose(input, user, submit) {
  const { CampDecisions } = entities()
  const data = await prepare(input)
  if (submit && (await openProposal(data.camp_ID, data.standard_code, null, data.kind))) fail(409, 'DECISION_ALREADY_OPEN')
  const ID = cds.utils.uuid()
  await INSERT.into(CampDecisions).entries({
    ID,
    ...data,
    proposedBy: user,
    proposedAt: submit ? now() : null,
    status_code: submit ? 'PENDING' : 'DRAFT',
    version: 1
  })
  return ID
}

/** Loads a decision for a state change and checks the version the caller acted on. */
async function load(ID, version) {
  const { CampDecisions } = entities()
  const d = await SELECT.one.from(CampDecisions).where({ ID }).forUpdate()
  if (!d) fail(404, 'DECISION_NOT_FOUND')
  if (!Number.isInteger(version)) fail(400, 'DECISION_VERSION_REQUIRED', [], 'version')
  if (d.version !== version) fail(409, 'DECISION_CHANGED_MEANWHILE', [d.version])
  return d
}

const proposerOnly = (d, user) => { if (d.proposedBy !== user) fail(403, 'DECISION_PROPOSER_ONLY') }

async function reviseDraft(ID, version, input, user, kind = 'APPLICABILITY') {
  const d = await load(ID, version)
  proposerOnly(d, user)
  if (d.status_code !== 'DRAFT') fail(409, 'DECISION_NOT_DRAFT')
  if (d.kind !== kind) fail(409, 'DECISION_KIND_MISMATCH')
  const data = await prepare({ ...input, campID: d.camp_ID, standardCode: d.standard_code, kind: d.kind, intent: d.intent })
  await transition(ID, version, data)
}

async function submit(ID, version, user) {
  const { CampDecisions } = entities()
  const d = await load(ID, version)
  proposerOnly(d, user)
  if (d.status_code !== 'DRAFT') fail(409, 'DECISION_NOT_DRAFT')
  // Re-checked at submission: the situation may have changed since the draft was written.
  const data = await prepare({ campID: d.camp_ID, standardCode: d.standard_code, kind: d.kind, intent: d.intent, applicable: d.applicable,
    targetPerPerson: d.targetPerPerson === null ? null : String(Number(d.targetPerPerson)), responsePhase: d.responsePhase,
    source: d.source, reason: d.reason, reviewDate: d.reviewDate, effectiveFrom: d.effectiveFrom })
  if (await openProposal(d.camp_ID, d.standard_code, ID, d.kind)) fail(409, 'DECISION_ALREADY_OPEN')
  await transition(ID, version, {
    previousDecision_ID: data.previousDecision_ID, previousApplicable: data.previousApplicable, withdraws_ID: data.withdraws_ID,
    previousTargetPerPerson: data.previousTargetPerPerson, referencePerPerson: data.referencePerPerson, previousResponsePhase: data.previousResponsePhase,
    status_code: 'PENDING', proposedAt: now()
  })
}

async function withdrawProposal(ID, version, user) {
  const { CampDecisions } = entities()
  const d = await load(ID, version)
  proposerOnly(d, user)
  if (!['DRAFT', 'PENDING'].includes(d.status_code)) fail(409, 'DECISION_NOT_OPEN')
  await transition(ID, version, { status_code: 'WITHDRAWN', endedAt: now() })
}

/**
 * Approves a proposal by an Administrator other than the proposer. Effective
 * today (or without a date) it comes into force in this transaction, with the
 * request reviews and the assessment record; a later date schedules it.
 */
async function approve(ID, version, user) {
  const { CampDecisions } = entities()
  const d = await load(ID, version)
  if (d.status_code !== 'PENDING') fail(409, 'DECISION_NOT_PENDING')
  if (d.proposedBy === user) fail(403, 'DECISION_SELF_APPROVAL')
  await lockCamp(d.camp_ID)
  const current = await inForce(d.camp_ID, d.standard_code, d.kind)
  if ((current?.ID ?? null) !== (d.previousDecision_ID ?? null)) fail(409, 'DECISION_CONTEXT_CHANGED')
  if (await openProposal(d.camp_ID, d.standard_code, ID, d.kind).then(o => o?.status_code === 'SCHEDULED')) fail(409, 'DECISION_ALREADY_OPEN')
  checkDates(d)

  const due = !d.effectiveFrom || d.effectiveFrom <= today()
  await transition(ID, version, { status_code: due ? 'APPROVED' : 'SCHEDULED', approvedBy: user, approvedAt: now() })
  if (due) await activate({ ...d, version: version + 1 }, user)
  return due ? 'APPROVED' : 'SCHEDULED'
}

async function reject(ID, version, reason, user) {
  const { CampDecisions } = entities()
  if (!reason?.trim()) fail(400, 'DECISION_REJECTION_REASON_REQUIRED', [], 'reason')
  const d = await load(ID, version)
  if (d.status_code !== 'PENDING') fail(409, 'DECISION_NOT_PENDING')
  if (d.proposedBy === user) fail(403, 'DECISION_SELF_REJECTION')
  await transition(ID, version, { status_code: 'REJECTED', rejectedBy: user, rejectedAt: now(), rejectionReason: reason.trim() })
}

/**
 * Brings an approved decision into force, in the caller's transaction: ends
 * the decision of the same kind it replaces, flags outstanding requests that
 * need a review, and records the resulting assessment. An applicability
 * decision flags requests whose indicator is no longer established; a local
 * target decision flags requests when the requirement per person changed.
 */
async function activate(d, actor) {
  const { CampDecisions, Standards } = entities()
  const at = now()
  // A response phase changes the phase-dependent figures (toilets) where no local target replaces them.
  let phaseFlags = []
  if (d.kind === 'PHASE') {
    const previous = await SELECT.one.from(CampDecisions).columns('responsePhase')
      .where({ camp_ID: d.camp_ID, kind: 'PHASE', status_code: 'APPROVED', intent: 'DECIDE', ID: { '!=': d.ID } })
    const before = previous?.responsePhase ?? DEFAULT_PHASE
    const after = d.intent === 'DECIDE' ? d.responsePhase : DEFAULT_PHASE
    if (before !== after) {
      for (const s of await SELECT.from(Standards).columns('code', 'perPerson', 'perPersonFirstPhase').where('perPersonFirstPhase is not null')) {
        const local = await inForce(d.camp_ID, s.code, 'TARGET')
        const figure = p => Number(p === 'FIRST_PHASE' ? s.perPersonFirstPhase : s.perPerson)
        if (!local && figure(before) !== figure(after)) phaseFlags.push(s.code)
      }
    }
  }
  // The requirement per person before and after, worked out from the decisions themselves: inside this
  // transaction the new decision is already approved, so the live Stock join would see two targets.
  let before = null, after = null
  if (d.kind === 'TARGET') {
    const standard = await SELECT.one.from(Standards).columns('perPerson', 'perHousehold').where({ code: d.standard_code })
    const reference = standard?.perPerson ?? null
    const previous = await SELECT.one.from(CampDecisions).columns('targetPerPerson')
      .where({ camp_ID: d.camp_ID, standard_code: d.standard_code, kind: 'TARGET', status_code: 'APPROVED', intent: 'DECIDE', ID: { '!=': d.ID } })
    // a per-household line without a local target has no per-person figure: any target changes its requirement
    const effective = target => reference === null ? null : target ? Number(target.targetPerPerson)
      : standard.perHousehold !== null ? 'HOUSEHOLDS' : Number(reference)
    before = effective(previous)
    after = effective(d.intent === 'DECIDE' ? d : null)
  }
  if (d.intent === 'DECIDE') {
    await UPDATE(CampDecisions)
      .with({ status_code: 'SUPERSEDED', endedAt: at, endedBy_ID: d.ID, version: { '+=': 1 } })
      .where({ camp_ID: d.camp_ID, standard_code: d.standard_code, kind: d.kind, status_code: 'APPROVED', intent: 'DECIDE', ID: { '!=': d.ID } })
  } else {
    const n = await UPDATE(CampDecisions)
      .with({ status_code: 'WITHDRAWN', endedAt: at, endedBy_ID: d.ID, version: { '+=': 1 } })
      .where({ ID: d.withdraws_ID, status_code: 'APPROVED' })
    if (!n) fail(409, 'DECISION_CONTEXT_CHANGED')
  }
  await UPDATE(CampDecisions, d.ID).with({ status_code: 'APPROVED', inForceFrom: at })
  let flagged
  if (d.kind === 'PHASE') {
    flagged = 0
    for (const code of phaseFlags) flagged += await flagRequests(d.camp_ID, code, d.ID, actor, PHASE_CHANGED)
  } else if (d.kind === 'TARGET') {
    flagged = before !== after ? await flagRequests(d.camp_ID, d.standard_code, d.ID, actor, TARGET_CHANGED) : 0
  } else {
    flagged = await flagRequests(d.camp_ID, d.standard_code, d.ID, actor)
  }
  await assessment.record([d.camp_ID], { trigger: assessment.TRIGGERS.DECISION_EFFECTIVE, triggerID: d.ID, actor })
  return flagged
}

/** Brings every scheduled decision whose effective date has come into force; each in its own transaction. */
async function activateDue() {
  const { CampDecisions } = entities()
  const due = await SELECT.from(CampDecisions).columns('ID').where({ status_code: 'SCHEDULED', effectiveFrom: { '<=': today() } })
  let activated = 0
  for (const { ID } of due) {
    await cds.tx(async () => {
      const d = await SELECT.one.from(CampDecisions).where({ ID }).forUpdate()
      if (d?.status_code !== 'SCHEDULED') return
      await lockCamp(d.camp_ID)
      // Still valid? The decision it was approved against must still be the one in force.
      if (await contextChanged(d)) {
        console.warn(`[reliefgrid] - scheduled decision ${ID} not activated: the decision in force changed since approval`)
        return
      }
      // Only the instance that moves the decision on from the version it read activates it.
      const claimed = await UPDATE(CampDecisions).with({ version: d.version + 1 }).where({ ID, status_code: 'SCHEDULED', version: d.version })
      if (claimed !== 1) return
      await activate({ ...d, version: d.version + 1 }, 'system')
      activated++
    })
  }
  return activated
}

/** True when the decision of the same kind in force is no longer the one a proposal was made and approved against. */
async function contextChanged(d) {
  const current = await inForce(d.camp_ID, d.standard_code, d.kind)
  return (current?.ID ?? null) !== (d.previousDecision_ID ?? null)
}

/**
 * Flags outstanding requests of a camp and indicator for review when the
 * indicator is not established there (not decided, not applicable, or no
 * requirement), or, with a cause, for that cause (a local target changed the
 * requirement; B4.3: households or the household size changed it, with a
 * context giving the detail). A request that already waits for a review is left alone.
 * A decision taking effect always asks for a new review. The start-up sweep
 * (no decision) skips a request whose latest review was already for the
 * same state, so a Keep is not undone while nothing has changed.
 */
async function flagRequests(campID, standardCode, decisionID, actor, cause = null, context = null) {
  const { Stock, Requests, RequestReviews } = entities()
  const line = await SELECT.one.from(Stock).columns('assessment').where({ camp_ID: campID, standard_code: standardCode })
  if (!line) return 0
  if (!cause) {
    if (!UNESTABLISHED.includes(line.assessment)) return 0
    cause = line.assessment
  }
  const requests = await SELECT.from(Requests).columns('ID', 'review_code', 'currentReview.cause as reviewedFor')
    .where({ camp_ID: campID, standard_code: standardCode, status_code: { in: OUTSTANDING } })
  let flagged = 0
  for (const r of requests) {
    if (r.review_code === 'PENDING') continue
    // a household change, like a decision, is a new event: it always asks for a new review
    if (!decisionID && !context && r.reviewedFor === cause) continue
    const reviewID = cds.utils.uuid()
    await INSERT.into(RequestReviews).entries({
      ID: reviewID, request_ID: r.ID, cause, decision_ID: decisionID, flaggedAt: now(), flaggedBy: actor, resolution_code: 'PENDING',
      detail: context?.detail ?? null, householdChange_ID: context?.householdChangeID ?? null
    })
    // Who flagged it and when is on the review row; the request's own audit fields keep their values.
    await UPDATE(Requests, r.ID).with({ review_code: 'PENDING', currentReview_ID: reviewID,
      modifiedAt: { ref: ['modifiedAt'] }, modifiedBy: { ref: ['modifiedBy'] } })
    flagged++
  }
  return flagged
}

/** Flags, for every camp, the outstanding requests whose indicator is not established (upgrade and start-up). */
async function flagAllUnestablished(actor = 'system') {
  const { Requests } = entities()
  const pairs = await SELECT.from(Requests).columns('camp_ID', 'standard_code')
    .where({ status_code: { in: OUTSTANDING }, 'line.assessment': { in: UNESTABLISHED } })
    .and(`review_code is null or review_code != 'PENDING'`)
    .and(`currentReview.cause is null or currentReview.cause != line.assessment`)
  let flagged = 0
  const seen = new Set()
  for (const p of pairs) {
    const key = `${p.camp_ID}/${p.standard_code}`
    if (seen.has(key)) continue
    seen.add(key)
    flagged += await flagRequests(p.camp_ID, p.standard_code, null, actor)
  }
  return flagged
}

/**
 * Resolves a request's pending review. KEEP leaves it as it is. CANCEL
 * cancels a request without pledges, or only the unpledged remainder of a
 * pledged one; pledges, deliveries and stock are never changed, and a fully
 * pledged request cannot be cancelled here.
 */
async function resolveReview(requestID, resolution, reason, user) {
  const { Requests, RequestReviews } = entities()
  if (!['KEEP', 'CANCEL'].includes(resolution)) fail(400, 'REVIEW_RESOLUTION_REQUIRED', [], 'resolution')
  if (!reason?.trim()) fail(400, 'REVIEW_REASON_REQUIRED', [], 'reason')
  const r = await SELECT.one.from(Requests).where({ ID: requestID }).forUpdate()
  if (!r) fail(404, 'REQUEST_NOT_FOUND')
  if (r.review_code !== 'PENDING' || !r.currentReview_ID) fail(409, 'REVIEW_NOT_PENDING')

  let state = 'KEPT'
  if (resolution === 'CANCEL') {
    const pledged = Number(r.pledgedQuantity ?? 0)
    const delivered = Number(r.deliveredQuantity ?? 0)
    if (pledged === 0 && delivered === 0) {
      await UPDATE(Requests, r.ID).with({ status_code: 'CANCELLED' })
      state = 'CANCELLED'
    } else {
      const keep = Math.max(pledged, delivered)
      if (Number(r.quantity) <= keep) fail(409, 'REVIEW_FULLY_PLEDGED')
      await UPDATE(Requests, r.ID).with({ quantity: keep, status_code: supply.requestStatus({ ...r, quantity: keep }) })
      state = 'REMAINDER_CANCELLED'
    }
  }
  await UPDATE(RequestReviews, r.currentReview_ID).with({ resolution_code: state, resolvedAt: now(), resolvedBy: user, resolutionReason: reason.trim() })
  await UPDATE(Requests, r.ID).with({ review_code: state })
  return state
}

// ---------------------------------------------------------------------------
// Periodic review of decisions in force (B4.2)
// ---------------------------------------------------------------------------

const OPEN_STATES = ['PENDING', 'SCHEDULED']

/**
 * Records the periodic review of a decision in force, by an Administrator.
 * CONFIRMED keeps it unchanged until a new review date (after today).
 * CHANGE_PROPOSED records the proposal that would replace or withdraw it
 * (same camp, indicator and kind, waiting for approval or scheduled); the
 * decision stays in force until that proposal takes effect. A review never
 * changes the decision's value, its own review date or its effectiveness,
 * and never approves anything: the decision's version moves on (so a review
 * made on a stale page is refused), and the review is appended.
 */
async function completeReview(ID, version, { outcome, explanation, nextReviewDate, resultingDecision }, user) {
  const { CampDecisions, DecisionReviews } = entities()
  if (!['CONFIRMED', 'CHANGE_PROPOSED'].includes(outcome)) fail(400, 'REVIEW_OUTCOME_REQUIRED', [], 'outcome')
  if (!explanation?.trim()) fail(400, 'REVIEW_EXPLANATION_REQUIRED', [], 'explanation')
  const d = await load(ID, version)
  if (d.status_code !== 'APPROVED' || d.intent !== 'DECIDE') fail(409, 'REVIEW_NOT_IN_FORCE')
  await lockCamp(d.camp_ID)
  let resulting = null
  if (outcome === 'CONFIRMED') {
    if (!nextReviewDate) fail(400, 'REVIEW_NEXT_DATE_REQUIRED', [], 'nextReviewDate')
    if (nextReviewDate <= today()) fail(400, 'DECISION_REVIEW_DATE_FUTURE', [nextReviewDate], 'nextReviewDate')
  } else {
    const replaces = r => r && r.camp_ID === d.camp_ID && r.standard_code === d.standard_code && r.kind === d.kind && OPEN_STATES.includes(r.status_code) &&
      ((r.intent === 'DECIDE' && r.previousDecision_ID === d.ID) || (r.intent === 'WITHDRAW' && r.withdraws_ID === d.ID))
    const r = resultingDecision
      ? await SELECT.one.from(CampDecisions).where({ ID: resultingDecision })
      : await SELECT.one.from(CampDecisions).where({ camp_ID: d.camp_ID, standard_code: d.standard_code, kind: d.kind, status_code: { in: OPEN_STATES } })
    if (!replaces(r)) fail(409, resultingDecision ? 'REVIEW_RESULTING_DECISION_INVALID' : 'REVIEW_NO_CHANGE_PROPOSED')
    resulting = r.ID
    nextReviewDate = null
  }
  await transition(ID, version, {})
  await INSERT.into(DecisionReviews).entries({
    decision_ID: ID, reviewedAt: now(), reviewedBy: user, outcome_code: outcome, explanation: explanation.trim(),
    nextReviewDate: nextReviewDate || null, resultingDecision_ID: resulting, decisionVersion: version + 1
  })
  return outcome
}

/**
 * Review state of decisions, derived on read (nothing is stored on the decision):
 * NOT_DUE, DUE_TODAY, OVERDUE or COMPLETED for a decision in force; SUPERSEDED or
 * WITHDRAWN once it has ended; null otherwise. The review due date is the
 * decision's review date, or after a CONFIRMED review the next review date it set;
 * after CHANGE_PROPOSED nothing is due while that proposal is open, and the review
 * is due again (from the day of that review) if the proposal was rejected or withdrawn.
 * Takes rows with ID, status_code, intent, reviewDate and inForceFrom.
 */
async function reviewStates(rows) {
  const { DecisionReviews, CampDecisions } = entities()
  const t = today()
  const live = rows.filter(r => r.status_code === 'APPROVED' && r.intent === 'DECIDE').map(r => r.ID)
  const reviews = live.length
    ? await SELECT.from(DecisionReviews).columns('decision_ID', 'reviewedAt', 'reviewedBy', 'outcome_code', 'nextReviewDate', 'resultingDecision_ID')
      .where({ decision_ID: { in: live } }).orderBy('reviewedAt')
    : []
  const latest = {}
  for (const r of reviews) latest[r.decision_ID] = r
  const resultingIDs = Object.values(latest).map(r => r.resultingDecision_ID).filter(Boolean)
  const resultingStatus = resultingIDs.length
    ? Object.fromEntries((await SELECT.from(CampDecisions).columns('ID', 'status_code').where({ ID: { in: resultingIDs } })).map(r => [r.ID, r.status_code]))
    : {}
  const out = {}
  for (const r of rows) {
    if (r.status_code === 'SUPERSEDED' || (r.status_code === 'WITHDRAWN' && r.inForceFrom)) { out[r.ID] = { state: r.status_code, due: null, last: null }; continue }
    if (r.status_code !== 'APPROVED' || r.intent !== 'DECIDE') { out[r.ID] = { state: null, due: null, last: null }; continue }
    const last = latest[r.ID] ?? null
    let due = r.reviewDate ?? null
    if (last?.outcome_code === 'CONFIRMED') due = last.nextReviewDate
    else if (last?.outcome_code === 'CHANGE_PROPOSED') due = OPEN_STATES.includes(resultingStatus[last.resultingDecision_ID]) ? null : last.reviewedAt.slice(0, 10)
    const state = due === null ? (last ? 'COMPLETED' : 'NOT_DUE') : due < t ? 'OVERDUE' : due === t ? 'DUE_TODAY' : last ? 'COMPLETED' : 'NOT_DUE'
    out[r.ID] = { state, due, last }
  }
  return out
}

module.exports = {
  UNESTABLISHED, OUTSTANDING, KINDS, PHASES, DEFAULT_PHASE, TARGET_CHANGED, PHASE_CHANGED, today, inForce, parseTarget, propose, reviseDraft, submit, withdrawProposal,
  approve, reject, activate, activateDue, contextChanged, flagRequests, flagAllUnestablished, resolveReview, completeReview, reviewStates
}
