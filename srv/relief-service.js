const cds = require('@sap/cds')
const supply = require('./lib/supply')
const planning = require('./lib/planning')
const households = require('./lib/households')
const ledger = require('./lib/ledger')
const assessment = require('./lib/assessment')
const decisions = require('./lib/decisions')

module.exports = class ReliefService extends cds.ApplicationService {
  init() {
    const { Camps, Stock, Requests, Pledges, PlanningSettings, CampDecisions, HouseholdAssumption, HouseholdSizeProposals } = this.entities
    const db = cds.entities('reliefgrid')

    this.before(['CREATE', 'UPDATE'], Camps, req => {
      const { headcount, childrenUnder5 } = req.data
      if (headcount != null && childrenUnder5 != null && childrenUnder5 > headcount)
        req.error(400, 'CHILDREN_EXCEED_HEADCOUNT', 'childrenUnder5')
      if (req.data.households != null && !Number.isInteger(Number(req.data.households))) req.error(400, 'HOUSEHOLDS_WHOLE_NUMBER', 'households')
      if (req.data.households != null && headcount != null && req.data.households > headcount)
        req.error(400, 'HOUSEHOLDS_EXCEED_HEADCOUNT', 'households')
      if (req.data.rationKcalPerPack != null && !(Number.isInteger(Number(req.data.rationKcalPerPack)) && Number(req.data.rationKcalPerPack) >= 1))
        req.error(400, 'RATION_KCAL_INVALID', 'rationKcalPerPack')
      const { latitude: lat, longitude: lng } = req.data
      if (lat != null && (lat < -90 || lat > 90)) req.error(400, 'LATITUDE_RANGE', 'latitude')
      if (lng != null && (lng < -180 || lng > 180)) req.error(400, 'LONGITUDE_RANGE', 'longitude')
    })

    // A new camp has no population until someone records it. Databases created
    // before this rule still carry a column default of 0, so set it explicitly.
    this.before('NEW', Camps.drafts, req => {
      if (req.data.headcount === undefined) req.data.headcount = null
    })

    // Draft activation of a new camp ends in CREATE on the active entity.
    this.after('CREATE', Camps, async (_, req) => {
      await supply.ensureStock(req.data.ID)
      await assessment.record([req.data.ID], { trigger: assessment.TRIGGERS.CAMP_REGISTERED, triggerID: req.data.ID })
    })

    // A population change re-classifies every line of the camp; record it with the activation.
    this.before('UPDATE', Camps, async req => {
      const ID = req.data.ID ?? supply.keyOf(req.params.at(-1))
      const camp = ID && await SELECT.one.from(db.Camps).columns('headcount', 'households', 'rationKcalPerPack').where({ ID })
      req._previousHeadcount = camp ? camp.headcount ?? null : undefined
      req._previousHouseholds = camp ? camp.households ?? null : undefined
      // B4.3: the container requirement before a household count is recorded or corrected
      if (camp) req._previousRequirements = await households.requirements(ID)
      // B5: the food requirement before the kcal of a ration pack is recorded or corrected
      req._previousKcal = camp ? camp.rationKcalPerPack ?? null : undefined
      if (camp) req._previousFood = await households.requirements(ID, 'FOOD_ENERGY')
    })
    this.after('UPDATE', Camps, async (_, req) => {
      if (req._previousHeadcount === undefined) return
      const ID = req.data.ID ?? supply.keyOf(req.params.at(-1))
      const now = await SELECT.one.from(db.Camps).columns('headcount', 'households', 'rationKcalPerPack').where({ ID })
      const householdsChanged = (now?.households ?? null) !== req._previousHouseholds
      if ((now?.headcount ?? null) !== req._previousHeadcount)
        await assessment.record([ID], { trigger: assessment.TRIGGERS.POPULATION_CHANGED, triggerID: ID })
      else if (householdsChanged)
        await assessment.record([ID], { trigger: assessment.TRIGGERS.HOUSEHOLDS_CHANGED, triggerID: ID })
      const kcalChanged = (now?.rationKcalPerPack ?? null) !== req._previousKcal
      if (kcalChanged && (now?.headcount ?? null) === req._previousHeadcount && !householdsChanged)
        await assessment.record([ID], { trigger: assessment.TRIGGERS.RATION_ENERGY_CHANGED, triggerID: ID })
      // B5: recording or correcting the kcal of a pack opens a review of each outstanding food request whose requirement it changed
      if (kcalChanged && req._previousFood) {
        const kcal = v => (v === null ? 'none recorded (2,100 kcal assumed)' : `${v} kcal`)
        const flagged = await households.flagChanged(req._previousFood, await households.requirements(ID, 'FOOD_ENERGY'), {
          cause: 'RATION_KCAL', actor: req.user.id, what: `Ration energy changed from ${kcal(req._previousKcal)} to ${kcal(now.rationKcalPerPack ?? null)} per pack`
        })
        if (flagged) req.info('RATION_REQUESTS_FLAGGED', [flagged])
      }
      // B4.3: recording or correcting the household count opens a review of each outstanding container
      // request whose requirement it changed. A headcount change alone does not (as for any population change).
      if (householdsChanged && req._previousRequirements) {
        const was = req._previousHouseholds === null ? 'none recorded' : String(req._previousHouseholds)
        const is = now.households === null ? 'none recorded (estimated from the headcount)' : String(now.households)
        const flagged = await households.flagChanged(req._previousRequirements, await households.requirements(ID), {
          cause: 'HOUSEHOLDS_CHANGED', actor: req.user.id, what: `Recorded households changed from ${was} to ${is}`
        })
        if (flagged) req.info('HOUSEHOLD_REQUESTS_FLAGGED', [flagged])
      }
    })

    this.on('raiseRequests', Camps, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      const targetDays = req.data.targetDays ?? (await planning.current()).targetDays
      const { created, notAssessed, notCounted, needsDecision, notVerified } = await supply.raiseRequests(ID, targetDays)
      // Skipped lines make the result partial, so they are a warning, never a plain success.
      if (notAssessed) req.info('CAMP_NOT_ASSESSED')
      else if (created) req.info('REQUESTS_RAISED', [created])
      else if (notCounted) req.warn('NO_REQUESTS_NOT_COUNTED')
      else req.info('NO_GAPS')
      if (notCounted) req.warn('LINES_NOT_COUNTED', [notCounted])
      if (needsDecision) req.info('LINES_NEED_DECISION', [needsDecision])
      if (notVerified) req.warn('LINES_NOT_VERIFIED', [notVerified])
      return { created, skipped: notCounted, notAssessed, needsDecision, notVerified }
    })

    this.on('previewRequests', Camps, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      const targetDays = req.data.targetDays ?? (await planning.current()).targetDays
      return supply.previewRequests(ID, targetDays)
    })

    this.on('requestSupplies', Camps, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      const { standard, quantity, neededBy, note } = req.data
      if (!(Number(quantity) > 0)) return req.error(400, 'QUANTITY_POSITIVE', 'quantity')
      const camp = await ledger.lockCamp(ID)
      if (!camp) return req.error(404, 'CAMP_NOT_FOUND')
      if (camp.status_code !== 'ACTIVE') return req.error(409, 'CAMP_CLOSED')
      if (!(await SELECT.one.from(db.Standards).where({ code: standard })))
        return req.error(400, 'UNKNOWN_STANDARD', 'standard')
      const line = await SELECT.one.from(db.Stock).columns('assessment').where({ camp_ID: ID, standard_code: standard })
      if (decisions.UNESTABLISHED.includes(line?.assessment)) return req.error(409, 'INDICATOR_NOT_ESTABLISHED', 'standard')

      const stock = await SELECT.one.from(db.Stock).columns('severity').where({ camp_ID: ID, standard_code: standard })
      const requestID = cds.utils.uuid()
      const recorded = await assessment.record([ID], { trigger: assessment.TRIGGERS.REQUEST_SUBMITTED, triggerID: requestID })
      await INSERT.into(db.Requests).entries({
        ...(await assessment.requestBasis(recorded[ID], standard)),
        ID: requestID,
        camp_ID: ID,
        standard_code: standard,
        quantity,
        neededBy,
        note,
        priority_code: stock?.severity ?? 2,
        status_code: 'OPEN'
      })
      await ledger.event('REQUEST_CREATED', { campID: ID, campName: camp.name, requestID, detail: `${quantity} of ${standard}${note ? `; ${note}` : ''}` })
      return SELECT.one.from(Requests, requestID)
    })

    this.on('closeCamp', Camps, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      // ARCH-01: locked and read again, so a pledge or a raise cannot land between the check and the close
      const camp = await ledger.lockCamp(ID)
      if (!camp) return req.error(404, 'CAMP_NOT_FOUND')
      if (camp.status_code === 'CLOSED') return req.error(409, 'CAMP_CLOSED')
      await UPDATE(db.Camps, ID).with({ status_code: 'CLOSED' })
      // Unpledged requests are withdrawn; partly pledged ones shrink to what donors already committed.
      const cancelled = await UPDATE(db.Requests).with({ status_code: 'CANCELLED' }).where({ camp_ID: ID, status_code: 'OPEN' })
      const partial = await SELECT.from(db.Requests).where({ camp_ID: ID, status_code: 'PARTIAL' }).forUpdate()
      for (const r of partial) {
        const quantity = r.pledgedQuantity
        await UPDATE(db.Requests, r.ID).with({ quantity, status_code: supply.requestStatus({ ...r, quantity }) })
      }
      await ledger.event('CAMP_CLOSED', { campID: ID, campName: camp.name, detail: `${cancelled} unpledged requests cancelled, ${partial.length} partly pledged requests reduced to what was pledged` })
      return SELECT.one.from(Camps).where({ ID })
    })

    this.on('recordCount', Stock, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      const quantity = Number(req.data.quantity)
      if (!(quantity >= 0)) return req.error(400, 'QUANTITY_NOT_NEGATIVE', 'quantity')
      const line = await SELECT.one.from(db.Stock).columns(s => { s.ID, s.camp_ID, s.standard_code, s.quantity, s.functionalUnits, s.standard(t => { t.countsFunctional }) }).where({ ID }).forUpdate()
      if (!line) return req.error(404, 'STOCK_NOT_FOUND')
      // B4.5: functional units are recorded for toilets and taps only; empty means functionality not confirmed
      let functionalUnits = req.data.functionalUnits ?? null
      if (functionalUnits !== null) {
        functionalUnits = Number(functionalUnits)
        if (!line.standard?.countsFunctional) return req.error(400, 'FUNCTIONAL_NOT_APPLICABLE', 'functionalUnits')
        if (!Number.isInteger(functionalUnits) || functionalUnits < 0) return req.error(400, 'FUNCTIONAL_WHOLE_NUMBER', 'functionalUnits')
        if (functionalUnits > quantity) return req.error(400, 'FUNCTIONAL_EXCEEDS_TOTAL', 'functionalUnits')
      }
      const n = await UPDATE(db.Stock, ID).with({ quantity, functionalUnits, countedAt: new Date().toISOString() })
      if (!n) return req.error(404, 'STOCK_NOT_FOUND')
      const before = line.quantity === null ? null : Number(line.quantity)
      await ledger.movement({ stockID: ID, campID: line.camp_ID, standardCode: line.standard_code, kind: 'COUNT', before, after: quantity,
        change: before === null ? null : quantity - before, functionalBefore: line.functionalUnits ?? null, functionalAfter: functionalUnits })
      const { camp_ID } = await SELECT.one.from(db.Stock).columns('camp_ID').where({ ID })
      await assessment.record([camp_ID], { trigger: assessment.TRIGGERS.STOCK_COUNTED, triggerID: ID })
      return SELECT.one.from(Stock, ID)
    })

    this.on('cancel', Requests, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      // ARCH-01: the request is locked, so a pledge cannot land between the check and the cancellation
      const r = await SELECT.one.from(db.Requests).where({ ID }).forUpdate()
      if (!r) return req.error(404, 'REQUEST_NOT_FOUND')
      if (!['OPEN', 'PARTIAL'].includes(r.status_code)) return req.error(409, 'REQUEST_NOT_OPEN')
      if (Number(r.pledgedQuantity) > 0) return req.error(409, 'REQUEST_HAS_PLEDGES')
      // A flagged request is cancelled only through its review, so the reason is recorded.
      if (r.review_code === 'PENDING') return req.error(409, 'REQUEST_UNDER_REVIEW')
      await UPDATE(db.Requests, ID).with({ status_code: 'CANCELLED' })
      await ledger.event('REQUEST_CANCELLED', { campID: r.camp_ID, requestID: ID, detail: `${Number(r.quantity)} of ${r.standard_code}` })
      return SELECT.one.from(Requests, ID)
    })

    this.on('resolveReview', Requests, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      const state = await decisions.resolveReview(ID, req.data.resolution, req.data.reason, req.user.id)
      req.info('REVIEW_RESOLVED_' + state)
      return SELECT.one.from(Requests, ID)
    })

    // -----------------------------------------------------------------------
    // Applicability decisions (B4.1)
    // -----------------------------------------------------------------------

    const applicableOf = code => code === 'APPLICABLE' ? true : code === 'NOT_APPLICABLE' ? false : undefined

    this.on('proposeApplicability', Camps, async req => {
      const { standard, applicability, reason, source, reviewDate, effectiveFrom, saveAsDraft } = req.data
      const ID = await decisions.propose({
        campID: supply.keyOf(req.params.at(-1)), standardCode: standard, intent: 'DECIDE', applicable: applicableOf(applicability),
        source, reason, reviewDate, effectiveFrom
      }, req.user.id, !saveAsDraft)
      req.info(saveAsDraft ? 'DECISION_DRAFT_SAVED' : 'DECISION_SUBMITTED')
      return SELECT.one.from(CampDecisions, ID)
    })

    this.on('proposeWithdrawal', Camps, async req => {
      const { standard, reason, source, effectiveFrom } = req.data
      const ID = await decisions.propose({
        campID: supply.keyOf(req.params.at(-1)), standardCode: standard, intent: 'WITHDRAW', source, reason, effectiveFrom
      }, req.user.id, true)
      req.info('DECISION_SUBMITTED')
      return SELECT.one.from(CampDecisions, ID)
    })

    // -----------------------------------------------------------------------
    // Local targets (B4.2): the same governance as applicability, kind TARGET
    // -----------------------------------------------------------------------

    this.on('proposeTarget', Camps, async req => {
      const { standard, targetPerPerson, reason, source, reviewDate, effectiveFrom, saveAsDraft } = req.data
      const ID = await decisions.propose({
        campID: supply.keyOf(req.params.at(-1)), standardCode: standard, kind: 'TARGET', intent: 'DECIDE', targetPerPerson,
        source, reason, reviewDate, effectiveFrom
      }, req.user.id, !saveAsDraft)
      const d = await SELECT.one.from(db.CampDecisions).columns('targetPerPerson', 'referencePerPerson').where({ ID })
      req.info(saveAsDraft ? 'DECISION_DRAFT_SAVED' : 'TARGET_SUBMITTED')
      if (Number(d.targetPerPerson) < Number(d.referencePerPerson))
        req.warn('TARGET_BELOW_REFERENCE', [Number(d.targetPerPerson), Number(d.referencePerPerson)])
      return SELECT.one.from(CampDecisions, ID)
    })

    this.on('proposeTargetWithdrawal', Camps, async req => {
      const { standard, reason, source, effectiveFrom } = req.data
      const ID = await decisions.propose({
        campID: supply.keyOf(req.params.at(-1)), standardCode: standard, kind: 'TARGET', intent: 'WITHDRAW', source, reason, effectiveFrom
      }, req.user.id, true)
      req.info('TARGET_SUBMITTED')
      return SELECT.one.from(CampDecisions, ID)
    })

    // -----------------------------------------------------------------------
    // Response phase (B4.4): camp-wide decisions of kind PHASE, same governance
    // -----------------------------------------------------------------------

    this.on('proposePhase', Camps, async req => {
      const { responsePhase, reason, source, effectiveFrom, reviewDate, saveAsDraft } = req.data
      const ID = await decisions.propose({
        campID: supply.keyOf(req.params.at(-1)), kind: 'PHASE', intent: 'DECIDE', responsePhase, source, reason, reviewDate, effectiveFrom
      }, req.user.id, !saveAsDraft)
      req.info(saveAsDraft ? 'DECISION_DRAFT_SAVED' : 'PHASE_SUBMITTED')
      return SELECT.one.from(CampDecisions, ID)
    })

    this.on('proposePhaseWithdrawal', Camps, async req => {
      const { reason, source, effectiveFrom } = req.data
      const ID = await decisions.propose({
        campID: supply.keyOf(req.params.at(-1)), kind: 'PHASE', intent: 'WITHDRAW', source, reason, effectiveFrom
      }, req.user.id, true)
      req.info('PHASE_SUBMITTED')
      return SELECT.one.from(CampDecisions, ID)
    })

    const decisionID = req => supply.keyOf(req.params.at(-1))

    // Reached through a camp (Camps(..)/decisions(..)/action), a decision must belong to that camp:
    // one camp's page can never act on another camp's decision.
    this.before(['submit', 'reviseDraft', 'reviseTargetDraft', 'revisePhaseDraft', 'withdrawProposal', 'approve', 'rejectProposal', 'completeReview'], CampDecisions, async req => {
      if (req.params.length < 2) return
      const campID = supply.keyOf(req.params[0])
      const d = await SELECT.one.from(db.CampDecisions).columns('camp_ID').where({ ID: decisionID(req) })
      if (!d || d.camp_ID !== campID) return req.reject(404, 'DECISION_NOT_FOUND')
    })
    // The version the caller acted on: the explicit parameter (API clients), or the If-Match header that
    // CAP has already compared with the stored version (UI5 clients). Neither means no version: refused.
    const versionOf = async req => {
      if (req.data.version !== null && req.data.version !== undefined) return Number(req.data.version)
      // "If-Match: *" names no version: CAP does not compare it, so it never stands in for the version the caller saw.
      if (req.headers?.['if-match'] && req.headers['if-match'].trim() !== '*') {
        const d = await SELECT.one.from(db.CampDecisions).columns('version').where({ ID: decisionID(req) })
        return d ? d.version : NaN
      }
      return NaN
    }

    this.on('submit', CampDecisions, async req => {
      await decisions.submit(decisionID(req), await versionOf(req), req.user.id)
      req.info('DECISION_SUBMITTED')
      return SELECT.one.from(CampDecisions, decisionID(req))
    })

    this.on('reviseDraft', CampDecisions, async req => {
      const { applicability, reason, source, reviewDate, effectiveFrom } = req.data
      await decisions.reviseDraft(decisionID(req), await versionOf(req), { applicable: applicableOf(applicability), reason, source, reviewDate, effectiveFrom }, req.user.id, 'APPLICABILITY')
      return SELECT.one.from(CampDecisions, decisionID(req))
    })

    this.on('revisePhaseDraft', CampDecisions, async req => {
      const { responsePhase, reason, source, reviewDate, effectiveFrom } = req.data
      await decisions.reviseDraft(decisionID(req), await versionOf(req), { responsePhase, reason, source, reviewDate, effectiveFrom }, req.user.id, 'PHASE')
      return SELECT.one.from(CampDecisions, decisionID(req))
    })

    this.on('reviseTargetDraft', CampDecisions, async req => {
      const { targetPerPerson, reason, source, reviewDate, effectiveFrom } = req.data
      await decisions.reviseDraft(decisionID(req), await versionOf(req), { targetPerPerson, reason, source, reviewDate, effectiveFrom }, req.user.id, 'TARGET')
      return SELECT.one.from(CampDecisions, decisionID(req))
    })

    this.on('completeReview', CampDecisions, async req => {
      const { outcome, explanation, nextReviewDate, resultingDecision } = req.data
      const result = await decisions.completeReview(decisionID(req), await versionOf(req), { outcome, explanation, nextReviewDate, resultingDecision }, req.user.id)
      if (result === 'CONFIRMED') req.info('REVIEW_CONFIRMED', [nextReviewDate])
      else req.info('REVIEW_CHANGE_PROPOSED')
      return SELECT.one.from(CampDecisions, decisionID(req))
    })

    this.on('withdrawProposal', CampDecisions, async req => {
      await decisions.withdrawProposal(decisionID(req), await versionOf(req), req.user.id)
      req.info('DECISION_PROPOSAL_WITHDRAWN')
      return SELECT.one.from(CampDecisions, decisionID(req))
    })

    this.on('approve', CampDecisions, async req => {
      const status = await decisions.approve(decisionID(req), await versionOf(req), req.user.id)
      const d = await SELECT.one.from(CampDecisions, decisionID(req))
      if (status === 'SCHEDULED') req.info('DECISION_SCHEDULED', [d.effectiveFrom])
      else req.info({ TARGET: 'TARGET_IN_FORCE', PHASE: 'PHASE_IN_FORCE' }[d.kind] ?? 'DECISION_IN_FORCE')
      return d
    })

    this.on('rejectProposal', CampDecisions, async req => {
      await decisions.reject(decisionID(req), await versionOf(req), req.data.reason, req.user.id)
      req.info('DECISION_REJECTED')
      return SELECT.one.from(CampDecisions, decisionID(req))
    })

    const figureText = (value, standard) => value === null || value === undefined ? null
      : `${Number(value)} ${standard?.unit ?? ''} per person${standard?.basis === 'Consumption' ? ' per day' : ''}`.replace(/\s+/g, ' ')
    const PHASE_TEXT = {
      FIRST_PHASE: 'First phase of a rapid-onset crisis (toilets: 1 per 50 people)',
      MEDIUM_TERM: 'Medium term (toilets: 1 per 20 people)'
    }
    const STATUS_TEXT = { DRAFT: 'Draft', PENDING: 'Pending approval', APPROVED: 'In force', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn', SUPERSEDED: 'Superseded' }
    const day = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''
    /** Status in words, review state included (an overdue review never ends a decision). */
    const describe = (f, review) => {
      const status = f.status_code
      if (status === 'SCHEDULED') return `Scheduled from ${f.effectiveFrom}`
      if (status === 'APPROVED' && review?.state === 'OVERDUE') return 'In force, review overdue'
      if (status === 'APPROVED' && review?.state === 'DUE_TODAY') return 'In force, review due today'
      return STATUS_TEXT[status]
    }
    const reviewText = review => {
      if (!review?.state) return null
      const last = review.last
      switch (review.state) {
        case 'NOT_DUE': return `Review due ${day(review.due)}`
        case 'DUE_TODAY': return 'Review due today'
        case 'OVERDUE': return `Review overdue since ${day(review.due)}`
        case 'COMPLETED': return last.outcome_code === 'CONFIRMED'
          ? `Reviewed ${day(last.reviewedAt.slice(0, 10))} by ${last.reviewedBy}: confirmed, next review ${day(review.due)}`
          : `Reviewed ${day(last.reviewedAt.slice(0, 10))} by ${last.reviewedBy}: change proposed, waiting for approval`
        case 'SUPERSEDED': return 'Superseded: no longer reviewed'
        case 'WITHDRAWN': return 'Withdrawn: no longer reviewed'
      }
    }

    /** What the signed-in user may do with each decision; the actions check it again. */
    this.after('READ', CampDecisions, async (rows, req) => {
      const user = req.user.id
      const admin = req.user.is('Administrator')
      const list = (Array.isArray(rows) ? rows : rows ? [rows] : []).filter(d => d.ID)
      if (!list.length) return
      // The flags need these fields whatever the client selected, so they are read here.
      const factRows = await SELECT.from(db.CampDecisions)
        .columns(d => {
          d.ID, d.kind, d.status_code, d.proposedBy, d.intent, d.reviewDate, d.effectiveFrom, d.inForceFrom, d.applicable, d.previousApplicable,
          d.targetPerPerson, d.previousTargetPerPerson, d.referencePerPerson, d.previousDecision_ID, d.responsePhase, d.previousResponsePhase
          d.standard(t => { t.name, t.unit, t.basis, t.perPerson, t.perHousehold })
        })
        .where({ ID: { in: list.map(d => d.ID) } })
      const facts = Object.fromEntries(factRows.map(f => [f.ID, f]))
      const reviews = await decisions.reviewStates(factRows)
      for (const d of list) {
        const f = facts[d.ID]
        if (f) {
          const status = f.status_code
          const own = f.proposedBy === user
          const target = f.kind === 'TARGET'
          const review = reviews[d.ID]
          d.canApprove = admin && status === 'PENDING' && !own
          d.canReject = d.canApprove
          d.canSubmit = status === 'DRAFT' && own
          const phase = f.kind === 'PHASE'
          d.canRevise = d.canSubmit && f.kind === 'APPLICABILITY'
          d.canRevisePhase = d.canSubmit && phase
          d.subjectText = phase ? 'Response phase' : f.standard?.name ?? null
          d.canReviseTarget = d.canSubmit && target
          d.canWithdraw = ['DRAFT', 'PENDING'].includes(status) && own
          d.canReview = admin && status === 'APPROVED' && f.intent === 'DECIDE'
          d.reviewState = review?.state ?? null
          d.reviewDue = review?.due ?? null
          d.reviewStateText = reviewText(review)
          d.reviewOverdue = review?.state === 'OVERDUE'
          d.displayStatus = describe(f, review)
          d.kindText = phase ? 'Response phase' : target ? 'Local target' : 'Applicability'
          if (phase) {
            d.valueText = f.intent === 'WITHDRAW' ? 'Withdraw the phase decision (back to the medium term by default)' : PHASE_TEXT[f.responsePhase] ?? null
            d.previousText = f.previousDecision_ID ? PHASE_TEXT[f.previousResponsePhase] : 'Medium term (default, no decision)'
            d.referenceText = null
          } else if (target) {
            d.valueText = f.intent === 'WITHDRAW' ? 'Withdraw the local target (back to the reference figure)' : figureText(f.targetPerPerson, f.standard)
            const perHousehold = f.standard?.perHousehold != null ? `${Number(f.standard.perHousehold)} ${f.standard.unit} per household` : null
            d.previousText = f.previousDecision_ID ? `Local target ${figureText(f.previousTargetPerPerson, f.standard)}` : perHousehold ?? `Reference figure ${figureText(f.referencePerPerson ?? f.standard?.perPerson, f.standard)}`
            d.referenceText = perHousehold ?? figureText(f.referencePerPerson ?? f.standard?.perPerson, f.standard)
          } else {
            d.valueText = f.intent === 'WITHDRAW' ? 'Withdraw the decision in force'
              : f.applicable === true ? 'Applicable' : f.applicable === false ? 'Not applicable' : null
            d.previousText = f.previousApplicable === true ? 'Applicable' : f.previousApplicable === false ? 'Not applicable' : 'None (not decided)'
            d.referenceText = null
          }
          d.approvalNote = status !== 'PENDING' ? null
            : own ? 'You proposed this decision, so another Administrator must approve it.'
            : admin ? null : 'An Administrator other than the proposer approves this decision.'
        }
      }
    })

    this.on('attention', async () => {
      const today = decisions.today()
      const items = []
      const undecided = await SELECT.from(db.Stock)
        .columns(s => { s.camp_ID, s.standard_code, s.camp(c => { c.name }), s.standard(t => { t.name }) })
        .where({ 'camp.status_code': 'ACTIVE', assessment: 'NOT_DECIDED' })
      for (const l of undecided)
        items.push({ kind: 'NOT_DECIDED', campID: l.camp_ID, campName: l.camp.name, standardCode: l.standard_code, standardName: l.standard.name })
      const open = (await SELECT.from(db.CampDecisions)
        .columns(d => {
          d.ID, d.kind, d.camp_ID, d.standard_code, d.status_code, d.reviewDate, d.effectiveFrom, d.inForceFrom, d.intent, d.previousDecision_ID
          d.camp(c => { c.name, c.status_code }), d.standard(t => { t.name })
        })
        .where({ status_code: { in: ['PENDING', 'SCHEDULED', 'APPROVED'] } })).filter(d => d.camp.status_code === 'ACTIVE')
      const reviews = await decisions.reviewStates(open)
      for (const d of open) {
        const base = { campID: d.camp_ID, campName: d.camp.name, standardCode: d.standard_code, standardName: d.standard?.name ?? 'Response phase', decisionID: d.ID, decisionKind: d.kind }
        if (d.status_code === 'PENDING') items.push({ ...base, kind: 'PENDING', date: d.effectiveFrom })
        else if (d.status_code === 'SCHEDULED')
          // due but still scheduled because the decision it was approved against is no longer in force
          items.push({ ...base, kind: d.effectiveFrom <= today && await decisions.contextChanged(d) ? 'SCHEDULED_BLOCKED' : 'SCHEDULED', date: d.effectiveFrom })
        else if (reviews[d.ID]?.state === 'OVERDUE') items.push({ ...base, kind: 'REVIEW_OVERDUE', date: reviews[d.ID].due })
        else if (reviews[d.ID]?.state === 'DUE_TODAY') items.push({ ...base, kind: 'REVIEW_DUE', date: reviews[d.ID].due })
      }
      const flagged = await SELECT.from(db.Requests)
        .columns(r => { r.ID, r.camp_ID, r.standard_code, r.camp(c => { c.name }), r.standard(t => { t.name }), r.currentReview(v => { v.flaggedAt, v.causeText, v.detail }) })
        .where({ review_code: 'PENDING' })
      for (const r of flagged)
        items.push({ kind: 'REQUEST_REVIEW', campID: r.camp_ID, campName: r.camp.name, standardCode: r.standard_code, standardName: r.standard.name,
          requestID: r.ID, date: r.currentReview?.flaggedAt?.slice(0, 10) ?? null,
          reason: r.currentReview?.detail ?? r.currentReview?.causeText ?? null })
      // B4.3 governance: a household-size proposal waits for a second Administrator
      const proposals = await SELECT.from(db.HouseholdSizeProposals).where({ status: 'PENDING' })
      for (const p of proposals)
        items.push({ kind: 'HOUSEHOLD_SIZE_PENDING', campName: '', standardCode: '', standardName: '', proposalID: p.ID, date: p.proposedAt?.slice(0, 10) ?? null,
          reason: `${Number(p.previousSize)} → ${Number(p.proposedSize)} people per household, proposed by ${p.proposedBy}: ${p.reason}`.slice(0, 400) })
      const ORDER = { REQUEST_REVIEW: 1, SCHEDULED_BLOCKED: 2, HOUSEHOLD_SIZE_PENDING: 3, PENDING: 3, REVIEW_OVERDUE: 4, REVIEW_DUE: 5, NOT_DECIDED: 6, SCHEDULED: 7 }
      return items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.campName ?? '').localeCompare(b.campName ?? '') || (a.standardCode ?? '').localeCompare(b.standardCode ?? ''))
    })

    this.on('localTargets', async () => {
      const rows = (await SELECT.from(db.CampDecisions)
        .columns(d => {
          d.ID, d.camp_ID, d.standard_code, d.status_code, d.intent, d.targetPerPerson, d.referencePerPerson, d.effectiveFrom, d.reviewDate, d.inForceFrom,
          d.camp(c => { c.name, c.status_code }), d.standard(t => { t.name, t.unit, t.basis, t.perPerson })
        })
        .where({ kind: 'TARGET', status_code: { in: ['PENDING', 'SCHEDULED', 'APPROVED', 'SUPERSEDED', 'WITHDRAWN'] } }))
        // not a proposal withdrawn before it ever applied, nor a withdrawal that took effect (the withdrawn target's own row shows it)
        .filter(d => d.camp.status_code === 'ACTIVE' && !(d.status_code === 'WITHDRAWN' && !d.inForceFrom) && !(d.status_code === 'APPROVED' && d.intent === 'WITHDRAW'))
      const reviews = await decisions.reviewStates(rows)
      const ORDER = { APPROVED: 1, SCHEDULED: 2, PENDING: 3, SUPERSEDED: 4, WITHDRAWN: 5 }
      return rows.map(d => ({
        decisionID: d.ID, campID: d.camp_ID, campName: d.camp.name, standardCode: d.standard_code, standardName: d.standard.name,
        unit: d.standard.unit, basis: d.standard.basis, intent: d.intent, status: d.status_code,
        displayStatus: describe(d, reviews[d.ID]),
        targetPerPerson: d.targetPerPerson, referencePerPerson: d.referencePerPerson ?? d.standard.perPerson,
        effectiveFrom: d.effectiveFrom ?? d.inForceFrom?.slice(0, 10) ?? null,
        reviewDue: reviews[d.ID]?.due ?? null, reviewState: reviews[d.ID]?.state ?? null
      })).sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.campName ?? '').localeCompare(b.campName ?? '') || (a.standardCode ?? '').localeCompare(b.standardCode ?? ''))
    })

    this.on('confirmDelivery', Pledges, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      const result = await supply.recordReceipt(ID, req.data, req.user.id)
      if (result.afterClosure) req.info('RECEIPT_AFTER_CLOSURE')
      if (result.overReceipt) req.info('RECEIPT_OVER_PLEDGE')
      return SELECT.one.from(Pledges, ID)
    })

    this.on('closePledge', Pledges, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      await supply.closePledge(ID, req.data.reason, req.user.id)
      return SELECT.one.from(Pledges, ID)
    })

    this.on('withdraw', Pledges, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      await supply.withdraw(ID, req.user.id)
      return SELECT.one.from(Pledges, ID)
    })

    this.on('withdrawAllOfDonor', Pledges, async req => {
      const p = await SELECT.one.from(db.Pledges).columns('createdBy').where({ ID: supply.keyOf(req.params.at(-1)) })
      if (!p) return req.error(404, 'PLEDGE_NOT_FOUND')
      const n = await supply.withdrawAllOf(p.createdBy, req.data.reason, req.user.id)
      req.info('PLEDGES_WITHDRAWN_ALL', [n])
      return n
    })

    // ARCH-04: a camp with any history is closed, never deleted; only an untouched camp can be deleted.
    const historyOf = async ID => {
      const [counted, requests, decisions_] = await Promise.all([
        SELECT.one.from(db.Stock).columns('ID').where({ camp_ID: ID, countedAt: { '!=': null } }),
        SELECT.one.from(db.Requests).columns('ID').where({ camp_ID: ID }),
        SELECT.one.from(db.CampDecisions).columns('ID').where({ camp_ID: ID })
      ])
      return !!(counted || requests || decisions_)
    }
    this.before('DELETE', Camps, async req => {
      const ID = req.data.ID ?? supply.keyOf(req.params.at(-1))
      const camp = await ledger.lockCamp(ID)
      if (!camp) return
      if (await historyOf(ID)) return req.reject(409, 'CAMP_HAS_HISTORY')
      // an untouched camp: only its empty stock lines and its registration assessment go with it
      await DELETE.from(db.Stock).where({ camp_ID: ID })
      const records = (await SELECT.from(db.AssessmentRecords).columns('ID').where({ camp_ID: ID })).map(r => r.ID)
      if (records.length) {
        await DELETE.from(db.AssessmentRecordLines).where({ record_ID: { in: records } })
        await DELETE.from(db.AssessmentRecords).where({ ID: { in: records } })
      }
      await ledger.event('CAMP_DELETED', { campID: ID, campName: camp.name, detail: 'Deleted before any count, request or decision was recorded' })
    })
    // Shown to the UI so Delete is offered only where it would be accepted (UX-07); the check above still decides.
    this.after('READ', Camps, async rows => {
      for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) if (r?.ID) r.deletable = !(await historyOf(r.ID))
    })

    this.on('change', PlanningSettings, async req => {
      if (supply.keyOf(req.params.at(-1)) !== planning.ID) return req.error(404, 'SETTINGS_MISSING')
      const values = Object.fromEntries(planning.FIELDS.map(f => [f, req.data[f] === null || req.data[f] === undefined || req.data[f] === '' ? NaN : Number(req.data[f])]))
      const reason = (req.data.reason ?? '').trim()
      const basedOn = Number(req.data.version)
      if (!reason) req.error(400, 'SETTINGS_REASON_REQUIRED', 'reason')
      if (!Number.isInteger(basedOn)) req.error(400, 'SETTINGS_VERSION_REQUIRED', 'version')
      for (const p of planning.validate(values)) req.error(400, p.message, p.target)
      if (req.errors) return

      const { linesChanged, campsChanged, version } = await planning.change(values, reason, req.user.id, basedOn)
      req.info('SETTINGS_SAVED')
      req.info('SETTINGS_IMPACT', [linesChanged, campsChanged])
      if (values.targetDays < values.warningDays) req.warn('SETTINGS_TARGET_BELOW_WARNING', [values.targetDays, values.warningDays])
      return { linesChanged, campsChanged, version }
    })

    // Household size (B4.3 governance): one Administrator proposes, another approves.
    this.on('proposeSize', HouseholdAssumption, async req => {
      if (supply.keyOf(req.params.at(-1)) !== households.ID) return req.error(404, 'HOUSEHOLD_ASSUMPTION_MISSING')
      const ID = await households.propose(req.data.householdSize, req.data.reason, req.user.id, Number(req.data.version))
      req.info('HOUSEHOLD_PROPOSED')
      return SELECT.one.from(HouseholdSizeProposals).where({ ID })
    })
    this.on('approve', HouseholdSizeProposals, async req => {
      const result = await households.approve(supply.keyOf(req.params.at(-1)), req.user.id)
      req.info('HOUSEHOLD_SAVED', [result.linesChanged, result.campsChanged])
      if (result.requestsFlagged) req.info('HOUSEHOLD_REQUESTS_FLAGGED', [result.requestsFlagged])
      return result
    })
    this.on('rejectProposal', HouseholdSizeProposals, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      await households.reject(ID, req.data.reason, req.user.id)
      req.info('HOUSEHOLD_REJECTED')
      return SELECT.one.from(HouseholdSizeProposals).where({ ID })
    })
    this.on('withdraw', HouseholdSizeProposals, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      await households.withdraw(ID, req.user.id)
      req.info('HOUSEHOLD_WITHDRAWN')
      return SELECT.one.from(HouseholdSizeProposals).where({ ID })
    })

    this.on('planningAccess', req => ({ canChange: req.user.is('Administrator'), user: req.user.id }))

    // ARCH-08: the calendar day of the operation, so screens label due and overdue dates as the server does
    this.on('operation', () => ({ timeZone: require('./lib/clock').timeZone(), today: require('./lib/clock').today() }))

    this.on('actNow', async () => {
      const today = decisions.today()
      const active = { 'camp.status_code': 'ACTIVE' }
      const [gaps, late, unanswered] = await Promise.all([
        SELECT.from(db.Stock)
          .columns(s => { s.camp_ID, s.daysOfCover, s.coveragePct, s.camp(c => { c.name }), s.standard(t => { t.name, t.unit, t.basis }) })
          .where({ ...active, assessment: 'CRITICAL' }),
        SELECT.from(db.Pledges)
          .columns(p => { p.ID, p.donor, p.quantity, p.receivedQuantity, p.eta, p.request(r => { r.ID, r.camp_ID, r.camp(c => { c.name }), r.standard(t => { t.name, t.unit }) }) })
          .where({ status_code: { in: ['PLEDGED', 'PARTIAL'] }, eta: { '<': today }, 'request.camp.status_code': 'ACTIVE' }),
        SELECT.from(db.Requests)
          .columns(r => { r.ID, r.camp_ID, r.quantity, r.neededBy, r.camp(c => { c.name }), r.standard(t => { t.name, t.unit }) })
          .where({ ...active, status_code: 'OPEN', pledgedQuantity: 0, neededBy: { '<': today } }).and(`review_code is null or review_code != 'PENDING'`)
      ])
      // consumables by days of supply left, then infrastructure by coverage: the soonest stock-out first
      const byUrgency = (a, b) => (a.standard.basis === b.standard.basis
        ? Number(a.daysOfCover ?? a.coveragePct ?? 0) - Number(b.daysOfCover ?? b.coveragePct ?? 0)
        : a.standard.basis === 'Consumption' ? -1 : 1)
      return [
        ...gaps.sort(byUrgency).map(g => ({ kind: 'CRITICAL_GAP', campID: g.camp_ID, campName: g.camp.name, standardName: g.standard.name, unit: g.standard.unit,
          daysOfCover: g.daysOfCover, coveragePct: g.coveragePct })),
        ...late.sort((a, b) => a.eta.localeCompare(b.eta)).map(p => ({ kind: 'OVERDUE_DELIVERY', campID: p.request.camp_ID, campName: p.request.camp.name,
          standardName: p.request.standard.name, unit: p.request.standard.unit, quantity: Number(p.quantity) - Number(p.receivedQuantity ?? 0), donor: p.donor, date: p.eta,
          pledgeID: p.ID, requestID: p.request.ID })),
        ...unanswered.sort((a, b) => a.neededBy.localeCompare(b.neededBy)).map(r => ({ kind: 'UNANSWERED_REQUEST', campID: r.camp_ID, campName: r.camp.name,
          standardName: r.standard.name, unit: r.standard.unit, quantity: r.quantity, date: r.neededBy, requestID: r.ID }))
      ]
    })

    this.on('overview', async () => {
      const active = { status_code: 'ACTIVE' }
      const [camps, health, gaps, openRequests, unpledged, inTransit, notAssessed] = await Promise.all([
        SELECT.one.from(db.Camps).columns('count(1) as n', 'sum(headcount) as people', 'sum(childrenUnder5) as children').where(active),
        SELECT.one.from(db.Camps)
          .columns('count(1) as n', 'sum(headcount) as people')
          .where({ ...active, 'health.worstSeverity': 1 }),
        // Same line states as CampHealth and the heatmap; not-assessed camps have no gaps.
        SELECT.from(db.Stock)
          .columns('assessment', 'count(1) as n')
          .where({ 'camp.status_code': 'ACTIVE' })
          .groupBy('assessment'),
        SELECT.one.from(db.Requests).columns('count(1) as n').where({ status_code: { in: supply.OUTSTANDING } }),
        SELECT.one.from(db.Requests).columns('count(1) as n').where({ status_code: { in: ['OPEN', 'PARTIAL'] } }),
        SELECT.one.from(db.Pledges).columns('count(1) as n').where({ status_code: { in: ['PLEDGED', 'PARTIAL'] }, 'request.camp.status_code': 'ACTIVE' }),
        SELECT.one.from(db.Camps).columns('count(1) as n').where(`status_code = 'ACTIVE' and (headcount is null or headcount <= 0)`)
      ])
      const [pending, scheduled, live, toReview] = await Promise.all([
        SELECT.one.from(db.CampDecisions).columns('count(1) as n').where({ status_code: 'PENDING', 'camp.status_code': 'ACTIVE' }),
        SELECT.one.from(db.CampDecisions).columns('count(1) as n').where({ status_code: 'SCHEDULED', 'camp.status_code': 'ACTIVE' }),
        SELECT.from(db.CampDecisions).columns('ID', 'kind', 'camp_ID', 'status_code', 'intent', 'reviewDate', 'inForceFrom')
          .where({ status_code: 'APPROVED', intent: 'DECIDE', 'camp.status_code': 'ACTIVE' }),
        SELECT.one.from(db.Requests).columns('count(1) as n').where({ review_code: 'PENDING' })
      ])
      // UX-01: requests still waiting for donors, and requests with goods on the way, counted apart
      const [awaiting, incoming] = await Promise.all([
        SELECT.one.from(db.Requests).columns('count(1) as n')
          .where({ status_code: { in: ['OPEN', 'PARTIAL'] }, 'camp.status_code': 'ACTIVE' }).and(`review_code is null or review_code != 'PENDING'`),
        SELECT.one.from(db.Requests).columns('count(distinct ID) as n')
          .where({ 'camp.status_code': 'ACTIVE', status_code: { '!=': 'CANCELLED' }, 'pledges.status_code': { in: ['PLEDGED', 'PARTIAL'] } })
      ])
      const reviews = await decisions.reviewStates(live)
      const states = Object.values(reviews).map(r => r.state)
      const targets = live.filter(d => d.kind === 'TARGET')
      const byState = Object.fromEntries(gaps.map(g => [g.assessment, g.n]))
      return {
        activeCamps: camps.n ?? 0,
        people: Number(camps.people ?? 0),
        childrenUnder5: Number(camps.children ?? 0),
        campsInCrisis: health.n ?? 0,
        peopleInCrisis: Number(health.people ?? 0),
        criticalGaps: byState.CRITICAL ?? 0,
        warningGaps: byState.ATTENTION ?? 0,
        campsNotAssessed: notAssessed.n ?? 0,
        indicatorsNotCounted: byState.NOT_COUNTED ?? 0,
        indicatorsNotVerified: byState.NOT_VERIFIED ?? 0,
        decisionsNeeded: byState.NOT_DECIDED ?? 0,
        pendingDecisions: pending.n ?? 0,
        scheduledDecisions: scheduled.n ?? 0,
        overdueReviews: states.filter(s => s === 'OVERDUE').length,
        reviewsDueToday: states.filter(s => s === 'DUE_TODAY').length,
        localTargetsInForce: targets.length,
        campsWithLocalTargets: new Set(targets.map(d => d.camp_ID)).size,
        requestsToReview: toReview.n ?? 0,
        openRequests: openRequests.n ?? 0,
        unpledgedQuantityLines: unpledged.n ?? 0,
        pledgesInTransit: inTransit.n ?? 0,
        requestsAwaitingPledge: awaiting.n ?? 0,
        requestsWithIncomingPledges: incoming.n ?? 0
      }
    })

    return super.init()
  }
}
