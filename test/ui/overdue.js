/**
 * Browser test for overdue applicability reviews.
 *
 * Starts an isolated server on an in-memory database with a test-only clock
 * (test/ui/helpers/clock.js, loaded with --require; no application code is
 * involved). Synthetic decisions are created today with real dates, then the
 * server's clock is moved 5 days forward. Checks that overdue reviews are
 * shown, and that nothing changes by itself: no decision status, assessment,
 * request or assessment history.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const puppeteer = require('puppeteer-core')
const { USERS } = require('../helpers/test-users')

const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.OVERDUE_PORT || 4197
const BASE = `http://localhost:${PORT}`
const R = '/odata/v4/relief'
const SHOTS = process.env.SCREENSHOT_DIR
const CHROME = process.env.CHROME_PATH || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}[process.platform]
const DAY = 864e5
const ADVANCE = 5

const failures = []
const check = (ok, message) => { console.log(`${ok ? '  ✔' : '  ✖'} ${message}`); if (!ok) failures.push(message) }
const date = days => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
const wait = ms => new Promise(r => setTimeout(r, ms))

async function api(method, url, body, user = 'admin', extra = {}) {
  const res = await fetch(BASE + url, {
    method, body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${user}:test`).toString('base64'), ...extra }
  })
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

;(async () => {
  const clockFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-clock-')), 'offset')
  fs.writeFileSync(clockFile, '0')
  const server = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers', 'clock.js'), require.resolve('@sap/cds/bin/serve.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT, CDS_ENV: 'development', RELIEFGRID_TEST_CLOCK_FILE: clockFile,
      CDS_CONFIG: JSON.stringify({ requires: { db: { kind: 'sqlite', credentials: { url: ':memory:' } }, auth: { kind: 'mocked', users: USERS } } }) },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => String(d).includes('server listening') && resolve())
    server.on('exit', code => reject(new Error(`server exited with ${code}`)))
  })
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  try {
    // ---- Synthetic fixtures, today (real dates) ----
    const camp = async (name, counts) => {
      const d = await api('POST', `${R}/Camps`, {})
      const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
      await api('PATCH', key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount: 300 })
      await api('POST', `${key}/ReliefService.draftActivate`, {})
      const lines = (await api('GET', `${R}/Camps(ID=${d.ID},IsActiveEntity=true)/stock`)).value
      for (const [code, q] of Object.entries(counts))
        await api('POST', `${R}/Stock(${lines.find(l => l.standard_code === code).ID})/ReliefService.recordCount`, { quantity: q, ...(['TOILET', 'TAP'].includes(code) ? { functionalUnits: q } : {}) })
      return d.ID
    }
    const approve = async ID => {
      const d = await api('GET', `${R}/CampDecisions(${ID})`)
      return api('POST', `${R}/CampDecisions(${ID})/ReliefService.approve`, { version: d.version }, 'admin', { 'if-match': d['@odata.etag'] })
    }
    const decide = async (campID, standard, applicable, reviewIn) => {
      const d = await api('POST', `${R}/Camps(ID=${campID},IsActiveEntity=true)/ReliefService.proposeApplicability`, {
        standard, applicability: applicable ? 'APPLICABLE' : 'NOT_APPLICABLE', reason: `Overdue test ${standard}`,
        source: applicable ? '' : 'Test reference', reviewDate: date(reviewIn)
      }, 'coordinator')
      await approve(d.ID)
      return d.ID
    }
    const alpha = await camp('Overdue Camp Alpha', { WATER: 0, SOAP: 100 })
    const bravo = await camp('Overdue Camp Bravo', { WATER: 1000, SOAP: 100 })
    const charlie = await camp('Overdue Camp Charlie', { WATER: 1000, SOAP: 100 })
    await api('POST', `${R}/Camps(ID=${alpha},IsActiveEntity=true)/ReliefService.raiseRequests`, {})

    const ids = {}
    ids.future = await decide(alpha, 'NET', true, 30)            // 1. review date in the future
    ids.over1 = await decide(alpha, 'WATER', false, 2)           // 3. overdue (flags Alpha's water request)
    ids.over2 = await decide(bravo, 'NET', false, 3)             // 4. a second overdue decision
    ids.today = await decide(bravo, 'SOAP', false, ADVANCE)      // 2. review date equal to the (moved) date
    ids.superseded = await decide(charlie, 'NET', true, 2)       // 5. superseded before its review date passes
    ids.successor = await decide(charlie, 'NET', false, 60)
    ids.withdrawn = await decide(charlie, 'SOAP', false, 2)      // 6. withdrawn
    const w = await api('POST', `${R}/Camps(ID=${charlie},IsActiveEntity=true)/ReliefService.proposeWithdrawal`, { standard: 'SOAP', reason: 'Overdue test withdrawal' }, 'coordinator')
    await approve(w.ID)

    const state = async () => ({
      stock: (await api('GET', `${R}/Stock?$select=ID,assessment,severity,required&$orderby=ID`)).value.map(s => [s.ID, s.assessment, s.severity, s.required]),
      requests: (await api('GET', `${R}/Requests?$select=ID,status_code,review_code,quantity&$orderby=ID`)).value.map(r => [r.ID, r.status_code, r.review_code, r.quantity]),
      decisions: (await api('GET', `${R}/CampDecisions?$select=ID,status_code,version,inForceFrom,endedAt&$orderby=ID`)).value.map(d => [d.ID, d.status_code, d.version, d.inForceFrom, d.endedAt]),
      records: (await api('GET', `${R}/AssessmentRecords?$count=true&$top=0`))['@odata.count'],
      reviews: (await api('GET', `${R}/RequestReviews?$count=true&$top=0`))['@odata.count']
    })
    const before = await state()
    const view = async ID => api('GET', `${R}/CampDecisions(${ID})`)
    check((await view(ids.over1)).reviewOverdue === false && (await api('GET', `${R}/overview()`)).overdueReviews === 0, 'today: nothing is overdue yet')

    // ---- Move the server's clock forward (test clock only) ----
    fs.writeFileSync(clockFile, String(ADVANCE * DAY))
    server.kill('SIGUSR2')
    let moved = false
    for (let i = 0; i < 50 && !moved; i++) { await wait(100); moved = (await view(ids.over1)).reviewOverdue === true }
    check(moved, `server clock moved ${ADVANCE} days forward (test clock)`)
    const today = date(ADVANCE)

    // ---- API ----
    const v = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, ID]) => [k, await view(ID)])))
    check(v.future.reviewOverdue === false && v.future.displayStatus === 'In force', '1. future review date: In force, not overdue')
    check(v.today.reviewDate === today && v.today.reviewOverdue === false && v.today.status_code === 'APPROVED' && v.today.displayStatus === 'In force, review due today',
      '2. review date equal to today: due today, not overdue, still in force')
    check(v.over1.reviewOverdue && v.over1.status_code === 'APPROVED' && v.over1.displayStatus === 'In force, review overdue', '3. overdue: still in force, shown as review overdue')
    check(v.over2.reviewOverdue && v.over2.displayStatus === 'In force, review overdue', '4. a second overdue decision is reported too')
    check(v.superseded.status_code === 'SUPERSEDED' && !v.superseded.reviewOverdue && v.superseded.displayStatus === 'Superseded', '5. superseded decision: history, never overdue')
    check(v.withdrawn.status_code === 'WITHDRAWN' && !v.withdrawn.reviewOverdue && v.withdrawn.displayStatus === 'Withdrawn', '6. withdrawn decision: history, never overdue')
    const overview = await api('GET', `${R}/overview()`)
    const attention = (await api('GET', `${R}/attention()`)).value.filter(i => i.kind === 'REVIEW_OVERDUE').map(i => i.decisionID).sort()
    check(overview.overdueReviews === 2 && JSON.stringify(attention) === JSON.stringify([ids.over1, ids.over2].sort()),
      `overview counts 2 overdue reviews and attention lists exactly those two (${overview.overdueReviews}, ${attention.length})`)
    const after = await state()
    check(JSON.stringify(after.decisions) === JSON.stringify(before.decisions), '7. no decision changed status or version (none withdrawn or expired automatically)')
    check(JSON.stringify(after.stock) === JSON.stringify(before.stock), 'no assessment was reclassified')
    check(JSON.stringify(after.requests) === JSON.stringify(before.requests) && after.reviews === before.reviews, 'no request was cancelled or changed, and no review was added')
    check(after.records === before.records, `no assessment record was written (${after.records})`)

    // ---- Browser ----
    const ctx = await browser.createBrowserContext()
    const opened = []
    const open = async (url, needles) => {
      const page = await ctx.newPage()
      await page.authenticate({ username: 'coordinator', password: 'test' })
      await page.setViewport({ width: 1440, height: 900 })
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      page.on('console', m => { if (m.type() === 'error' && !/favicon|Component-preload|Failed to load resource|ResizeObserver|is deprecated|S\/CUBE|Merging of arrays|getDistinctSemanticObjects/.test(m.text())) errors.push(m.text()) })
      opened.push({ url, errors })
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded' })
      const ok = await page.waitForFunction(n => n.every(x => document.body.innerText.includes(x)), { timeout: 60000, polling: 500 }, needles).then(() => true, () => false)
      await wait(1000)
      return { page, ok, errors, text: () => page.evaluate(() => document.body.innerText) }
    }
    const cc = await open('/command/webapp/index.html', ['Needs Decision'])
    await cc.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('attention'))
    const listed = await cc.page.waitForFunction(() => document.querySelector('[id$="--attention"]')?.innerText.includes('Decision review overdue since'), { timeout: 20000 }).then(() => true, () => false)
    const rows = await cc.page.evaluate(() => [...document.querySelectorAll('[id$="--attention"] .sapMListTblRow')].map(r => r.innerText.replace(/\s+/g, ' ')))
    const overdueRows = rows.filter(r => r.includes('Decision review overdue since'))
    check(listed && overdueRows.length === 2 && overdueRows.some(r => r.includes('Overdue Camp Alpha')) && overdueRows.some(r => r.includes('Overdue Camp Bravo')) &&
      !overdueRows.some(r => r.includes('Overdue Camp Charlie')),
      `Command Center Needs Decision lists the two overdue reviews and not the superseded, withdrawn, future or due-today ones (${overdueRows.length})`)
    const heat = await cc.page.evaluate(() => {
      const camps = sap.ui.core.Element.getElementById('container-reliefgrid.command---main').getModel('view').getProperty('/camps')
      const c = camps.find(r => r.name === 'Overdue Camp Alpha'); return { water: c.cells.WATER.text, net: c.cells.NET.text }
    })
    check(heat.water === 'Not applicable' && heat.net === 'No requirement', `Command Center heatmap still shows the decisions in force (water ${heat.water}, nets ${heat.net})`)
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await cc.page.screenshot({ path: path.join(SHOTS, 'overdue-needs-decision.png') }) }
    const row = await cc.page.evaluateHandle(() => [...document.querySelectorAll('[id$="--attention"] .sapMListTblRow')]
      .find(r => r.innerText.includes('Decision review overdue since') && r.innerText.includes('Overdue Camp Alpha')))
    await row.click()
    const navigated = await cc.page.waitForFunction(id => location.href.includes(`/decisions(${id})`), { timeout: 20000 }, ids.over1).then(() => true, () => false)
    await cc.page.waitForFunction(() => window.sap?.ui?.require, { timeout: 20000 }).catch(() => {})
    const reviewText = await cc.page.evaluate(d => new Promise(resolve => sap.ui.require(['sap/ui/core/format/DateFormat'],
      DateFormat => resolve(DateFormat.getDateInstance({ style: 'medium' }).format(new Date(d + 'T00:00:00'))))), v.over1.reviewDate)
    const shown = navigated && await cc.page.waitForFunction(t => document.body.innerText.includes('In force, review overdue') && document.body.innerText.includes(t),
      { timeout: 30000, polling: 500 }, reviewText).then(() => true, () => false)
    check(shown, `Needs Decision opens the overdue decision, showing "In force, review overdue" and its review date (${reviewText})`)
    if (SHOTS) await cc.page.screenshot({ path: path.join(SHOTS, 'overdue-decision.png') })
    check(cc.errors.length === 0, `Command Center and decision page have no page errors${cc.errors.length ? ': ' + cc.errors[0] : ''}`)
    await cc.page.close()

    const route = (campID, ID) => `/camps/webapp/index.html#/Camps(ID=${campID},IsActiveEntity=true)/decisions(${ID})`
    for (const [key, campID, expect, label] of [
      ['today', bravo, 'In force, review due today', 'review date equal to today'],
      ['future', alpha, 'In force', 'future review date'],
      ['superseded', charlie, 'Superseded', 'superseded'],
      ['withdrawn', charlie, 'Withdrawn', 'withdrawn']
    ]) {
      const p = await open(route(campID, ids[key]), [expect, 'Review Date'])
      const text = await p.text()
      check(p.ok && !text.includes('review overdue') && !/expired/i.test(text), `Decision page (${label}): "${expect}", not overdue, never "expired"`)
      await p.page.close()
    }
    const over2 = await open(route(bravo, ids.over2), ['In force, review overdue'])
    check(over2.ok && !/expired/i.test(await over2.text()), 'Decision page (second overdue): "In force, review overdue": an overdue review, not an expired decision')
    await over2.page.close()
    const camps = await open(`/camps/webapp/index.html#/Camps(ID=${alpha},IsActiveEntity=true)`, ['Applicability Decisions', 'In force, review overdue'])
    check(camps.ok, 'Manage Camps camp page lists the overdue decision in its Applicability Decisions section')
    await camps.page.close()

    const noisy = opened.filter(p => p.errors.length)
    check(noisy.length === 0, `no console or page errors on any of the ${opened.length} pages opened${noisy.length ? ': ' + noisy[0].url + ' ' + noisy[0].errors[0].slice(0, 200) : ''}`)
  } finally {
    await browser.close()
    server.kill()
    fs.rmSync(path.dirname(clockFile), { recursive: true, force: true })
  }
  if (failures.length) { console.error(`\n${failures.length} overdue check(s) failed`); process.exit(1) }
  console.log('\nAll overdue checks passed')
})().catch(e => { console.error(e); process.exit(1) })
