const cds = require('@sap/cds')
const assessment = require('./assessment')

/** The single household-assumption record. */
const ID = 'CURRENT'
/** ReliefGrid's planning choice as shipped; used only to create the record when it is missing. */
const DEFAULT_SIZE = 5
const fail = (status, message, args, target) => cds.error({ status, message, args, target })

/** Creates the record with the default if, and only if, it does not exist yet; another process may create it at the same moment. */
async function ensureAssumption(attempts = 5) {
  const { HouseholdAssumption } = cds.entities('reliefgrid')
  const exists = async () => SELECT.one.from(HouseholdAssumption).columns('ID').where({ ID })
  for (let attempt = 1; ; attempt++) {
    try {
      if (await exists()) return false
      await INSERT.into(HouseholdAssumption).entries({ ID, householdSize: DEFAULT_SIZE, version: 1 })
      return true
    } catch (e) {
      if (await exists().catch(() => null)) return false
      if (attempt >= attempts) throw e
      await new Promise(resolve => setTimeout(resolve, 100 * attempt))
    }
  }
}

/**
 * A household size as entered: at least one person, with at most one decimal
 * (averages such as 4.6 are common) and within the stored Decimal(4, 1).
 * Anything else is refused, never rounded.
 */
function parseSize(value) {
  if (value === null || value === undefined || value === '') fail(400, 'HOUSEHOLD_SIZE_REQUIRED', [], 'householdSize')
  const text = String(value).trim()
  if (!/^\d{1,3}(\.\d)?$/.test(text) || !(Number(text) >= 1)) fail(400, 'HOUSEHOLD_SIZE_INVALID', [text], 'householdSize')
  return text
}

const decisions = () => require('./decisions')
const now = () => new Date().toISOString()
const num = value => (value === null || value === undefined ? null : Number(value))
const shown = value => (value === null ? 'none' : String(Math.round(value * 10) / 10))

/**
 * The effective requirement of every per-household line (water containers) as shown on the line: empty while the indicator is not established (B4.1),
 * for the given camps or every active camp, keyed by camp and indicator.
 */
async function requirements(campID = null, kind = 'HOUSEHOLD') {
  const { Stock } = cds.entities('reliefgrid')
  // per-household lines (water containers), or food-energy lines (B5: rations, worked out from kcal per pack)
  const where = { [kind === 'FOOD_ENERGY' ? 'standard.kcalPerPersonDay' : 'standard.perHousehold']: { '!=': null }, 'camp.status_code': 'ACTIVE' }
  if (campID) where.camp_ID = campID
  const rows = await SELECT.from(Stock).columns(s => { s.camp_ID, s.standard_code, s.required, s.standard(t => { t.unit }) }).where(where)
  return new Map(rows.map(r => [`${r.camp_ID}/${r.standard_code}`, { campID: r.camp_ID, standard: r.standard_code, required: num(r.required), unit: r.standard?.unit }]))
}

/**
 * Flags the outstanding requests of every line whose calculated requirement
 * changed between the two snapshots, with the reason in words. A line whose
 * requirement stayed the same (a local target in force, not applicable, or the
 * same rounded household figure) flags nothing. Requests, pledges and
 * deliveries are never changed: only a review is opened.
 */
async function flagChanged(before, after, { cause, actor, what, householdChangeID = null }) {
  let flagged = 0
  for (const [key, b] of before) {
    const a = after.get(key)
    if (!a || a.required === b.required || (a.required !== null && b.required !== null && Math.abs(a.required - b.required) < 1e-6)) continue
    const detail = `${what}: requirement ${shown(b.required)} ${b.unit ?? ''} → ${shown(a.required)} ${a.unit ?? ''}`.replace(/\s+/g, ' ').slice(0, 400)
    flagged += await decisions().flagRequests(a.campID, a.standard, null, actor, cause, { detail, householdChangeID })
  }
  return flagged
}

/**
 * Proposes a household-size change (B4.3 governance): one Administrator
 * proposes, another approves. Refused when another proposal is waiting, when
 * the proposal is based on an older version, or when nothing would change.
 * The pending marker is set with a compare-and-set, so of two simultaneous
 * proposals only one is accepted.
 */
async function propose(value, reason, user, basedOn) {
  const { HouseholdAssumption, HouseholdSizeProposals } = cds.entities('reliefgrid')
  const size = parseSize(value)
  if (!reason?.trim()) fail(400, 'HOUSEHOLD_REASON_REQUIRED', [], 'reason')
  if (!Number.isInteger(basedOn)) fail(400, 'HOUSEHOLD_VERSION_REQUIRED', [], 'version')
  const before = await SELECT.one.from(HouseholdAssumption).where({ ID }).forUpdate()
  if (!before) fail(500, 'HOUSEHOLD_ASSUMPTION_MISSING')
  if (Number(before.version) !== basedOn) fail(409, 'HOUSEHOLD_CHANGED_MEANWHILE', [before.modifiedBy ?? '', before.version])
  if (before.pendingProposal_ID) fail(409, 'HOUSEHOLD_PROPOSAL_PENDING')
  if (Number(before.householdSize) === Number(size)) fail(409, 'HOUSEHOLD_UNCHANGED')
  const proposalID = cds.utils.uuid()
  // the record's own audit fields keep naming the last change, not this proposal
  const n = await UPDATE(HouseholdAssumption).with({ pendingProposal_ID: proposalID, modifiedAt: { ref: ['modifiedAt'] }, modifiedBy: { ref: ['modifiedBy'] } })
    .where({ ID, version: before.version, pendingProposal_ID: null })
  if (n !== 1) fail(409, 'HOUSEHOLD_PROPOSAL_PENDING')
  await INSERT.into(HouseholdSizeProposals).entries({
    ID: proposalID, proposedSize: size, previousSize: before.householdSize, basedOnVersion: before.version,
    reason: reason.trim(), proposedAt: now(), proposedBy: user, status: 'PENDING'
  })
  return proposalID
}

