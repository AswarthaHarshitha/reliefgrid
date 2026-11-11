const cds = require('@sap/cds')
const assessment = require('./assessment')
const ledger = require('./ledger')
const clock = require('./clock')


/** Requests in these states still expect goods to arrive. */
const OUTSTANDING = ['OPEN', 'PARTIAL', 'PLEDGED']

/** Line states that are classified against an established requirement. */
const CLASSIFIED = ['CRITICAL', 'ATTENTION', 'MET']

/** Days of supply a camp should hold after replenishment. */
const DEFAULT_TARGET_DAYS = 7

const num = v => Number(v ?? 0)

/** Key of the bound entity; draft-enabled entities pass an object with IsActiveEntity. */
const keyOf = param => (param !== null && typeof param === 'object' ? param.ID : param)

/**
 * Derives a request's status from its quantities. Cancelled requests stay
 * cancelled; everything else follows delivered > pledged > open.
 */
function requestStatus({ status_code, quantity, pledgedQuantity, deliveredQuantity }) {
  if (status_code === 'CANCELLED') return 'CANCELLED'
  if (num(deliveredQuantity) >= num(quantity)) return 'FULFILLED'
  if (num(pledgedQuantity) >= num(quantity)) return 'PLEDGED'
  if (num(pledgedQuantity) > 0) return 'PARTIAL'
  return 'OPEN'
}

/** Calendar days in the operation time zone (ARCH-08). */
const addDays = (days, from = new Date()) => clock.addDays(days, from)

/** Makes sure a camp has exactly one stock row for every reference indicator; new rows are not counted yet. */
async function ensureStock(campID) {
  const { Stock, Standards } = cds.entities('reliefgrid')
  const [standards, existing] = await Promise.all([
    SELECT.from(Standards).columns('code'),
    SELECT.from(Stock).columns('standard_code').where({ camp_ID: campID })
  ])
  const have = new Set(existing.map(s => s.standard_code))
  const missing = standards.filter(s => !have.has(s.code))
  if (missing.length)
    await INSERT.into(Stock).entries(missing.map(s => ({ camp_ID: campID, standard_code: s.code, quantity: null })))
  return missing.length
}

/**
 * Works out what a camp must request to reach the reference requirement, taking
 * goods already on their way into account so nothing is requested twice.
 *
 * Consumables are topped up to `targetDays` of supply; coverage items
 * (toilets, taps, living space, ...) are topped up to 100 % coverage.
 * Lines without people recorded or without a stock count (quantity null)
 * are skipped: an unknown quantity is never treated as zero.
 */
function plan(stock, outstanding, targetDays = DEFAULT_TARGET_DAYS, today = new Date(), { explain = false } = {}) {
  const lines = []
  for (const s of stock) {
    // the whole requirement of the line where it is known (per-household lines); otherwise per person
    const daily = s.requirement !== undefined ? num(s.requirement) : num(s.headcount) * num(s.perPerson)
    if (!(daily > 0) || s.quantity === null || s.quantity === undefined) continue
    const consumption = s.basis === 'Consumption'
    const target = consumption ? daily * targetDays : daily
    const incoming = num(outstanding[s.standard_code])
    const need = Math.ceil(target - num(s.quantity) - incoming)
    if (need <= 0) continue

    let neededInDays
    if (consumption) neededInDays = Math.max(0, Math.floor(num(s.quantity) / daily))
    else neededInDays = s.severity === 1 ? 1 : 3

    lines.push({
      standard_code: s.standard_code,
      quantity: need,
      priority_code: s.severity,
      neededBy: addDays(neededInDays, today),
      // UX-05: how the quantity was worked out, for the preview only
      ...(explain ? { requirement: daily, target, onHand: num(s.quantity), incoming, basis: s.basis } : {})
    })
  }
  return lines.sort((a, b) => a.priority_code - b.priority_code || a.neededBy.localeCompare(b.neededBy))
}

