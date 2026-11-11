const cds = require('@sap/cds')
const { isInsecureAuth, isLoopback, refusal, enforceLoopbackBinding } = require('./srv/lib/network-guard')

/**
 * CAP listens on every network interface unless told otherwise. The host
 * comes from HOST or cds.env.server.host (localhost in development and
 * test). Authentication that lets anyone in may only face a loopback
 * address: startup stops before listening if the configured host is not
 * loopback, and again if the address actually bound is not.
 */
cds.on('bootstrap', app => {
  // ARCH-08: an unknown operation time zone stops the start instead of dating everything wrongly
  require('./srv/lib/clock').assertTimeZone()
  // SEC-03 security headers and SEC-07 no test pages outside development and test, before anything is served
  require('./srv/lib/http-hardening').harden(app)
  // signing out with basic authentication: the browser's stored credentials are replaced (app/signout.html)
  require('./srv/lib/signout').install(app)
  // Stage F: liveness and readiness for the hosting platform; no data, no configuration, no sign-in
  app.get('/health', (req, res) => res.json({ status: 'ok' }))
  app.get('/ready', async (req, res) => {
    try {
      if (!cds.db) throw new Error('no database')
      await cds.db.run(SELECT.one.from('reliefgrid.PlanningSettings').columns('ID'))
      res.json({ status: 'ready' })
    } catch {
      res.status(503).json({ status: 'not ready' })
    }
  })
  const host = process.env.HOST || cds.env.server?.host
  const auth = cds.env.requires.auth?.kind
  const insecure = isInsecureAuth(auth)
  if (insecure && !isLoopback(host)) throw new Error(refusal(auth, host || 'all network interfaces'))

  const listen = app.listen.bind(app)
  app.listen = (port, ...rest) => {
    const server = host ? listen(port, host, ...rest) : listen(port, ...rest)
    if (insecure) server.once('listening', () => enforceLoopbackBinding(server, auth))
    return server
  }
})

/**
 * With a file-based SQLite database, the schema is created on first start
 * and evolved on later starts without dropping data. Reference data such as
 * the reference indicators is upserted from db/data on every start, so edited
 * figures take effect after a restart.
 */
cds.on('served', async () => {
  const db = cds.db
  if (!db) return
  const url = db.options.credentials?.url ?? db.options.credentials?.database
  const referenceChanged = db.kind === 'sqlite' && url && url !== ':memory:' ? await evolveFileDatabase(db) : false

  const planning = require('./srv/lib/planning')
  const assessment = require('./srv/lib/assessment')
  const { AssessmentRecords } = cds.entities('reliefgrid')
  const withHistory = new Set((await SELECT.from(AssessmentRecords).columns('camp_ID')).map(r => r.camp_ID))

  // The planning settings are created once with the defaults and never overwritten.
  const settingsCreated = await planning.ensureSettings()
  if (settingsCreated) console.log('[reliefgrid] - planning settings created with the default values')

  // The household assumption is created once with the default and never overwritten.
  const households = require('./srv/lib/households')
  const assumptionCreated = await households.ensureAssumption()
  if (assumptionCreated) console.log('[reliefgrid] - household assumption created with the default value')

  // Camps without any assessment history get one baseline, stamped now.
  const baselines = await assessment.ensureBaselines()
  if (baselines) console.log(`[reliefgrid] - ${baselines} camps given a baseline assessment ("${assessment.BASELINE_LABEL}")`)

  // Camps that already had history are re-assessed when an input changed at start-up.
  const affected = (await assessment.activeCamps()).filter(ID => withHistory.has(ID))
  // A reference-data change already re-assesses with the new assumption; one record is enough.
  for (const [changed, trigger] of [[referenceChanged, 'REFERENCE_DATA_CHANGED'], [settingsCreated, 'SETTINGS_INITIALISED'],
    [assumptionCreated && !referenceChanged, 'HOUSEHOLD_ASSUMPTION_INITIALISED']])
    if (changed && affected.length) {
      await cds.tx(() => assessment.record(affected, { trigger, actor: 'system' }))
      console.log(`[reliefgrid] - ${affected.length} camps re-assessed (${trigger})`)
    }

  // Scheduled applicability decisions whose date has come take effect (each with its own snapshot),
  // and outstanding requests for indicators that are not established are flagged for review.
  const decisions = require('./srv/lib/decisions')
  const activated = await decisions.activateDue()
  if (activated) console.log(`[reliefgrid] - ${activated} scheduled decisions took effect`)
  const flagged = await cds.tx(() => decisions.flagAllUnestablished('system'))
  if (flagged) console.log(`[reliefgrid] - ${flagged} outstanding requests flagged for review (indicator not established)`)
  const timer = setInterval(() => decisions.activateDue().catch(e => console.error('[reliefgrid] - scheduled decisions:', e.message)), 10 * 60 * 1000)
  timer.unref()
})

/** Reference figures that drive requirements; empty when the table does not exist yet. */
async function referenceFigures() {
  try {
    return JSON.stringify(await SELECT.from('reliefgrid.Standards').columns('code', 'basis', 'perPerson', 'perHousehold', 'perPersonFirstPhase', 'countsFunctional', 'kcalPerPersonDay', 'defaultKcalPerUnit').orderBy('code'))
  } catch {
    try {
      // a database from before food energy planning (B5)
      return JSON.stringify(await SELECT.from('reliefgrid.Standards').columns('code', 'basis', 'perPerson', 'perHousehold', 'perPersonFirstPhase', 'countsFunctional').orderBy('code'))
    } catch {}
    try {
      // a database from before functional counts (B4.5)
      return JSON.stringify(await SELECT.from('reliefgrid.Standards').columns('code', 'basis', 'perPerson', 'perHousehold', 'perPersonFirstPhase').orderBy('code'))
    } catch {}
    try {
      // a database from before phase-dependent figures (B4.4)
      return JSON.stringify(await SELECT.from('reliefgrid.Standards').columns('code', 'basis', 'perPerson', 'perHousehold').orderBy('code'))
    } catch {}
    try {
      // a database from before per-household figures: read what it has, which then counts as changed
      return JSON.stringify(await SELECT.from('reliefgrid.Standards').columns('code', 'basis', 'perPerson').orderBy('code'))
    } catch {
      return ''
    }
  }
}

/** Returns true when a reference figure changed (and the table existed before). */
async function evolveFileDatabase(db) {
  const figuresBefore = await referenceFigures()
  const csn = await cds.load(cds.options?.from ?? '*')
  await cds.deploy(csn).to(db, { schema_evolution: 'auto' })
  await cds.deploy.data(db, csn, { schema_evolution: 'auto' })

  const { Camps, Stock } = cds.entities('reliefgrid')
  // Stock lines created before counts were tracked as unknown hold the old
  // default 0 although nobody counted them (recordCount always sets
  // countedAt). Mark them not counted. Counted zeros are left alone, and the
  // audit fields keep their values: nobody edited these lines.
  const uncounted = await UPDATE(Stock)
    .with({ quantity: null, modifiedAt: { ref: ['modifiedAt'] }, modifiedBy: { ref: ['modifiedBy'] } })
    .where({ countedAt: null, quantity: 0 })
  if (uncounted) console.log(`[reliefgrid] - ${uncounted} never-counted stock lines marked as not counted`)

  const { ensureStock } = require('./srv/lib/supply')
  for (const { ID } of await SELECT.from(Camps).columns('ID')) await ensureStock(ID)
  return figuresBefore !== '' && figuresBefore !== await referenceFigures()
}

module.exports = cds.server
