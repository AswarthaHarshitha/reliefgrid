/**
 * Browser test for households and the household planning assumption (B4.3),
 * with real test identities, on an isolated server and in-memory database.
 * Synthetic camps are created through the public API.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer-core')
const { USERS } = require('../helpers/test-users')

const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.HOUSEHOLDS_PORT || 4194
const BASE = `http://localhost:${PORT}`
const R = '/odata/v4/relief'
const SHOTS = process.env.SCREENSHOT_DIR
const CHROME = process.env.CHROME_PATH || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}[process.platform]

const failures = []
const check = (ok, message) => { console.log(`${ok ? '  ✔' : '  ✖'} ${message}`); if (!ok) failures.push(message) }
const wait = ms => new Promise(r => setTimeout(r, ms))

async function api(method, url, body, user = 'admin') {
  const res = await fetch(BASE + url, { method, body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${user}:test`).toString('base64') } })
  const text = await res.text()
  if (!res.ok) { const e = new Error(`${method} ${url}: ${res.status} ${text}`); e.status = res.status; throw e }
  return text ? JSON.parse(text) : null
}

;(async () => {
  const server = spawn(process.execPath, [require.resolve('@sap/cds/bin/serve.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT, CDS_ENV: 'development',
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
  const open = async (url, needles, { user = 'admin', width = 1440, height = 900 } = {}) => {
    if (!contexts.has(user)) contexts.set(user, await browser.createBrowserContext())
    const page = await contexts.get(user).newPage()
    await page.authenticate({ username: user, password: 'test' })
    await page.setViewport({ width, height })
    const entry = { url, errors: [] }
    opened.push(entry)
    page.on('pageerror', e => entry.errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error' && !/favicon|Component-preload|Failed to load resource|ResizeObserver|is deprecated|S\/CUBE|Merging of arrays|getDistinctSemanticObjects/.test(m.text())) entry.errors.push(m.text()) })
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' })
    const ok = await page.waitForFunction(n => n.every(x => document.body.innerText.includes(x)), { timeout: 60000, polling: 500 }, needles).then(() => true, () => false)
    await wait(1000)
    return { page, ok, entry, text: () => page.evaluate(() => document.body.innerText) }
  }
  const clickButton = async (page, scope, label) => {
    for (const h of await page.$$(`${scope} button`))
      if (await h.evaluate((b, l) => b.innerText.trim() === l && b.offsetParent !== null, label)) return h.click()
    throw new Error(`button "${label}" not found`)
  }
  const hasButton = (page, label) => page.evaluate(l => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === l && b.offsetParent !== null), label)
  const feedback = async (page, pattern) => {
    for (let i = 0; i < 60; i++) {
      const t = await page.evaluate(() => [...document.querySelectorAll('.sapMMessageToast, .sapMDialog, .sapMMessageView, .sapMPopover, .sapMMsgStrip')].map(d => d.innerText.replace(/\s+/g, ' ')).join(' || '))
      if (pattern.test(t)) return t
      await wait(250)
    }
    return ''
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) } }
  const openTab = async (page, facet) => { await page.click(`[id$="FacetSection::${facet}-anchor"]`); await wait(1200) }
  const setField = async (page, selector, text) => {
    await page.click(selector)
    await page.$eval(selector, e => e.select())
    await page.keyboard.type(text)
    await page.keyboard.press('Tab')
    await wait(800)
  }
  const line = async (campID, code) => (await api('GET', `${R}/Stock?$filter=camp_ID eq ${campID} and standard_code eq '${code}'`)).value[0]
  const householdsOf = campID => api('GET', `${R}/Camps(ID=${campID},IsActiveEntity=true)/householdInfo`)

  try {
    const camp = async (name, headcount, households) => {
      const d = await api('POST', `${R}/Camps`, {})
      const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
      await api('PATCH', key, { name, district: 'District H', region: 'Region H', hazard_code: 'FLOOD', headcount, households })
      await api('POST', `${key}/ReliefService.draftActivate`, {})
      const stock = (await api('GET', `${R}/Camps(ID=${d.ID},IsActiveEntity=true)/stock`)).value
      await api('POST', `${R}/Stock(${stock.find(l => l.standard_code === 'CONTAINER').ID})/ReliefService.recordCount`, { quantity: 9 })
      return d.ID
    }
    const alpha = await camp('Household UI Alpha', 23)
    const bravo = await camp('Household UI Bravo', 23, 4)
    const route = id => `/camps/webapp/index.html#/Camps(ID=${id},IsActiveEntity=true)`

    // ---- An estimate is labelled as one ----
    const p = await open(route(alpha), ['Households (estimated)'], { user: 'coordinator' })
    check(p.ok, 'Manage Camps: the container line says it uses estimated households')
    await openTab(p.page, 'Details')
    const details = await p.page.waitForFunction(() => /Estimated Households/.test(document.body.innerText) && /Household Figure/.test(document.body.innerText), { timeout: 20000 }).then(() => true, () => false)
    const text = await p.text()
    check(details && /Household Size \(Planning Assumption\)/.test(text), 'Camp Details: shows the estimate, that it is estimated, and the household size behind it')
    await shot(p.page, 'households-estimated')

    // ---- A coordinator records a count through the normal edit ----
    p.entry.editedHere = true
    await clickButton(p.page, 'body', 'Edit')
    await p.page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Save' && b.offsetParent !== null), { timeout: 30000 })
    await wait(1200)
    await openTab(p.page, 'Details')
    const field = '[id$="households::Field-edit-inner"], [id*="DataField::households"] input'
    await p.page.waitForSelector(field, { visible: true, timeout: 20000 })
    await setField(p.page, field, '99')
    await clickButton(p.page, 'body', 'Save')
    const refused = await feedback(p.page, /cannot be higher than the number of people/)
    check(/cannot be higher than the number of people/.test(refused) && (await householdsOf(alpha)).recordedHouseholds === null,
      'Manage Camps: more households than people is refused with an explanation, and nothing is saved')
    for (const label of ['Close', 'OK']) if (await p.page.evaluate(l => [...document.querySelectorAll('.sapMDialog button')].some(b => b.innerText.trim() === l && b.offsetParent !== null), label)) await clickButton(p.page, '.sapMDialog', label)
    await wait(800)
    await setField(p.page, field, '3')
    await clickButton(p.page, 'body', 'Save')
    const saved = await p.page.waitForFunction(() => document.body.innerText.includes('Households (recorded)'), { timeout: 30000, polling: 500 }).then(() => true, () => false)
    const h = await householdsOf(alpha)
    const c1 = await line(alpha, 'CONTAINER')
    check(saved && h.recordedHouseholds === 3 && h.estimatedHouseholds === null && h.householdBasis === 'RECORDED' && Number(c1.required) === 6,
      `Manage Camps: a recorded count replaces the estimate and the requirement follows (${h.recordedHouseholds} households, ${c1.required} containers)`)
    await shot(p.page, 'households-recorded')
    await p.page.close()

    // ---- History says what happened and what was used ----
    const hist = await open(route(alpha), ['Assessment History'], { user: 'coordinator' })
    await openTab(hist.page, 'AssessmentHistory')
    const listed = await hist.page.waitForFunction(() => [...document.querySelectorAll('.sapMListTblRow')].some(r => r.innerText.includes('Households changed')), { timeout: 30000, polling: 500 }).then(() => true, () => false)
    check(listed, 'Assessment History: the recorded count appears as "Households changed"')
    const row = await hist.page.evaluateHandle(() => [...document.querySelectorAll('.sapMListTblRow')].find(r => r.innerText.includes('Households changed')) || document.body)
    await row.click()
    await hist.page.waitForFunction(() => location.href.includes('/assessmentRecords('), { timeout: 20000 }).catch(() => {})
    await hist.page.waitForFunction(() => [...document.querySelectorAll('[id*="RecordDetail"] .sapMListTblRow')].some(r => r.innerText.includes('Households')), { timeout: 30000, polling: 500 }).catch(() => {})
    const rows = await hist.page.evaluate(() => [...document.querySelectorAll('[id*="RecordDetail"] .sapMListTblRow')].map(r => [...r.children].map(c => c.innerText.trim()).filter(Boolean).join(' | ')))
    const containers = rows.find(t => /Water containers/.test(t))
    check(!!containers && /Households/.test(containers) && /\b6\b/.test(containers), `Assessment record: the container line shows its household basis (${(containers || rows.length + ' rows').slice(0, 130)})`)
    const header = await hist.text()
    check(/Households Counted/.test(header), 'Assessment record: the header keeps the household count that was used')
    await hist.page.close()

    // ---- Household size: one Administrator proposes, another approves (B4.3 governance) ----
    const coord = await open('/methodology/webapp/index.html', ['Household size', 'Used only to estimate households where none were counted: 5 people per household.'], { user: 'coordinator' })
    check(coord.ok && !(await hasButton(coord.page, 'Propose a household-size change')), 'Methodology: a coordinator sees the household size and cannot propose a change')
    await coord.page.close()

    // an outstanding container request in a camp whose households are estimated
    const delta = await camp('Household UI Delta', 23)
    const deltaLines = (await api('GET', `${R}/Camps(ID=${delta},IsActiveEntity=true)/stock`)).value
    await api('POST', `${R}/Stock(${deltaLines.find(l => l.standard_code === 'CONTAINER').ID})/ReliefService.recordCount`, { quantity: 0 })
    await api('POST', `${R}/Camps(ID=${delta},IsActiveEntity=true)/ReliefService.raiseRequests`, {})

    const m = await open('/methodology/webapp/index.html', ['Used only to estimate households where none were counted: 5 people per household.'])
    check(/Two per household|two containers per household/i.test(await m.text()), 'Methodology: explains that containers are per household')
    await clickButton(m.page, 'body', 'Propose a household-size change')
    await m.page.waitForSelector('.sapMDialog textarea', { visible: true, timeout: 10000 })
    await wait(600)
    await setField(m.page, '.sapMDialog .sapMStepInput input', '4')
    await clickButton(m.page, '.sapMDialog', 'Propose')
    await wait(800)
    const noReason = await m.page.evaluate(() => { const a = document.querySelector('.sapMDialog textarea'); return !!a && a.getBoundingClientRect().height > 0 })
    check(noReason && Number((await api('GET', `${R}/HouseholdAssumption('CURRENT')`)).householdSize) === 5, 'Methodology: the change needs a reason, and nothing is saved without one')
    await m.page.type('.sapMDialog textarea', 'Registration shows smaller families')
    await wait(300)
    await clickButton(m.page, '.sapMDialog', 'Propose')
    const proposed = await feedback(m.page, /unchanged until another Administrator approves/)
    const pendingSize = await api('GET', `${R}/HouseholdAssumption('CURRENT')`)
    check(!!proposed && Number(pendingSize.householdSize) === 5 && pendingSize.version === 1 && !!pendingSize.pendingProposal_ID,
      `Methodology: an Administrator proposes a change, and the size stays as it is (${pendingSize.householdSize}, version ${pendingSize.version})`)
    await clickButton(m.page, '.sapMDialog', 'OK')
    const waiting = await m.page.waitForFunction(() => /Waiting for approval: 5 → 4 people per household, proposed by admin/.test(document.body.innerText) &&
      /Another Administrator must approve or reject it/.test(document.body.innerText), { timeout: 20000, polling: 500 }).then(() => true, () => false)
    check(waiting && !(await hasButton(m.page, 'Approve')) && await hasButton(m.page, 'Withdraw proposal'),
      'Methodology: the proposer sees the waiting proposal, can withdraw it, and cannot approve it')
    await shot(m.page, 'household-proposed')
    await m.page.close()

    const m2 = await open('/methodology/webapp/index.html', ['Waiting for approval: 5 → 4 people per household'], { user: 'admin2' })
    check(m2.ok && await hasButton(m2.page, 'Approve') && await hasButton(m2.page, 'Reject'), 'Methodology: another Administrator sees the proposal with Approve and Reject')
    await clickButton(m2.page, 'body', 'Approve')
    await m2.page.waitForSelector('.sapMDialog', { visible: true, timeout: 10000 })
    await wait(500)
    await clickButton(m2.page, '.sapMDialog', 'Approve')
    const success = await feedback(m2.page, /new household size applies now/)
    const after = await api('GET', `${R}/HouseholdAssumption('CURRENT')`)
    check(/new household size applies now/.test(success) && /flagged for review because their requirement changed: 1/.test(success) && Number(after.householdSize) === 4 && after.version === 2,
      `Methodology: another Administrator approves; the size changes and one container request is flagged (${after.householdSize}, version ${after.version})`)
    await clickButton(m2.page, '.sapMDialog', 'OK')
    const log = await m2.page.waitForFunction(() => { const t = document.querySelector('[id$="householdHistory"]'); return t && /Registration shows smaller families/.test(t.innerText) && /\badmin\b/.test(t.innerText) && /admin2/.test(t.innerText) },
      { timeout: 20000, polling: 500 }).then(() => true, () => false)
    check(log, 'Methodology: the change appears in its own history, with who proposed it, who approved it and why')
    await shot(m2.page, 'household-size')
    await m2.page.close()

    const ccReview = await open('/command/webapp/index.html', ['Needs Decision'], { user: 'coordinator' })
    await ccReview.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('attention'))
    const reason = await ccReview.page.waitForFunction(() => [...document.querySelectorAll('[id$="--attention"] .sapMListTblRow')].map(r => r.innerText.replace(/\s+/g, ' '))
      .find(t => /Household UI Delta/.test(t) && /Request needs review/.test(t) && /Household size changed from 5 to 4 people per household: requirement 10 containers → 12 containers/.test(t)),
      { timeout: 20000, polling: 500 }).then(() => true, () => false)
    check(reason, 'Command Center Needs Decision: the flagged container request says what changed, with the requirement before and after')
    await ccReview.page.close()

    const charlie = await camp('Household UI Charlie', 23)
    const est = await householdsOf(charlie)
    const cB = await line(bravo, 'CONTAINER')
    check(est.estimatedHouseholds === 6 && Number((await line(charlie, 'CONTAINER')).required) === 12, 'A new estimate uses the changed size (23 people at 4, rounded up: 6)')
    check(Number(cB.required) === 8 && cB.targetBasisText === 'Households (recorded)', 'A camp with a recorded count is not affected by the household size')

    // ---- Command Center ----
    const cc = await open('/command/webapp/index.html', ['Household UI Charlie'], { user: 'coordinator' })
    const cell = await cc.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main').getModel('view').getProperty('/camps').find(r => r.name === 'Household UI Charlie').cells.CONTAINER)
    check(/Households \(estimated\)/.test(cell.tooltip), `Command Center heatmap: the tooltip says the figure is estimated (${cell.tooltip.slice(0, 90)})`)
    await cc.page.close()

    // ---- Donors ----
    const d = await open('/methodology/webapp/index.html', ['The current household size is visible to coordinators and administrators.'], { user: 'donor' })
    check(d.ok && !(await hasButton(d.page, 'Propose a household-size change')), 'Methodology: a donor sees neither the value nor the change button')
    opened.pop() // the planning figures are refused to donors by design; that refusal is logged by UI5
    await d.page.close()
    let refusedCount = 0
    for (const url of [`${R}/HouseholdAssumption`, `${R}/HouseholdAssumptionChanges`, `${R}/HouseholdSizeProposals`, `${R}/CampHouseholds`]) { try { await api('GET', url, null, 'donor') } catch (e) { if (e.status === 403) refusedCount++ } }
    check(refusedCount === 4, 'Donors are refused the household data and proposals (403)')

    // ---- Widths ----
    for (const [w, h2, label] of [[390, 844, 'phone'], [820, 1180, 'tablet']]) {
      const s = await open(route(charlie), ['Households (estimated)'], { user: 'coordinator', width: w, height: h2 })
      const over = await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
      check(s.ok && !over, `Camp page at ${label} width shows the household basis without horizontal scrolling`)
      await s.page.close()
    }

    // Only on the page that was edited: UI5's log when the stock table leaves the active document (identical on B4.2,
    // one line per stock row), and its log of the save that was refused on purpose.
    const EXPECTED = /Failed to drill-down into stock\(|Error while saving the document|cannot be higher than the number of people/
    const noisy = opened.map(o => ({ ...o, errors: o.editedHere ? o.errors.filter(e => !EXPECTED.test(e)) : o.errors })).filter(o => o.errors.length)
    check(noisy.length === 0, `no console or page errors on any of the ${opened.length} pages opened${noisy.length ? ':\n      ' + noisy.flatMap(o => o.errors.map(e => o.url.slice(0, 60) + ' -- ' + e.slice(0, 400))).join('\n      ') : ''}`)
  } finally {
    await browser.close()
    server.kill()
  }
  if (failures.length) { console.error(`\n${failures.length} household check(s) failed`); process.exit(1) }
  console.log('\nAll household checks passed')
})().catch(e => { console.error(e); process.exit(1) })