/**
 * Raises requests for the counted gaps of one camp. Returns how many were
 * created and how many lines could not be assessed or were never counted.
 */
async function raiseRequests(campID, targetDays = DEFAULT_TARGET_DAYS) {
  const { Camps, Stock, Requests } = cds.entities('reliefgrid')
  if (!Number.isInteger(targetDays) || targetDays < 1 || targetDays > 90)
    cds.error({ status: 400, message: 'TARGET_DAYS_RANGE' })

  // ARCH-01: the camp row is locked, so two simultaneous raises cannot both see the same gap
  const camp = await ledger.lockCamp(campID)
  if (!camp) cds.error({ status: 404, message: 'CAMP_NOT_FOUND' })
  if (camp.status_code !== 'ACTIVE') cds.error({ status: 409, message: 'CAMP_CLOSED' })

  await ensureStock(campID)
  if (!(num(camp.headcount) > 0)) return { created: 0, notAssessed: true, notCounted: 0, needsDecision: 0, notVerified: 0 }
  const { stock, lines } = await gather(campID, targetDays)
  if (lines.length) {
    // The assessment these requests were calculated from, kept with each of them.
    const recorded = await assessment.record([campID], { trigger: assessment.TRIGGERS.REQUESTS_RAISED })
    const entries = []
    for (const l of lines)
      entries.push({
        ...l, camp_ID: campID, status_code: 'OPEN', note: `Auto-raised to reach ${targetDays} days of supply`,
        ...(await assessment.requestBasis(recorded[campID], l.standard_code, targetDays))
      })
    await INSERT.into(Requests).entries(entries)
    await ledger.event('REQUESTS_RAISED', { campID, campName: camp.name,
      detail: lines.map(l => `${l.standard_code} ${l.quantity}`).join(', ') + ` (to reach ${targetDays} days of supply)` })
  }
  const notCounted = stock.filter(s => s.assessment === 'NOT_COUNTED').length
  const notVerified = stock.filter(s => s.assessment === 'NOT_VERIFIED').length
  const needsDecision = stock.filter(s => ['NOT_DECIDED', 'NOT_APPLICABLE', 'NO_REQUIREMENT'].includes(s.assessment)).length
  return { created: lines.length, notAssessed: false, notCounted, needsDecision, notVerified }
}

/** The camp's lines and the requests they would raise now, worked out exactly as Raise Requests does. */
async function gather(campID, targetDays, { explain = false } = {}) {
  const { Stock, Requests } = cds.entities('reliefgrid')
  const stock = await SELECT.from(Stock)
    .columns(s => {
      s.standard_code, s.quantity, s.countedAt, s.severity, s.assessment, s.perPerson, s.totalRequirement, s.measuredQuantity
      s.standard(t => { t.basis })
      s.camp(c => { c.headcount })
    })
    .where({ camp_ID: campID })

  const open = await SELECT.from(Requests)
    .columns('standard_code', 'quantity', 'deliveredQuantity')
    .where({ camp_ID: campID, status_code: { in: OUTSTANDING } })
  const outstanding = {}
  for (const r of open)
    outstanding[r.standard_code] = num(outstanding[r.standard_code]) + num(r.quantity) - num(r.deliveredQuantity)

  // Only classified lines can raise requests: an indicator that is not decided, not
  // applicable, without a requirement or not counted never produces a quantity.
  const lines = plan(
    stock.filter(s => CLASSIFIED.includes(s.assessment)).map(s => ({
      standard_code: s.standard_code,
      // functional units where they are confirmed (B4.5); otherwise the count
      quantity: s.countedAt ? s.measuredQuantity : null,
      severity: s.severity,
      basis: s.standard.basis,
      // the requirement per person in force for this camp: a local target replaces the reference figure (B4.2)
      perPerson: s.perPerson,
      requirement: s.totalRequirement,
      headcount: s.camp.headcount
    })),
    outstanding,
    targetDays,
    new Date(),
    { explain }
  )
  return { stock, lines }
}

