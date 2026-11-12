/**
 * Browser test for local targets (B4.2), with real test identities.
 *
 * Starts an isolated server on an in-memory database with the test-only clock
 * (test/ui/helpers/clock.js, loaded with --require; no application code is
 * involved), creates synthetic camps through the public API and drives
 * Manage Camps, the Command Center, the methodology page and the Pledge Board.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const puppeteer = require('puppeteer-core')
const { USERS } = require('../helpers/test-users')

const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.TARGETS_PORT || 4196
const BASE = `http://localhost:${PORT}`
const R = '/odata/v4/relief'
const SHOTS = process.env.SCREENSHOT_DIR
const CHROME = process.env.CHROME_PATH || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}[process.platform]
const DAY = 864e5
const ADVANCE = 100

const failures = []
const check = (ok, message) => { console.log(`${ok ? '  ✔' : '  ✖'} ${message}`); if (!ok) failures.push(message) }
const date = days => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
const wait = ms => new Promise(r => setTimeout(r, ms))

async function api(method, url, body, user = 'admin', extra = {}) {
  const res = await fetch(BASE + url, {
    method, body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${user}:test`).toString('base64'), ...extra }
  })
  const text = await res.text()
  if (!res.ok) { const e = new Error(`${method} ${url}: ${res.status} ${text}`); e.status = res.status; throw e }
  return text ? JSON.parse(text) : null
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
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--lang=en-US'] })
  const contexts = new Map()
  const opened = []
  const open = async (url, needles, { user = 'admin', width = 1440, height = 900, deniedByDesign = false, password = 'test' } = {}) => {
    // one browser session per login: a session remembers credentials that worked
    const session = `${user}:${password}`
    if (!contexts.has(session)) contexts.set(session, await browser.createBrowserContext())
    const page = await contexts.get(session).newPage()
    await page.authenticate({ username: user, password })
    await page.setViewport({ width, height })
    const errors = []
    if (!deniedByDesign) opened.push({ url, user, errors })
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error' && !/favicon|Component-preload|Failed to load resource|ResizeObserver|is deprecated|S\/CUBE|Merging of arrays|getDistinctSemanticObjects/.test(m.text())) errors.push(m.text()) })
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' })
    const ok = await page.waitForFunction(n => n.every(x => document.body.innerText.includes(x)), { timeout: 60000, polling: 500 }, needles).then(() => true, () => false)
    await wait(1200)
    return { page, ok, errors, text: () => page.evaluate(() => document.body.innerText) }
  }
  const clickButton = async (page, scope, label) => {
    const find = async () => {
      for (const h of await page.$$(`${scope} button`))
        if (await h.evaluate((b, l) => b.innerText.trim() === l && b.offsetParent !== null, label)) return h
    }
    let h = await find()
    if (!h && scope === 'body') {
      // the object page header moves actions that do not fit into "Additional Options"
      const more = await page.$('button[aria-label="Additional Options"]')
      if (more) { await more.click(); await wait(600); h = await find() }
    }
    if (!h) throw new Error(`button "${label}" not found`)
    return h.click()
  }
  const buttonState = (page, label) => page.evaluate(l => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === l && x.offsetParent !== null)
    return b ? (b.disabled || b.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled') : 'absent'
  }, label)
  const typeInto = async (page, id, text) => {
    await page.click(`[id="${id}"] input, [id="${id}"] textarea`)
    await page.keyboard.type(text)
    await page.keyboard.press('Tab')
    await wait(400)
  }
  const feedbackText = page => page.evaluate(() =>
    [...document.querySelectorAll('.sapMMessageToast, .sapMDialog, .sapMMessageStrip')].map(d => d.innerText.replace(/\s+/g, ' ')).join(' || '))
  const waitForFeedback = async (page, pattern) => {
    for (let i = 0; i < 48; i++) {
      const match = (await feedbackText(page)).split(' || ').find(t => pattern.test(t))
      if (match) return match
      await wait(250)
    }
    return feedbackText(page)
  }
  const uiDate = (page, ms) => page.evaluate(t => new Promise(resolve => sap.ui.require(['sap/ui/core/format/DateFormat'],
    DateFormat => resolve(DateFormat.getDateInstance({ style: 'medium' }).format(new Date(t))))), ms)
  const closeDialogs = async page => {
    for (const label of ['Close', 'Cancel']) {
      const buttons = await page.$$('.sapMDialog button')
      for (const b of buttons) if ((await b.evaluate(x => x.innerText.trim())) === label) { await b.click(); await wait(400) }
    }
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) } }
  const decisionsOf = async (campID, filter = '') => (await api('GET', `${R}/CampDecisions?$filter=camp_ID eq ${campID} and kind eq 'TARGET'${filter}&$orderby=createdAt desc`)).value
  const approveAs = async (ID, user) => {
    const d = await api('GET', `${R}/CampDecisions(${ID})`)
    return api('POST', `${R}/CampDecisions(${ID})/ReliefService.approve`, { version: d.version }, user, { 'if-match': d['@odata.etag'] })
  }
  const water = async campID => (await api('GET', `${R}/Stock?$filter=camp_ID eq ${campID} and standard_code eq 'WATER'`)).value[0]

  try {
    // ---- Synthetic fixtures (in-memory database) ----
    const camp = async (name, counts) => {
      const d = await api('POST', `${R}/Camps`, {})
      const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
      await api('PATCH', key, { name, district: 'District T', region: 'Region T', hazard_code: 'FLOOD', headcount: 200 })
      await api('POST', `${key}/ReliefService.draftActivate`, {})
      const lines = (await api('GET', `${R}/Camps(ID=${d.ID},IsActiveEntity=true)/stock`)).value
      for (const [code, q] of Object.entries(counts))
        await api('POST', `${R}/Stock(${lines.find(l => l.standard_code === code).ID})/ReliefService.recordCount`, { quantity: q, ...(['TOILET', 'TAP'].includes(code) ? { functionalUnits: q } : {}) })
      return d.ID
    }
    const alpha = await camp('Target UI Alpha', { WATER: 7000, SOAP: 5000 })
    const bravo = await camp('Target UI Bravo', { WATER: 7000, SOAP: 5000 })
    const campRoute = id => `/camps/webapp/index.html#/Camps(ID=${id},IsActiveEntity=true)`
    const decisionRoute = (campID, ID) => `${campRoute(campID)}/decisions(${ID})`

    // ---- Coordinator proposes through the Fiori dialog ----
    const proposeThroughDialog = async (page, { value, reviewIn }) => {
      await clickButton(page, 'body', 'Propose Local Target')
      await page.waitForSelector('[id="APD_::targetPerPerson"]', { visible: true, timeout: 10000 })
      await wait(800)
      await typeInto(page, 'APD_::standard', 'Water')
      await typeInto(page, 'APD_::targetPerPerson', value)
      await typeInto(page, 'APD_::reason', 'Hot season, no other water source nearby')
      await typeInto(page, 'APD_::source', 'WASH cluster assessment 3 Nov 2026')
      if (reviewIn !== null) await typeInto(page, 'APD_::reviewDate', await uiDate(page, Date.now() + reviewIn * DAY))
      await clickButton(page, '.sapMDialog', 'Propose Local Target')
    }

    const p1 = await open(campRoute(alpha), ['Applicability Decisions and Local Targets', 'Reference figure'], { user: 'coordinator' })
    check(p1.ok, 'Manage Camps: the camp page shows the requirement basis of every line and the decisions section')
    const stockHeaders = await p1.page.evaluate(() => document.body.innerText)
    check(/Per Person in Use/.test(stockHeaders), 'Manage Camps: the stock table shows the requirement per person in use')
    await proposeThroughDialog(p1.page, { value: '0', reviewIn: 90 })
    const invalid = await waitForFeedback(p1.page, /must be a positive number/)
    opened[opened.length - 1].refusedOnPurpose = true
    check(/must be a positive number/.test(invalid) && (await decisionsOf(alpha)).length === 0,
      'Manage Camps: an invalid local target (0) is refused with an explanation, and nothing is saved')
    await p1.page.close()

    const p2 = await open(campRoute(alpha), ['Applicability Decisions and Local Targets', 'Reference figure'], { user: 'coordinator' })
    await proposeThroughDialog(p2.page, { value: '25', reviewIn: null })
    await wait(1500)
    const missing = await p2.page.evaluate(() => ({
      open: [...document.querySelectorAll('.sapMDialog')].some(d => d.offsetParent !== null && d.querySelector('[id="APD_::reviewDate"]')),
      text: [...document.querySelectorAll('.sapMDialog, .sapMMessageToast, .sapMPopover')].map(d => d.innerText.replace(/\s+/g, ' ')).join(' || ')
    }))
    check((missing.open || /review date/i.test(missing.text)) && (await decisionsOf(alpha)).length === 0,
      `Manage Camps: without a review date nothing is saved, and the user is told (${missing.open ? 'dialog stays open' : missing.text.slice(0, 120)})`)
    await closeDialogs(p2.page)
    await p2.page.close()

    const p3 = await open(campRoute(alpha), ['Applicability Decisions and Local Targets', 'Reference figure'], { user: 'coordinator' })
    await proposeThroughDialog(p3.page, { value: '25', reviewIn: 90 })
    const submitted = await waitForFeedback(p3.page, /local target proposal was submitted/)
    const [pending] = await decisionsOf(alpha, " and status_code eq 'PENDING'")
    check(/reference figure does not change/.test(submitted) && pending?.proposedBy === 'coordinator' && Number(pending.targetPerPerson) === 25,
      'Manage Camps: a coordinator submits a local target and is told it needs another person\'s approval')
    await shot(p3.page, 'target-proposed')
    await p3.page.close()

    // ---- The coordinator cannot approve; another Administrator approves on the decision page ----
    const coordView = await open(decisionRoute(alpha, pending.ID), ['Pending approval', 'Local target', '25 litres per person per day', 'Reference figure 15 litres per person per day'], { user: 'coordinator' })
    check(coordView.ok, 'Decision page: shows the local target, the reference figure it replaces, source and review date')
    check(await buttonState(coordView.page, 'Approve') !== 'enabled', 'Decision page: a coordinator cannot approve')
    await coordView.page.close()

    const adminView = await open(decisionRoute(alpha, pending.ID), ['Pending approval', '25 litres per person per day'])
    check(await buttonState(adminView.page, 'Approve') === 'enabled', 'Decision page: another Administrator can approve')
    await clickButton(adminView.page, 'body', 'Approve')
    await adminView.page.waitForSelector('.sapMDialog', { visible: true, timeout: 10000 })
    await wait(600)
    const labels = await adminView.page.evaluate(() => [...document.querySelectorAll('.sapMDialog button')].map(b => b.innerText.trim()).filter(Boolean))
    await clickButton(adminView.page, '.sapMDialog', labels.find(l => l !== 'Cancel'))
    const approved = await waitForFeedback(adminView.page, /in force for this camp only/)
    const w1 = await water(alpha)
    check(/in force for this camp only/.test(approved) && Number(w1.perPerson) === 25 && w1.assessment === 'CRITICAL',
      `Decision page: approval puts the local target in force at once and re-assesses the camp (${w1.perPerson}, ${w1.assessment})`)
    await adminView.page.close()
    check(Number((await water(bravo)).perPerson) === 15, 'Another camp keeps the reference figure')

    const campPage = await open(campRoute(alpha), ['Local target', 'Per Person in Use'], { user: 'coordinator' })
    const stockRow = await campPage.page.evaluate(() => [...document.querySelectorAll('.sapMListTblRow')].map(r => r.innerText.replace(/\s+/g, ' ')).find(t => /Water/.test(t) && /Local target/.test(t)))
    check(!!stockRow && /25/.test(stockRow), `Manage Camps: the water line shows the local target in use (${(stockRow || '').slice(0, 120)})`)
    await shot(campPage.page, 'target-camp-page')
    await campPage.page.close()

    // ---- Self-approval is refused, with the reason ----
    const own = await api('POST', `${R}/Camps(ID=${bravo},IsActiveEntity=true)/ReliefService.proposeTarget`,
      { standard: 'SOAP', targetPerPerson: 10, reason: 'Hygiene campaign', source: 'Health cluster note', reviewDate: date(60) }, 'admin')
    const ownView = await open(decisionRoute(bravo, own.ID), ['You proposed this decision, so another Administrator must approve it.'])
    check(ownView.ok && await buttonState(ownView.page, 'Approve') !== 'enabled', 'Decision page: an Administrator cannot approve their own local target, and is told why')
    await ownView.page.close()

    // ---- A scheduled local target ----
    const later = await api('POST', `${R}/Camps(ID=${alpha},IsActiveEntity=true)/ReliefService.proposeTarget`,
      { standard: 'SOAP', targetPerPerson: 12, reason: 'Cholera preparedness', source: 'Health cluster note', effectiveFrom: date(3), reviewDate: date(60) }, 'coordinator')
    await approveAs(later.ID, 'admin2')
    const schedView = await open(decisionRoute(alpha, later.ID), ['Scheduled from', '12 grams per person per day'], { user: 'coordinator' })
    const soapNow = (await api('GET', `${R}/Stock?$filter=camp_ID eq ${alpha} and standard_code eq 'SOAP'`)).value[0]
    check(schedView.ok && soapNow.targetBasis === 'REFERENCE_FIGURE', 'Decision page: a scheduled local target shows its date and does not count before it')
    await schedView.page.close()

    // ---- Command Center ----
    const cc = await open('/command/webapp/index.html', ['Local Targets', 'Target UI Alpha'], { user: 'coordinator' })
    const sub = await cc.page.evaluate(() => document.body.innerText)
    check(/1 local targets in force in 1 camps/.test(sub), 'Command Center: the subtitle counts the local targets in force')
    const cell = await cc.page.evaluate(() => {
      const rows = sap.ui.core.Element.getElementById('container-reliefgrid.command---main').getModel('view').getProperty('/camps')
      return rows.find(r => r.name === 'Target UI Alpha').cells.WATER
    })
    check(cell.localTarget === true && /local target 25 per person \(reference 15\)/.test(cell.tooltip) && cell.state === 'Error',
      'Command Center heatmap: the water cell is marked as calculated with a local target, with its usual colour')
    await cc.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('targets'))
    await cc.page.waitForFunction(() => document.querySelector('[id$="--targets"]')?.innerText.includes('Target UI Alpha'), { timeout: 20000 }).catch(() => {})
    const rows = await cc.page.evaluate(() => [...document.querySelectorAll('[id$="--targets"] .sapMListTblRow')].map(r => r.innerText.replace(/\s+/g, ' ')))
    check(rows.some(r => /Target UI Alpha/.test(r) && /25 litres per person per day/.test(r) && /15 litres/.test(r) && /In force/.test(r)) &&
      rows.some(r => /Target UI Alpha/.test(r) && /Scheduled from/.test(r)) && rows.some(r => /Target UI Bravo/.test(r) && /Pending approval/.test(r)),
      `Command Center Local Targets: in force, scheduled and pending local targets, each with its figure and the reference (${rows.length} rows)`)
    await shot(cc.page, 'target-command-center')
    check(cc.errors.length === 0, `Command Center has no page errors${cc.errors.length ? ': ' + cc.errors[0] : ''}`)
    await cc.page.close()

    // ---- The review falls due: the server's clock moves forward (test clock only) ----
    fs.writeFileSync(clockFile, String(ADVANCE * DAY))
    server.kill('SIGUSR2')
    let moved = false
    for (let i = 0; i < 50 && !moved; i++) { await wait(100); moved = (await api('GET', `${R}/CampDecisions(${pending.ID})`)).reviewState === 'OVERDUE' }
    check(moved, `server clock moved ${ADVANCE} days forward: the local target review is overdue`)
    const before = await water(alpha)
    const cc2 = await open('/command/webapp/index.html', ['Needs Decision'], { user: 'admin' })
    await cc2.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('attention'))
    const listed = await cc2.page.waitForFunction(() => document.querySelector('[id$="--attention"]')?.innerText.includes('Local target review overdue since'), { timeout: 20000 }).then(() => true, () => false)
    check(listed, 'Command Center Needs Decision: "Local target review overdue since …"')
    await cc2.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('targets'))
    await wait(800)
    const overdueRow = await cc2.page.evaluateHandle(() => [...document.querySelectorAll('[id$="--targets"] .sapMListTblRow')].find(r => r.innerText.includes('In force, review overdue')))
    check(!!(await overdueRow.evaluate(r => !!r)), 'Command Center Local Targets: the overdue local target is shown as "In force, review overdue"')
    await overdueRow.click()
    const navigated = await cc2.page.waitForFunction(id => location.href.includes(`/decisions(${id})`), { timeout: 20000 }, pending.ID).then(() => true, () => false)
    const onPage = navigated && await cc2.page.waitForFunction(() => document.body.innerText.includes('In force, review overdue') && document.body.innerText.includes('Review overdue since'),
      { timeout: 30000, polling: 500 }).then(() => true, () => false)
    check(onPage, 'Local Targets opens the decision page, which says the review is overdue and the target is still in force')
    const after = await water(alpha)
    check(after.perPerson === before.perPerson && after.assessment === before.assessment && (await api('GET', `${R}/CampDecisions(${pending.ID})`)).status_code === 'APPROVED',
      'An overdue review changes nothing by itself: same local target, same classification, still in force')

    // ---- An Administrator records the review ----
    check(await buttonState(cc2.page, 'Record Review') === 'enabled', 'Decision page: an Administrator can record the review')
    await clickButton(cc2.page, 'body', 'Record Review')
    await cc2.page.waitForSelector('[id="APD_::explanation"]', { visible: true, timeout: 10000 })
    await wait(800)
    await typeInto(cc2.page, 'APD_::outcome', 'Confirmed')
    await typeInto(cc2.page, 'APD_::explanation', 'Hot season continues, cluster confirms the figure')
    await typeInto(cc2.page, 'APD_::nextReviewDate', await uiDate(cc2.page, Date.now() + (ADVANCE + 30) * DAY))
    await clickButton(cc2.page, '.sapMDialog', 'Record Review')
    const reviewed = await waitForFeedback(cc2.page, /Review recorded/)
    const v = await api('GET', `${R}/CampDecisions(${pending.ID})`)
    console.log('    review feedback:', reviewed.slice(0, 300))
    check(/stays in force unchanged/.test(reviewed) && v.reviewState === 'COMPLETED' && v.reviewDue === date(ADVANCE + 30) && Number(v.targetPerPerson) === 25,
      `Decision page: the review is recorded, the target stays as it is, the next review is set (${v.reviewState}, ${v.reviewDue})`)
    // the user dismisses the confirmation, as anyone would, and then reads the page
    await clickButton(cc2.page, '.sapMDialog', 'OK')
    const shown = await cc2.page.waitForFunction(() => /confirmed, next review/.test(document.body.innerText), { timeout: 20000 }).then(() => true, () => false)
    const reviewField = shown ? '' : await cc2.page.evaluate(() => (document.body.innerText.match(/Review Status[^\n]*\n+[^\n]*/) || ['(no Review Status field in the page text)'])[0].replace(/\s+/g, ' '))
    check(shown, `Decision page: shows who reviewed it, the outcome and the next review date${shown ? '' : ' -- page shows: ' + reviewField}`)
    await shot(cc2.page, 'target-reviewed')
    await cc2.page.close()
    const coordReview = await open(decisionRoute(alpha, pending.ID), ['In force'], { user: 'coordinator' })
    check(await buttonState(coordReview.page, 'Record Review') !== 'enabled', 'Decision page: a coordinator cannot record a review')
    await coordReview.page.close()

    // ---- Methodology ----
    const method = await open('/methodology/webapp/index.html', ['Local targets', 'A local target replaces the reference figure for one indicator in one camp only'], { user: 'coordinator' })
    const mtext = await method.text()
    check(method.ok && /An Administrator who did not propose it approves it/.test(mtext) && /never changes an earlier assessment/.test(mtext) &&
      /the local target stays in force/.test(mtext), 'Methodology: explains local targets, approval, effect on assessments, history and overdue reviews')
    await method.page.close()

    // ---- Donors ----
    const board = await open('/pledge/webapp/index.html', ['Pledge'], { user: 'donor' })
    check(board.ok && !/Local target|Reference figure|targetPerPerson/.test(await board.text()), 'Pledge Board: donors see requests, never local target management')
    await board.page.close()
    let refused = 0
    for (const url of [`${R}/localTargets()`, `${R}/CampDecisions`, `${R}/DecisionReviews`]) { try { await api('GET', url, null, 'donor') } catch (e) { if (e.status === 403) refused++ } }
    check(refused === 3, 'Donors are refused local targets, decisions and reviews (403)')

    // ---- Assessment history ----
    const historyPage = await open(campRoute(alpha), ['Assessment History'], { user: 'coordinator' })
    // lower sections load when they come into view: the user opens the section through its tab
    await historyPage.page.click('[id$="FacetSection::AssessmentHistory-anchor"]')
    const historyListed = await historyPage.page.waitForFunction(() => [...document.querySelectorAll('.sapMListTblRow')].some(r => r.innerText.includes('Decision took effect')), { timeout: 30000, polling: 500 }).then(() => true, () => false)
    check(historyListed, 'Manage Camps: the camp page shows the assessment history, in plain words')
    const historyRow = await historyPage.page.evaluateHandle(() => [...document.querySelectorAll('.sapMListTblRow')].find(r => r.innerText.includes('Decision took effect')) || document.body)
    await historyRow.click()
    const onRecord = await historyPage.page.waitForFunction(() => location.href.includes('/assessmentRecords(') && document.body.innerText.includes('Indicators as Assessed'), { timeout: 30000, polling: 500 }).then(() => true, () => false)
    // a narrow screen moves some columns into the row's sub-row; both are read as one line
    const recordRows = () => historyPage.page.evaluate(() => [...document.querySelectorAll('[id*="RecordDetail"] .sapMListTblRow')].map(r => [...r.children, ...(r.nextElementSibling?.classList.contains('sapMListTblSubRow') ? [r.nextElementSibling] : [])].map(c => c.innerText.trim()).filter(Boolean).join(' | ')))
    // wait for the figures as well as the label: on a slower machine the row's numbers render a moment later
    await historyPage.page.waitForFunction(() => [...document.querySelectorAll('[id*="RecordDetail"] .sapMListTblRow')].some(r => {
      const t = r.innerText + ' ' + (r.nextElementSibling?.classList.contains('sapMListTblSubRow') ? r.nextElementSibling.innerText : '')
      return /Water/.test(t) && /Local target/.test(t) && /25/.test(t) && /15/.test(t)
    }), { timeout: 30000, polling: 500 }).catch(() => {})
    const rendered = await recordRows()
    const recordRow = rendered.find(t => /Water/.test(t) && /Local target/.test(t))
    check(onRecord && !!recordRow && /25/.test(recordRow) && /15/.test(recordRow),
      `Assessment record: opens from the list and shows the local target used and the reference figure (${(recordRow || `on record page: ${onRecord}, ${rendered.length} rows: ${rendered.slice(0, 2).join(' // ')}`).slice(0, 220)})`)
    check(await buttonState(historyPage.page, 'Edit') === 'absent' && await buttonState(historyPage.page, 'Delete') === 'absent', 'Assessment record: no way to edit or delete it')
    await shot(historyPage.page, 'assessment-record')
    await historyPage.page.close()

    // ---- Launchpad: only the apps this user can open ----
    // SEC-06: the Pledge Board is for donors (Donor role); a coordinator gets the planning applications
    const TILES = ['Relief Command Center', 'Manage Relief Camps', 'Methodology and References']
    const coordPad = await open('/index.html', TILES, { user: 'coordinator' })
    check(coordPad.ok && !(await coordPad.text()).includes('Pledge Board'), 'Launchpad: a coordinator sees the planning applications, not the Pledge Board')
    await coordPad.page.close()
    const donorPad = await open('/index.html', ['Pledge Board', 'Methodology and References'], { user: 'donor' })
    const donorText = await donorPad.text()
    check(donorPad.ok && !donorText.includes('Manage Relief Camps') && !donorText.includes('Relief Command Center'), 'Launchpad: a donor sees only the applications a donor can open')
    await donorPad.page.close()
    const donorPledge = await open('/index.html#SupplyRequest-pledge', ['Open Needs'], { user: 'donor' })
    check(donorPledge.ok, 'Launchpad: the Pledge Board tile opens for a donor')
    await donorPledge.page.close()
    const donorMethod = await open('/index.html#ReliefMethodology-display', ['Local targets'], { user: 'donor' })
    check(donorMethod.ok, 'Launchpad: the methodology opens for a donor (the planning figures behind it need a coordinator)')
    await donorMethod.page.close()
    const failed = await open('/index.html', ['could not confirm who you are', 'Sign in again'], { user: 'donor', password: 'wrong', deniedByDesign: true })
    check(failed.ok, 'Launchpad: a failed sign-in explains itself instead of opening applications that cannot load')
    await failed.page.close()

    // ---- Phone width ----
    const phone = await open(decisionRoute(alpha, pending.ID), ['In force', '25 litres per person per day'], { user: 'coordinator', width: 390, height: 844 })
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    check(phone.ok && !overflow, 'Decision page at phone width renders without horizontal scrolling')
    await shot(phone.page, 'target-phone')
    await phone.page.close()
    const tablet = await open(campRoute(alpha), ['Local target'], { user: 'coordinator', width: 820, height: 1180 })
    check(tablet.ok, 'Camp page at tablet width shows the local target')
    await tablet.page.close()

    // provoked on purpose on one page only: UI5 logs the refused invalid value and the follow-up read that shared its batch
    const noisy = opened.map(p => ({ ...p, errors: p.refusedOnPurpose ? p.errors.filter(e => !/ReliefService\.proposeTarget.*must be a positive number|previous request failed/.test(e)) : p.errors })).filter(p => p.errors.length)
    check(noisy.length === 0, `no console or page errors on any of the ${opened.length} pages opened${noisy.length ? ':\n      ' + noisy.flatMap(p => p.errors.map(e => p.url.slice(0, 60) + ' -- ' + e.slice(0, 420))).join('\n      ') : ''}`)
  } finally {
    await browser.close()
    server.kill()
    fs.rmSync(path.dirname(clockFile), { recursive: true, force: true })
  }
  if (failures.length) { console.error(`\n${failures.length} local target check(s) failed`); process.exit(1) }
  console.log('\nAll local target checks passed')
})().catch(e => { console.error(e); process.exit(1) })
