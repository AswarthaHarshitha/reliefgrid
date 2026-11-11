const cds = require('@sap/cds')
const assessment = require('./assessment')

/** The single planning-settings record. */
const ID = 'CURRENT'

/**
 * ReliefGrid's operational planning choices as shipped. They are not Sphere
 * requirements, and they are used only to create the record when it is
 * missing; an existing record is never overwritten.
 */
const DEFAULTS = Object.freeze({ criticalDays: 2, warningDays: 5, criticalPercent: 50, warningPercent: 90, targetDays: 7 })
const FIELDS = Object.keys(DEFAULTS)

const cap = s => s[0].toUpperCase() + s.slice(1)
const numbers = row => Object.fromEntries(FIELDS.map(f => [f, row[f] === null || row[f] === undefined ? null : Number(row[f])]))

/**
 * Creates the record with the defaults if, and only if, it does not exist yet.
 * The primary key allows only one record; when another process creates it at
 * the same moment (or holds the database briefly), this retries and accepts
 * the record that is there instead of failing.
 */
async function ensureSettings(attempts = 5) {
  const { PlanningSettings } = cds.entities('reliefgrid')
  const exists = async () => SELECT.one.from(PlanningSettings).columns('ID').where({ ID })
  for (let attempt = 1; ; attempt++) {
    try {
      if (await exists()) return false
      await INSERT.into(PlanningSettings).entries({ ID, ...DEFAULTS, version: 1 })
      return true
    } catch (e) {
      if (await exists().catch(() => null)) return false
      if (attempt >= attempts) throw e
      await new Promise(resolve => setTimeout(resolve, 100 * attempt))
    }
  }
}

/** The settings in force, as numbers. */
async function current() {
  const { PlanningSettings } = cds.entities('reliefgrid')
  const row = await SELECT.one.from(PlanningSettings).where({ ID })
  if (!row) cds.error({ status: 500, message: 'SETTINGS_MISSING' })
  return numbers(row)
}

/** Checks one complete set of values; returns the problems as message keys with targets. */
function validate(v) {
  const problems = []
  for (const f of FIELDS)
    if (typeof v[f] !== 'number' || !Number.isFinite(v[f]) || !(v[f] > 0)) problems.push({ message: 'SETTINGS_POSITIVE', target: f })
  if (problems.length) return problems
  if (v.criticalDays >= v.warningDays) problems.push({ message: 'SETTINGS_DAYS_ORDER', target: 'criticalDays' })
  if (v.criticalPercent >= v.warningPercent) problems.push({ message: 'SETTINGS_PERCENT_ORDER', target: 'criticalPercent' })
  if (v.warningPercent > 100) problems.push({ message: 'SETTINGS_PERCENT_RANGE', target: 'warningPercent' })
  if (v.warningDays > 90) problems.push({ message: 'SETTINGS_DAYS_RANGE', target: 'warningDays' })
  if (!Number.isInteger(v.targetDays) || v.targetDays > 90) problems.push({ message: 'TARGET_DAYS_RANGE', target: 'targetDays' })
  return problems
}

/**
 * Replaces the settings in one transaction: locks the record, refuses a change
 * based on an older version (so no one silently overwrites another person's
 * change), writes the change log (who, when, why, previous and new values) and
 * reports how many indicator lines and camps changed state because of it.
 */
async function change(values, reason, user, basedOn) {
  const { PlanningSettings, PlanningSettingsChanges, Stock } = cds.entities('reliefgrid')
  const before = await SELECT.one.from(PlanningSettings).where({ ID }).forUpdate()
  if (!before) cds.error({ status: 500, message: 'SETTINGS_MISSING' })
  if (Number(before.version) !== basedOn)
    cds.error({ status: 409, message: 'SETTINGS_CHANGED_MEANWHILE', args: [before.modifiedBy ?? '', before.version] })
  const previous = numbers(before)
  if (FIELDS.every(f => previous[f] === values[f])) cds.error({ status: 409, message: 'SETTINGS_UNCHANGED' })

  const states = async () => Object.fromEntries(
    (await SELECT.from(Stock).columns('ID', 'camp_ID', 'assessment').where({ 'camp.status_code': 'ACTIVE' }))
      .map(s => [s.ID, s]))
  const old = await states()

  const changedAt = new Date().toISOString()
  const version = Number(before.version) + 1
  const changeID = cds.utils.uuid()
  await UPDATE(PlanningSettings, ID).with({ ...values, version })
  await INSERT.into(PlanningSettingsChanges).entries({
    ID: changeID,
    changedAt,
    changedBy: user,
    reason,
    version,
    ...Object.fromEntries(FIELDS.map(f => [`previous${cap(f)}`, previous[f]])),
    ...Object.fromEntries(FIELDS.map(f => [`new${cap(f)}`, values[f]]))
  })

  // Every active camp's assessment under the new settings, in this transaction.
  await assessment.record(await assessment.activeCamps(), { trigger: assessment.TRIGGERS.SETTINGS_CHANGED, triggerID: changeID, actor: user })

  const now = await states()
  const moved = Object.values(now).filter(s => old[s.ID] && old[s.ID].assessment !== s.assessment)
  return { previous, version, linesChanged: moved.length, campsChanged: new Set(moved.map(s => s.camp_ID)).size }
}

module.exports = { ID, DEFAULTS, FIELDS, ensureSettings, current, validate, change }