/**
 * UX-05: what Raise Requests would publish now, line by line, with how each quantity
 * was worked out. Reads only; nothing is created, recorded or published.
 */
async function previewRequests(campID, targetDays = DEFAULT_TARGET_DAYS) {
  const { Camps, Standards } = cds.entities('reliefgrid')
  if (!Number.isInteger(targetDays) || targetDays < 1 || targetDays > 90)
    cds.error({ status: 400, message: 'TARGET_DAYS_RANGE' })
  const camp = await SELECT.one.from(Camps).columns('ID', 'status_code', 'headcount').where({ ID: campID })
  if (!camp) cds.error({ status: 404, message: 'CAMP_NOT_FOUND' })
  if (camp.status_code !== 'ACTIVE') cds.error({ status: 409, message: 'CAMP_CLOSED' })
  if (!(num(camp.headcount) > 0)) return []
  const { lines } = await gather(campID, targetDays, { explain: true })
  const names = Object.fromEntries((await SELECT.from(Standards).columns('code', 'name', 'unit')).map(s => [s.code, s]))
  return lines.map(l => ({
    standardCode: l.standard_code, standardName: names[l.standard_code]?.name, unit: names[l.standard_code]?.unit,
    basis: l.basis, requirement: Math.round(l.requirement * 10) / 10, target: Math.round(l.target * 10) / 10, targetDays: l.basis === 'Consumption' ? targetDays : null,
    onHand: l.onHand, incoming: l.incoming, quantity: l.quantity, priority: l.priority_code, neededBy: l.neededBy
  }))
}

/**
 * SEC-05: one account cannot block the board. Limits come from cds.reliefgrid.pledges
 * (maxOpenPerDonor: pledges in transit or partly received; maxPerHour: pledges made).
 */
async function pledgeLimits(user) {
  const { Pledges } = cds.entities('reliefgrid')
  const limits = cds.env.reliefgrid?.pledges ?? {}
  const open = await SELECT.one.from(Pledges).columns('count(1) as n').where({ createdBy: user, status_code: { in: ['PLEDGED', 'PARTIAL'] } })
  if (Number.isInteger(limits.maxOpenPerDonor) && Number(open.n) >= limits.maxOpenPerDonor)
    cds.error({ status: 429, message: 'PLEDGE_LIMIT_OPEN', args: [limits.maxOpenPerDonor] })
  const since = new Date(Date.now() - 3600e3).toISOString()
  const recent = await SELECT.one.from(Pledges).columns('count(1) as n').where({ createdBy: user, createdAt: { '>': since } })
  if (Number.isInteger(limits.maxPerHour) && Number(recent.n) >= limits.maxPerHour)
    cds.error({ status: 429, message: 'PLEDGE_LIMIT_RATE', args: [limits.maxPerHour] })
}