/** Reads a proposal that is still waiting, locked for this transaction. */
async function pending(proposalID) {
  const { HouseholdSizeProposals } = cds.entities('reliefgrid')
  const p = await SELECT.one.from(HouseholdSizeProposals).where({ ID: proposalID }).forUpdate()
  if (!p) fail(404, 'HOUSEHOLD_PROPOSAL_NOT_FOUND')
  if (p.status !== 'PENDING') fail(409, 'HOUSEHOLD_PROPOSAL_NOT_PENDING', [p.statusText ?? p.status])
  return p
}

/** Moves a waiting proposal to its final state, once; a second decision at the same moment is refused. */
async function decide(p, status, user, reason, extra = {}) {
  const { HouseholdAssumption, HouseholdSizeProposals } = cds.entities('reliefgrid')
  const n = await UPDATE(HouseholdSizeProposals)
    .with({ status, decidedAt: now(), decidedBy: user, decisionReason: reason?.trim() || null, ...extra })
    .where({ ID: p.ID, status: 'PENDING' })
  if (n !== 1) fail(409, 'HOUSEHOLD_PROPOSAL_NOT_PENDING', [''])
  await UPDATE(HouseholdAssumption).with({ pendingProposal_ID: null, modifiedAt: { ref: ['modifiedAt'] }, modifiedBy: { ref: ['modifiedBy'] } })
    .where({ ID, pendingProposal_ID: p.ID })
}

/**
 * Approves a proposal, by an Administrator other than the proposer, in one
 * transaction: replaces the size, appends who proposed and who approved, when,
 * why, from what to what, records every active camp's assessment, flags the
 * outstanding container requests whose requirement changed, and reports the
 * lines that changed state.
 */
async function approve(proposalID, user) {
  const { HouseholdAssumption, HouseholdAssumptionChanges, HouseholdSizeProposals, Stock } = cds.entities('reliefgrid')
  const p = await pending(proposalID)
  if (p.proposedBy === user) fail(403, 'HOUSEHOLD_SELF_APPROVAL')
  const before = await SELECT.one.from(HouseholdAssumption).where({ ID }).forUpdate()
  if (!before) fail(500, 'HOUSEHOLD_ASSUMPTION_MISSING')
  if (Number(before.version) !== Number(p.basedOnVersion)) fail(409, 'HOUSEHOLD_CHANGED_MEANWHILE', [before.modifiedBy ?? '', before.version])

  const states = async () => Object.fromEntries((await SELECT.from(Stock).columns('ID', 'camp_ID', 'assessment')
    .where({ 'camp.status_code': 'ACTIVE' })).map(s => [s.ID, s]))
  const old = await states()
  const required = await requirements()
  const version = Number(before.version) + 1
  const n = await UPDATE(HouseholdAssumption).with({ householdSize: p.proposedSize, version, pendingProposal_ID: null })
    .where({ ID, version: before.version, pendingProposal_ID: p.ID })
  if (n !== 1) fail(409, 'HOUSEHOLD_CHANGED_MEANWHILE', [before.modifiedBy ?? '', before.version])
  const changeID = cds.utils.uuid()
  const at = now()
  await INSERT.into(HouseholdAssumptionChanges).entries({
    ID: changeID, changedAt: at, changedBy: user, reason: p.reason,
    previousSize: before.householdSize, newSize: p.proposedSize, version,
    proposal_ID: p.ID, proposedAt: p.proposedAt, proposedBy: p.proposedBy
  })
  const m = await UPDATE(HouseholdSizeProposals)
    .with({ status: 'APPROVED', decidedAt: at, decidedBy: user, resultingVersion: version }).where({ ID: p.ID, status: 'PENDING' })
  if (m !== 1) fail(409, 'HOUSEHOLD_PROPOSAL_NOT_PENDING', [''])
  await assessment.record(await assessment.activeCamps(), { trigger: assessment.TRIGGERS.HOUSEHOLD_ASSUMPTION_CHANGED, triggerID: changeID, actor: user })
  const flagged = await flagChanged(required, await requirements(), {
    cause: 'HOUSEHOLD_SIZE', actor: user, householdChangeID: changeID,
    what: `Household size changed from ${Number(before.householdSize)} to ${Number(p.proposedSize)} people per household`
  })
  const after = await states()
  const moved = Object.values(after).filter(s => old[s.ID] && old[s.ID].assessment !== s.assessment)
  return { linesChanged: moved.length, campsChanged: new Set(moved.map(s => s.camp_ID)).size, version, requestsFlagged: flagged }
}

/** Rejects a proposal, by an Administrator other than the proposer, with a reason. Nothing else changes. */
async function reject(proposalID, reason, user) {
  if (!reason?.trim()) fail(400, 'HOUSEHOLD_REASON_REQUIRED', [], 'reason')
  const p = await pending(proposalID)
  if (p.proposedBy === user) fail(403, 'HOUSEHOLD_SELF_REJECTION')
  await decide(p, 'REJECTED', user, reason)
}

/** Withdraws a proposal, by its proposer only. Nothing else changes. */
async function withdraw(proposalID, user) {
  const p = await pending(proposalID)
  if (p.proposedBy !== user) fail(403, 'HOUSEHOLD_WITHDRAW_NOT_PROPOSER')
  await decide(p, 'WITHDRAWN', user, null)
}

module.exports = { ID, DEFAULT_SIZE, ensureAssumption, parseSize, requirements, flagChanged, propose, approve, reject, withdraw }
