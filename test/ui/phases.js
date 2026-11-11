/**
 * Browser test for the response phase (B4.4), with real test identities, on an
 * isolated server and in-memory database. Synthetic camps via the public API.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer-core')
const { USERS } = require('../helpers/test-users')

const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.PHASES_PORT || 4192
const BASE = `http://localhost:${PORT}`
const R = '/odata/v4/relief'
const SHOTS = process.env.SCREENSHOT_DIR
const CHROME = process.env.CHROME_PATH || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}[process.platform]
const DAY = 864e5
const failures = []
const check = (ok, message) => { console.log(`${ok ? '  ✔' : '  ✖'} ${message}`); if (!ok) failures.push(message) }
const wait = ms => new Promise(r => setTimeout(r, ms))

async function api(method, url, body, user = 'admin', headers = {}) {
  const res = await fetch(BASE + url, { method, body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${user}:test`).toString('base64'), ...headers } })
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
    const find = async () => {
      for (const h of await page.$$(`${scope} button`))
        if (await h.evaluate((b, l) => b.innerText.trim() === l && b.offsetParent !== null, label)) return h
    }
    let h = await find()
    if (!h && scope === 'body') {
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
    const sel = `[id="${id}"] input, [id="${id}"] textarea`
    await page.click(sel)
    await page.$eval(sel, e => e.select())
    await page.keyboard.type(text)
    await page.keyboard.press('Tab')
    await wait(400)
  }
  const feedback = async (page, pattern) => {
    for (let i = 0; i < 60; i++) {
      const t = await page.evaluate(() => [...document.querySelectorAll('.sapMMessageToast, .sapMDialog')].map(d => d.innerText.replace(/\s+/g, ' ')).join(' || '))
      if (pattern.test(t)) return t
      await wait(250)
    }
    return ''
  }
  const uiDate = (page, ms) => page.evaluate(t => new Promise(resolve => sap.ui.require(['sap/ui/core/format/DateFormat'],
    DateFormat => resolve(DateFormat.getDateInstance({ style: 'medium' }).format(new Date(t))))), ms)
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) } }

  try {
    const d = await api('POST', `${R}/Camps`, {})
    const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
    await api('PATCH', key, { name: 'Phase UI Alpha', district: 'District P', region: 'Region P', hazard_code: 'FLOOD', headcount: 100 })
    await api('POST', `${key}/ReliefService.draftActivate`, {})
    const camp = d.ID
    const lines = (await api('GET', `${R}/Camps(ID=${camp},IsActiveEntity=true)/stock`)).value
    await api('POST', `${R}/Stock(${lines.find(l => l.standard_code === 'TOILET').ID})/ReliefService.recordCount`, { quantity: 3, functionalUnits: 3 })
    const route = `/camps/webapp/index.html#/Camps(ID=${camp},IsActiveEntity=true)`
    const toilet = async () => (await api('GET', `${R}/Stock?$filter=camp_ID eq ${camp} and standard_code eq 'TOILET'`)).value[0]

    const p = await open(route, ['Medium term (default, no decision)', 'Medium-term figure'], { user: 'coordinator' })
    check(p.ok, 'Manage Camps: a camp without a decision shows the medium term as a default, and the toilet line its medium-term figure')
    await clickButton(p.page, 'body', 'Propose Response Phase')
    await p.page.waitForSelector('[id="APD_::responsePhase"]', { visible: true, timeout: 10000 })
    await wait(800)
    await typeInto(p.page, 'APD_::responsePhase', 'First phase of a rapid-onset crisis')
    await typeInto(p.page, 'APD_::reason', 'Rapid-onset flood, communal toilets being built')
    await typeInto(p.page, 'APD_::effectiveFrom', await uiDate(p.page, Date.now()))
    await typeInto(p.page, 'APD_::reviewDate', await uiDate(p.page, Date.now() + 30 * DAY))
    await clickButton(p.page, '.sapMDialog', 'Propose Response Phase')
    const sent = await feedback(p.page, /response-phase proposal was submitted/)
    const [pending] = (await api('GET', `${R}/CampDecisions?$filter=camp_ID eq ${camp} and kind eq 'PHASE'`)).value
    check(!!sent && pending?.status_code === 'PENDING' && pending.responsePhase === 'FIRST_PHASE' && pending.proposedBy === 'coordinator',
      'Manage Camps: a coordinator proposes a response phase through the dialog')
    await p.page.close()

    const droute = `${route}/decisions(${pending.ID})`
    const cv = await open(droute, ['Response phase', 'First phase of a rapid-onset crisis (toilets: 1 per 50 people)', 'Medium term (default, no decision)'], { user: 'coordinator' })
    check(cv.ok && await buttonState(cv.page, 'Approve') !== 'enabled', 'Decision page: titled "Response phase", shows the proposed and previous phase, and a coordinator cannot approve')
    await cv.page.close()

    const cc = await open('/command/webapp/index.html', ['Needs Decision'], { user: 'admin' })
    await cc.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('attention'))
    const listed = await cc.page.waitForFunction(() => document.querySelector('[id$="--attention"]')?.innerText.includes('Response phase waiting for approval'), { timeout: 20000 }).then(() => true, () => false)
    check(listed, 'Command Center Needs Decision: "Response phase waiting for approval"')
    const row = await cc.page.evaluateHandle(() => [...document.querySelectorAll('[id$="--attention"] .sapMListTblRow')].find(r => r.innerText.includes('Response phase waiting for approval')) || document.body)
    await row.click()
    const nav = await cc.page.waitForFunction(id => location.href.includes(`/decisions(${id})`), { timeout: 20000 }, pending.ID).then(() => true, () => false)
    check(nav, 'Needs Decision opens the response-phase decision')
    await cc.page.close()

    const av = await open(droute, ['Pending approval', 'Response phase'], { user: 'admin' })
    await clickButton(av.page, 'body', 'Approve')
    await av.page.waitForSelector('.sapMDialog', { visible: true, timeout: 10000 })
    await wait(600)
    const labels = await av.page.evaluate(() => [...document.querySelectorAll('.sapMDialog button')].map(b => b.innerText.trim()).filter(Boolean))
    await clickButton(av.page, '.sapMDialog', labels.find(l => l !== 'Cancel'))
    const done = await feedback(av.page, /re-assessed with the new phase/)
    const t = await toilet()
    check(!!done && t.targetBasis === 'PHASE_FIGURE' && Number(t.required) === 2 && t.assessment === 'MET',
      `Decision page: another Administrator approves; toilets now use 1 per 50 (${t.required} required, ${t.assessment})`)
    await av.page.close()

    const after = await open(route, ['First phase of a rapid-onset crisis', 'First-phase figure'], { user: 'coordinator' })
    check(after.ok, 'Manage Camps: the camp shows the decided phase and the toilet line its first-phase figure')
    await shot(after.page, 'phase-first')
    await after.page.close()

    const m = await open('/methodology/webapp/index.html', ['The response phase is decided per camp'], { user: 'coordinator' })
    check(m.ok && /1 per 50 people in the first phase of a rapid-onset crisis/.test(await m.text()), 'Methodology: explains the response phase and its toilet figures with their context')
    await m.page.close()

    const phone = await open(route, ['First phase of a rapid-onset crisis'], { user: 'coordinator', width: 390, height: 844 })
    const over = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    check(phone.ok && !over, 'Camp page at phone width shows the phase without horizontal scrolling')
    await phone.page.close()

    const noisy = opened.filter(o => o.errors.length)
    check(noisy.length === 0, `no console or page errors on any of the ${opened.length} pages opened${noisy.length ? ':\n      ' + noisy.flatMap(o => o.errors.map(e => o.url.slice(0, 60) + ' -- ' + e.slice(0, 400))).join('\n      ') : ''}`)
  } finally {
    await browser.close()
    server.kill()
  }
  if (failures.length) { console.error(`\n${failures.length} phase check(s) failed`); process.exit(1) }
  console.log('\nAll phase checks passed')
})().catch(e => { console.error(e); process.exit(1) })