async function pledge(requestID, { donor, donorContact, quantity, eta }, user = cds.context?.user?.id) {
  const { Requests, Pledges } = cds.entities('reliefgrid')
  quantity = num(quantity)
  if (!(quantity > 0)) cds.error({ status: 400, message: 'QUANTITY_POSITIVE', target: 'quantity' })
  if (!donor?.trim()) cds.error({ status: 400, message: 'DONOR_REQUIRED', target: 'donor' })
  if (eta && eta < clock.today())
    cds.error({ status: 400, message: 'ETA_IN_PAST', target: 'eta' })

  const request = await SELECT.one.from(Requests).where({ ID: requestID }).forUpdate()
  if (!request) cds.error({ status: 404, message: 'REQUEST_NOT_FOUND' })
  await pledgeLimits(user)
  if (!['OPEN', 'PARTIAL'].includes(request.status_code))
    cds.error({ status: 409, message: 'REQUEST_NOT_OPEN' })
  // A request under review, or for an indicator that is not established for the camp, is not a pledge opportunity.
  const line = await SELECT.one.from(cds.entities('reliefgrid').Stock).columns('assessment')
    .where({ camp_ID: request.camp_ID, standard_code: request.standard_code })
  if (request.review_code === 'PENDING' || ['NOT_DECIDED', 'NOT_APPLICABLE', 'NO_REQUIREMENT'].includes(line?.assessment))
    cds.error({ status: 409, message: 'REQUEST_NOT_OPEN' })

  const remaining = num(request.quantity) - num(request.pledgedQuantity)
  if (quantity > remaining)
    cds.error({ status: 400, message: 'PLEDGE_EXCEEDS_REMAINING', args: [remaining], target: 'quantity' })

  const ID = cds.utils.uuid()
  await INSERT.into(Pledges).entries({
    ID,
    request_ID: requestID,
    donor: donor.trim(),
    donorContact: donorContact?.trim() || null,
    quantity,
    acceptedQuantity: 0,
    eta: eta || null,
    status_code: 'PLEDGED'
  })
  const pledgedQuantity = num(request.pledgedQuantity) + quantity
  await UPDATE(Requests, requestID).with({
    pledgedQuantity,
    status_code: requestStatus({ ...request, pledgedQuantity })
  })
  await ledger.event('PLEDGE_MADE', { campID: request.camp_ID, requestID, pledgeID: ID, detail: `${quantity} of ${request.standard_code} by ${donor.trim()}` })
  return ID
}

const CONDITIONS = ['GOOD', 'DAMAGED', 'REJECTED']
const fail = (status, message, target, args) => cds.error({ status, message, target, args })

/**
 * Records one arrival of goods for a pledge (ARCH-02, ARCH-03, ARCH-06), in one
 * transaction: the receipt, the pledge's received and accepted totals, the
 * request's delivered quantity, the stock line and its ledger movement, the
 * audit event and the camp's assessment. Only accepted goods count as delivered
 * and are added to stock. More than was pledged needs a discrepancy reason;
 * damaged or rejected goods need a reason. The pledge is Delivered once the
 * full quantity arrived, or when the coordinator closes it with this receipt.
 * A closed camp still records late goods, marked as received after closure.
 */
