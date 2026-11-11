const cds = require('@sap/cds')
const crypto = require('node:crypto')

/** Event types an assessment record can be written for. */
const TRIGGERS = Object.freeze({
  STOCK_COUNTED: 'STOCK_COUNTED',
  DELIVERY_CONFIRMED: 'DELIVERY_CONFIRMED',
  CAMP_REGISTERED: 'CAMP_REGISTERED',
  POPULATION_CHANGED: 'POPULATION_CHANGED',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  SETTINGS_INITIALISED: 'SETTINGS_INITIALISED',
  REFERENCE_DATA_CHANGED: 'REFERENCE_DATA_CHANGED',
  REQUESTS_RAISED: 'REQUESTS_RAISED',
  REQUEST_SUBMITTED: 'REQUEST_SUBMITTED',
  BASELINE: 'BASELINE',
  DECISION_EFFECTIVE: 'DECISION_EFFECTIVE',
  HOUSEHOLDS_CHANGED: 'HOUSEHOLDS_CHANGED',
  HOUSEHOLD_ASSUMPTION_CHANGED: 'HOUSEHOLD_ASSUMPTION_CHANGED',
  HOUSEHOLD_ASSUMPTION_INITIALISED: 'HOUSEHOLD_ASSUMPTION_INITIALISED',
  RATION_ENERGY_CHANGED: 'RATION_ENERGY_CHANGED'
})

const BASELINE_LABEL = 'Baseline at B4 upgrade'

