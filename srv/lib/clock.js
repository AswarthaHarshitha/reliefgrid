const cds = require('@sap/cds')

/**
 * Date-only logic in the operation's own time zone (ARCH-08). Needed-by dates,
 * past-ETA checks, effective and review dates are calendar days where the camps
 * are, not UTC days. The zone is configured (cds.reliefgrid.timeZone, or the
 * RELIEFGRID_TIME_ZONE environment variable); without it, UTC, as before.
 */
function timeZone() {
  return process.env.RELIEFGRID_TIME_ZONE || cds.env.reliefgrid?.timeZone || 'UTC'
}

/** Refuses an unknown zone at start-up instead of silently using another day. */
function assertTimeZone(zone = timeZone()) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone })
  } catch {
    throw new Error(`[reliefgrid] - unknown operation time zone "${zone}" (cds.reliefgrid.timeZone or RELIEFGRID_TIME_ZONE)`)
  }
  return zone
}

/** The calendar date (yyyy-mm-dd) of a moment in the operation time zone. */
function dateOf(moment = new Date(), zone = timeZone()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(moment).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Today in the operation time zone. */
const today = () => dateOf(new Date())

/** The date a number of days after a moment, counted in calendar days of the operation time zone. */
function addDays(days, from = new Date()) {
  const d = new Date(`${dateOf(from)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

module.exports = { timeZone, assertTimeZone, dateOf, today, addDays }