async function recordReceipt(pledgeID, { receivedQuantity, acceptedQuantity, condition, reason, closePledge } = {}, actor) {
  const { Stock, Requests, Pledges, DeliveryReceipts, Camps } = cds.entities('reliefgrid')
  const received = num(receivedQuantity)
  if (receivedQuantity === null || receivedQuantity === undefined || received < 0 || Number.isNaN(Number(receivedQuantity)))
    fail(400, 'QUANTITY_NOT_NEGATIVE', 'receivedQuantity')
  const accepted = acceptedQuantity === null || acceptedQuantity === undefined || acceptedQuantity === '' ? received : num(acceptedQuantity)
  if (!(accepted >= 0) || accepted > received) fail(400, 'RECEIPT_ACCEPTED_RANGE', 'acceptedQuantity', [received])
  condition = condition || (accepted < received ? null : 'GOOD')
  if (!CONDITIONS.includes(condition)) fail(400, 'RECEIPT_CONDITION_REQUIRED', 'condition')
  if (accepted < received && condition === 'GOOD') fail(400, 'RECEIPT_CONDITION_REQUIRED', 'condition')
  const why = reason?.trim() || null
  if (condition !== 'GOOD' && !why) fail(400, 'RECEIPT_REASON_REQUIRED', 'reason')

  const p = await SELECT.one.from(Pledges).where({ ID: pledgeID }).forUpdate()
  if (!p) fail(404, 'PLEDGE_NOT_FOUND')
  if (!['PLEDGED', 'PARTIAL'].includes(p.status_code)) fail(409, 'PLEDGE_NOT_IN_TRANSIT')
  const request = await SELECT.one.from(Requests).where({ ID: p.request_ID }).forUpdate()
  const camp = await SELECT.one.from(Camps).columns('ID', 'name', 'status_code').where({ ID: request.camp_ID })

  const receivedTotal = num(p.receivedQuantity) + received
  const acceptedTotal = num(p.acceptedQuantity) + accepted
  const overReceipt = receivedTotal > num(p.quantity)
  if (overReceipt && !why) fail(400, 'RECEIPT_EXCEEDS_PLEDGE', 'receivedQuantity', [num(p.quantity), num(p.receivedQuantity)])
  const complete = receivedTotal >= num(p.quantity) || !!closePledge
  if (closePledge && !complete) fail(400, 'PLEDGE_CLOSE_REASON_REQUIRED', 'reason')
  if (closePledge && receivedTotal < num(p.quantity) && !why) fail(400, 'PLEDGE_CLOSE_REASON_REQUIRED', 'reason')
  const afterClosure = camp?.status_code === 'CLOSED'

  const receiptID = cds.utils.uuid()
  const at = new Date().toISOString()
  await INSERT.into(DeliveryReceipts).entries({
    ID: receiptID, pledge_ID: pledgeID, request_ID: request.ID, camp_ID: request.camp_ID, receivedAt: at, receivedBy: actor,
    receivedQuantity: received, acceptedQuantity: accepted, condition, reason: why, overReceipt, afterClosure
  })
  await UPDATE(Pledges, pledgeID).with({
    receivedQuantity: receivedTotal, acceptedQuantity: acceptedTotal, status_code: complete ? 'DELIVERED' : 'PARTIAL',
    ...(complete && receivedTotal < num(p.quantity) ? { closedAt: at, closedBy: actor, closeReason: why } : {})
  })

  // Once a pledge is complete, only what was accepted stays committed: the rest goes back on the board.
  const freed = complete ? Math.max(0, num(p.quantity) - acceptedTotal) : 0
  const pledgedQuantity = Math.max(0, num(request.pledgedQuantity) - freed)
  const deliveredQuantity = num(request.deliveredQuantity) + accepted
  await UPDATE(Requests, request.ID).with({
    pledgedQuantity,
    deliveredQuantity,
    status_code: request.status_code === 'CANCELLED' ? 'CANCELLED' : requestStatus({ ...request, pledgedQuantity, deliveredQuantity })
  })

  // A line that was never counted stays unknown (null + n is null): the receipt
  // is kept, and the next count sets the quantity.
  if (accepted > 0) {
    await ensureStock(request.camp_ID)
    const line = await SELECT.one.from(Stock).columns('ID', 'quantity').where({ camp_ID: request.camp_ID, standard_code: request.standard_code }).forUpdate()
    const before = line.quantity === null ? null : num(line.quantity)
    const after = before === null ? null : before + accepted
    await UPDATE(Stock, line.ID).with({ quantity: after })
    await ledger.movement({ stockID: line.ID, campID: request.camp_ID, standardCode: request.standard_code, kind: 'RECEIPT', before, after, change: accepted,
      receiptID, actor, note: before === null ? 'Line not counted yet: the quantity stays unknown until the next count' : null })
  }
  const parts = [`${received} received, ${accepted} accepted (${condition.toLowerCase()})`]
  if (overReceipt) parts.push(`more than the ${num(p.quantity)} pledged`)
  if (afterClosure) parts.push('received after the camp closed')
  if (complete && receivedTotal < num(p.quantity)) parts.push('pledge closed')
  if (why) parts.push(why)
  await ledger.event('RECEIPT_RECORDED', { campID: request.camp_ID, campName: camp?.name, requestID: request.ID, pledgeID, actor, detail: parts.join('; ') })
  await assessment.record([request.camp_ID], { trigger: assessment.TRIGGERS.DELIVERY_CONFIRMED, triggerID: pledgeID, actor })
  return { receiptID, overReceipt, afterClosure, complete }
}

/**
 * Closes a partly received pledge when no more goods are expected (ARCH-03), with
 * a reason. What was accepted stays delivered; the rest goes back on the board.
 */