/** A stable UUID for a camp's baseline, so a second start can never add another one. */
function baselineID(campID) {
  const h = crypto.createHash('sha256').update(`reliefgrid:baseline:${campID}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Writes one assessment record per camp, copying the live calculation and its
 * inputs. Runs in the caller's transaction: when the business operation rolls
 * back, so does the record, and when the record cannot be written the
 * operation fails. Returns { campID: recordID }.
 */
async function record(campIDs, { trigger, triggerID = null, label = null, actor = cds.context?.user?.id ?? 'system', ID } = {}) {
  if (!TRIGGERS[trigger]) throw new Error(`unknown assessment trigger ${trigger}`)
  const { Camps, Stock, PlanningSettings, AssessmentRecords, CampHouseholds, CampPhases } = cds.entities('reliefgrid')
  const ids = [...new Set(campIDs)].filter(Boolean)
  if (!ids.length) return {}

  const settings = await SELECT.one.from(PlanningSettings).where({ ID: 'CURRENT' })
  const assessedAt = new Date().toISOString()
  const recorded = {}

  for (const campID of ids) {
    const camp = await SELECT.one.from(Camps).columns('ID', 'name', 'headcount', 'status_code', 'rationKcalPerPack').where({ ID: campID })
    if (!camp) continue
    const lines = await SELECT.from(Stock)
      .columns(s => {
        s.standard_code, s.quantity, s.countedAt, s.assessment, s.severity, s.required, s.daysOfCover, s.coveragePct, s.shortfall, s.functionalUnits
        s.perPerson, s.targetBasis, s.referencePerPerson
        s.standard(t => { t.name, t.basis, t.unit, t.perPerson, t.perHousehold, t.reference, t.applicability, t.countsFunctional, t.kcalPerPersonDay, t.defaultKcalPerUnit })
        s.applicability(a => { a.ID, a.version, a.applicable })
        s.target(g => { g.ID, g.version, g.effectiveFrom, g.inForceFrom, g.source })
      })
      .where({ camp_ID: campID })
      .orderBy('standard_code')

    const households = await SELECT.one.from(CampHouseholds).where({ campID })
    const phase = await SELECT.one.from(CampPhases).where({ campID })
    const recordID = ID ? ID(campID) : cds.utils.uuid()
    await INSERT.into(AssessmentRecords).entries({
      ID: recordID,
      camp_ID: campID,
      assessedAt,
      trigger,
      triggerID: triggerID === null ? null : String(triggerID),
      label,
      actor,
      campName: camp.name,
      campStatus: camp.status_code,
      headcount: camp.headcount ?? null,
      settingsVersion: settings?.version ?? null,
      criticalDays: settings?.criticalDays ?? null,
      warningDays: settings?.warningDays ?? null,
      criticalPercent: settings?.criticalPercent ?? null,
      warningPercent: settings?.warningPercent ?? null,
      targetDays: settings?.targetDays ?? null,
      recordedHouseholds: households?.recordedHouseholds ?? null,
      estimatedHouseholds: households?.estimatedHouseholds ?? null,
      householdBasis: households?.householdBasis ?? null,
      householdSize: households?.householdSize ?? null,
      householdAssumptionVersion: households?.householdAssumptionVersion ?? null,
      responsePhase: phase?.responsePhase ?? null,
      responsePhaseBasis: phase?.responsePhaseBasis ?? null,
      phaseDecisionID: phase?.phaseDecisionID ?? null,
      phaseDecisionVersion: phase?.phaseDecisionVersion ?? null,
      // food energy (B5): the kcal of one pack recorded for the camp, or the planning assumption
      rationKcalPerPack: camp.rationKcalPerPack ?? (lines.find(l => l.standard?.kcalPerPersonDay)?.standard.defaultKcalPerUnit ?? null),
      rationKcalBasis: camp.rationKcalPerPack != null ? 'RECORDED' : lines.some(l => l.standard?.kcalPerPersonDay) ? 'ASSUMED' : null,
      lines: lines.map(l => ({
        standardCode: l.standard_code,
        standardName: l.standard?.name,
        basis: l.standard?.basis,
        unit: l.standard?.unit,
        // the figure the requirement was calculated with: the local target when one was in force (B4.2)
        perPerson: l.targetBasis === 'HOUSEHOLD' ? null : l.perPerson ?? l.standard?.perPerson ?? null,
        perHousehold: l.targetBasis === 'HOUSEHOLD' ? l.standard.perHousehold : null,
        requirementBasis: l.targetBasis ?? 'REFERENCE_FIGURE',
        requirementSource: l.standard?.reference,
        // a food-energy line's reference figure depends on the kcal of a pack (B5)
        referencePerPerson: l.standard?.kcalPerPersonDay ? (l.referencePerPerson ?? null) : l.standard?.perPerson ?? null,
        targetDecisionID: l.target?.ID ?? null,
        targetDecisionVersion: l.target?.version ?? null,
        targetEffectiveFrom: l.target ? (l.target.effectiveFrom ?? l.target.inForceFrom?.slice(0, 10) ?? null) : null,
        targetSource: l.target?.source ?? null,
        applicabilityRule: l.standard?.applicability,
        applicabilityDecisionID: l.applicability?.ID ?? null,
        applicabilityDecisionVersion: l.applicability?.version ?? null,
        applicable: l.applicability ? l.applicability.applicable : null,
        quantity: l.quantity,
        countedAt: l.countedAt,
        functionalUnits: l.functionalUnits ?? null,
        functionalityConfirmed: l.standard?.countsFunctional && l.quantity !== null ? l.functionalUnits !== null : null,
        kcalPerPersonDay: l.standard?.kcalPerPersonDay ?? null,
        kcalPerUnit: l.standard?.kcalPerPersonDay ? camp.rationKcalPerPack ?? l.standard.defaultKcalPerUnit ?? null : null,
        state: l.assessment,
        severity: l.severity,
        requirement: l.required,
        daysOfCover: l.daysOfCover,
        coveragePct: l.coveragePct,
        shortfall: l.shortfall
      }))
    })
    recorded[campID] = recordID
  }
  return recorded
}

/** Every camp that is still active. */
async function activeCamps() {
  const { Camps } = cds.entities('reliefgrid')
  return (await SELECT.from(Camps).columns('ID').where({ status_code: 'ACTIVE' })).map(c => c.ID)
}

/**
 * Gives every camp without any assessment record a baseline, labelled as such
 * and stamped with the upgrade time; nothing earlier is reconstructed. The ID
 * is derived from the camp, so this is idempotent even across processes.
 */
async function ensureBaselines() {
  const { Camps, AssessmentRecords } = cds.entities('reliefgrid')
  const camps = (await SELECT.from(Camps).columns('ID')).map(c => c.ID)
  const have = new Set((await SELECT.from(AssessmentRecords).columns('camp_ID')).map(r => r.camp_ID))
  const exists = async campID => SELECT.one.from(AssessmentRecords).columns('ID').where({ ID: baselineID(campID) })
  let created = 0
  for (const campID of camps.filter(c => !have.has(c))) {
    for (let attempt = 1; ; attempt++) {
      try {
        await cds.tx(() => record([campID], { trigger: TRIGGERS.BASELINE, label: BASELINE_LABEL, actor: 'system', ID: baselineID }))
        created++
        break
      } catch (e) {
        // another process wrote this camp's baseline at the same moment, or briefly holds the database
        if (await exists(campID).catch(() => null)) break
        if (attempt >= 5) throw e
        await new Promise(resolve => setTimeout(resolve, 100 * attempt))
      }
    }
  }
  return created
}

/** The calculation basis a new request keeps, taken from the assessment it was calculated from. */
async function requestBasis(recordID, standardCode, targetDays = null) {
  const { AssessmentRecords, AssessmentRecordLines } = cds.entities('reliefgrid')
  const head = await SELECT.one.from(AssessmentRecords)
    .columns('assessedAt', 'settingsVersion', 'recordedHouseholds', 'estimatedHouseholds', 'householdBasis', 'householdSize',
      'responsePhase', 'responsePhaseBasis', 'phaseDecisionID', 'phaseDecisionVersion', 'rationKcalPerPack', 'rationKcalBasis').where({ ID: recordID })
  const line = await SELECT.one.from(AssessmentRecordLines)
    .columns('requirement', 'perPerson', 'perHousehold', 'unit', 'basis', 'requirementSource', 'requirementBasis', 'referencePerPerson', 'targetDecisionID', 'targetDecisionVersion', 'targetSource', 'kcalPerPersonDay', 'kcalPerUnit')
    .where({ record_ID: recordID, standardCode })
  const per = line ? ` ${line.unit} per person${line.basis === 'Consumption' ? ' per day' : ''}` : ''
  const households = head?.householdBasis === 'RECORDED' ? `${head.recordedHouseholds} recorded households`
    : `${head?.estimatedHouseholds} estimated households at ${Number(head?.householdSize)} people per household`
  const phase = head?.responsePhaseBasis === 'DECIDED'
    ? `decision ${head.phaseDecisionID}, version ${head.phaseDecisionVersion}` : 'default, no decision'
  const figure = line?.requirementBasis === 'HOUSEHOLD' ? `${Number(line.perHousehold)} ${line.unit} per household for ${households}`
    : line?.requirementBasis === 'FOOD_ENERGY'
      ? `Food energy: ${line.kcalPerPersonDay} kcal per person per day at ${line.kcalPerUnit} kcal per pack (${head?.rationKcalBasis === 'RECORDED' ? 'recorded for the camp' : 'planning assumption, not recorded'}), ${Number(Number(line.perPerson).toFixed(6))}${per}`
    : line?.requirementBasis === 'PHASE_FIGURE' ? `First-phase figure ${Number(line.perPerson)}${per} (first phase of a rapid-onset crisis, ${phase})`
    : !line || line.perPerson === null ? 'No reference figure'
    : line.requirementBasis === 'LOCAL_TARGET'
      ? `Local target ${Number(line.perPerson)}${per} (decision ${line.targetDecisionID}, version ${line.targetDecisionVersion}; source: ${line.targetSource}), reference figure ${Number(line.referencePerPerson)}`
      : `Reference figure ${Number(line.perPerson)}${per}`
  return {
    basisAssessment_ID: recordID,
    basisRequirement: line?.requirement ?? null,
    basisSource: [figure, line?.requirementSource].filter(Boolean).join('. ').slice(0, 400),
    basisSettingsVersion: head?.settingsVersion ?? null,
    basisTargetDays: targetDays,
    basisCalculatedAt: head?.assessedAt ?? null
  }
}

module.exports = { TRIGGERS, BASELINE_LABEL, baselineID, record, activeCamps, ensureBaselines, requestBasis }