async function closePledge(pledgeID, reason, actor) {
  const { Requests, Pledges } = cds.entities('reliefgrid')
  if (!reason?.trim()) fail(400, 'PLEDGE_CLOSE_REASON_REQUIRED', 'reason')
  const p = await SELECT.one.from(Pledges).where({ ID: pledgeID }).forUpdate()
  if (!p) fail(404, 'PLEDGE_NOT_FOUND')
  if (p.status_code !== 'PARTIAL') fail(409, 'PLEDGE_NOT_PARTLY_RECEIVED')
  const request = await SELECT.one.from(Requests).where({ ID: p.request_ID }).forUpdate()
  const at = new Date().toISOString()
  await UPDATE(Pledges, pledgeID).with({ status_code: 'DELIVERED', closedAt: at, closedBy: actor, closeReason: reason.trim() })
  const pledgedQuantity = Math.max(0, num(request.pledgedQuantity) - Math.max(0, num(p.quantity) - num(p.acceptedQuantity)))
  await UPDATE(Requests, request.ID).with({
    pledgedQuantity, status_code: request.status_code === 'CANCELLED' ? 'CANCELLED' : requestStatus({ ...request, pledgedQuantity })
  })
  await ledger.event('PLEDGE_CLOSED', { campID: request.camp_ID, requestID: request.ID, pledgeID, actor,
    detail: `${num(p.receivedQuantity)} of ${num(p.quantity)} received, ${num(p.acceptedQuantity)} accepted; ${reason.trim()}` })
}

async function withdraw(pledgeID, actor, reason = null) {
  const { Requests, Pledges } = cds.entities('reliefgrid')
  const p = await SELECT.one.from(Pledges).where({ ID: pledgeID }).forUpdate()
  if (!p) cds.error({ status: 404, message: 'PLEDGE_NOT_FOUND' })
  // goods that already arrived cannot be withdrawn; a partly received pledge is closed instead
  if (p.status_code !== 'PLEDGED') cds.error({ status: 409, message: 'PLEDGE_NOT_IN_TRANSIT' })

  const request = await SELECT.one.from(Requests).where({ ID: p.request_ID }).forUpdate()
  await UPDATE(Pledges, pledgeID).with({ status_code: 'WITHDRAWN' })
  const pledgedQuantity = Math.max(0, num(request.pledgedQuantity) - num(p.quantity))
  await UPDATE(Requests, request.ID).with({
    pledgedQuantity,
    status_code: request.status_code === 'CANCELLED' ? 'CANCELLED' : requestStatus({ ...request, pledgedQuantity })
  })
  await ledger.event('PLEDGE_WITHDRAWN', { campID: request.camp_ID, requestID: request.ID, pledgeID, actor,
    detail: `${num(p.quantity)} of ${request.standard_code} by ${p.donor}${reason ? `; ${reason}` : ''}` })
}

/** SEC-05: withdraws every pledge still in transit made by one donor account, with a reason. Returns how many. */
async function withdrawAllOf(user, reason, actor) {
  const { Pledges } = cds.entities('reliefgrid')
  if (!reason?.trim()) cds.error({ status: 400, message: 'WITHDRAW_ALL_REASON_REQUIRED', target: 'reason' })
  const open = await SELECT.from(Pledges).columns('ID').where({ createdBy: user, status_code: 'PLEDGED' })
  for (const p of open) await withdraw(p.ID, actor, `all pledges of account ${user} withdrawn: ${reason.trim()}`)
  return open.length
}

module.exports = {
  CLASSIFIED,
  keyOf,
  DEFAULT_TARGET_DAYS,
  OUTSTANDING,
  requestStatus,
  addDays,
  ensureStock,
  plan,
  raiseRequests,
  pledge,
  previewRequests,
  recordReceipt,
  closePledge,
  withdraw,
  withdrawAllOf
}
