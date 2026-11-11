/**
 * Browser test for functional toilet and tap counts (B4.5), with real test
 * identities, on an isolated server and in-memory database.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer-core')
const { USERS } = require('../helpers/test-users')

const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.FUNCTIONAL_PORT || 4191
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
  const open = async (url, needles, { user = 'coordinator', width = 1440, height = 900 } = {}) => {
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
  const typeInto = async (page, id, text) => {
    const sel = `[id="${id}"] input`
    await page.click(sel)
    await page.$eval(sel, e => e.select())
    await page.keyboard.type(text)
    await page.keyboard.press('Tab')
    await wait(400)
  }
  const clickIn = async (page, scope, label) => {
    for (const h of await page.$$(`${scope} button`))
      if (await h.evaluate((b, l) => b.innerText.trim() === l && b.offsetParent !== null, label)) return h.click()
    throw new Error(`button "${label}" not found`)
  }
  const feedback = async (page, pattern) => {
    for (let i = 0; i < 60; i++) {
      const t = await page.evaluate(() => [...document.querySelectorAll('.sapMMessageToast, .sapMDialog')].map(d => d.innerText.replace(/\s+/g, ' ')).join(' || '))
      if (pattern.test(t)) return t
      await wait(250)
    }
    return ''
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) } }

  try {
    const make = async (name, counts) => {
      const d = await api('POST', `${R}/Camps`, {})
      const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
      await api('PATCH', key, { name, district: 'District F', region: 'Region F', hazard_code: 'FLOOD', headcount: 100 })
      await api('POST', `${key}/ReliefService.draftActivate`, {})
      const lines = (await api('GET', `${R}/Camps(ID=${d.ID},IsActiveEntity=true)/stock`)).value
      for (const [c, body] of Object.entries(counts)) await api('POST', `${R}/Stock(${lines.find(l => l.standard_code === c).ID})/ReliefService.recordCount`, body)
      return d.ID
    }
    const alpha = await make('Functional UI Alpha', { TOILET: { quantity: 4 } })
    const bravo = await make('Functional UI Bravo', { TAP: { quantity: 1 } })
    const route = id => `/camps/webapp/index.html#/Camps(ID=${id},IsActiveEntity=true)`
    const toilet = async () => (await api('GET', `${R}/Stock?$filter=camp_ID eq ${alpha} and standard_code eq 'TOILET'`)).value[0]

    const p = await open(route(alpha), ['Functionality not confirmed', 'Not confirmed', 'Functional'])
    check(p.ok, 'Manage Camps: a toilet total without a functional count shows "Functionality not confirmed", never Met or a gap')
    // a table row may pop its columns into a sub-row; read both as one line
    const lineText = () => [...document.querySelectorAll('.sapMListTblRow')].map(r => ({ r,
      t: r.innerText + ' ' + (r.nextElementSibling?.classList.contains('sapMListTblSubRow') ? r.nextElementSibling.innerText : '') }))
    // Record Count works on the selected line: select the toilet line, then use the table toolbar
    const recordIn = async (total, functional) => {
      const select = await p.page.evaluateHandle(`(${lineText})().find(x => /^\\s*Toilets\\b/m.test(x.r.innerText))?.r.querySelector('.sapMRb, [role=radio]') || null`)
      if (!(await select.evaluate(b => !!b))) throw new Error('the toilet line cannot be selected')
      await select.click()
      await p.page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Record Stock Count' && b.offsetParent !== null && !b.disabled && b.getAttribute('aria-disabled') !== 'true'), { timeout: 10000 })
      await clickIn(p.page, 'body', 'Record Stock Count')
      await p.page.waitForSelector('[id="APD_::functionalUnits"]', { visible: true, timeout: 10000 })
      await wait(700)
      await typeInto(p.page, 'APD_::quantity', String(total))
      await typeInto(p.page, 'APD_::functionalUnits', String(functional))
      await clickIn(p.page, '.sapMDialog', 'Record Stock Count')
    }
    await recordIn(6, 7)
    const refused = await feedback(p.page, /cannot be more than the total units counted/)
    check(!!refused && (await toilet()).functionalUnits === null, 'Record Count: more functional units than the total are refused with an explanation, and nothing is saved')
    for (const label of ['Close', 'Cancel']) {
      for (const h of await p.page.$$('.sapMDialog button')) if (await h.evaluate((b, l) => b.innerText.trim() === l && b.getBoundingClientRect().height > 0, label)) { await h.click(); await wait(500) }
    }
    await wait(800)
    await recordIn(6, 5)
    // the line shows 6 on hand, 5 functional, and is met
    const saved = await p.page.waitForFunction(`(${lineText})().some(x => /^\\s*Toilets\\b/m.test(x.r.innerText) && /\\bMet\\b/.test(x.t) && /\\b6\\s+toilets\\b/.test(x.t) && /(^|\\s)5(\\s|$)/.test(x.t) && !/not confirmed/i.test(x.t))`,
      { timeout: 30000, polling: 500 }).then(() => true, () => false)
    const t = await toilet()
    check(saved && Number(t.quantity) === 6 && Number(t.functionalUnits) === 5 && t.assessment === 'MET',
      `Record Count: 6 toilets of which 5 functional meets 1 per 20 for 100 people (${t.quantity}/${t.functionalUnits}, ${t.assessment})`)
    await shot(p.page, 'functional-toilets')
    await p.page.close()

    const cc = await open('/command/webapp/index.html', ['Functional UI Bravo'])
    const cell = await cc.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main').getModel('view').getProperty('/camps').find(r => r.name === 'Functional UI Bravo').cells.TAP)
    check(cell.text === 'Not confirmed' && cell.state === 'None' && /1 units recorded in total/.test(cell.tooltip), `Command Center heatmap: an unconfirmed tap shows "Not confirmed" without a colour (${cell.text}, ${cell.state})`)
    check(/1 toilet or tap lines with functionality not confirmed/.test(await cc.text()), 'Command Center: the subtitle counts the lines whose functionality is not confirmed')
    await cc.page.close()

    const m = await open('/methodology/webapp/index.html', ['a total count is never treated as a functional count'])
    check(m.ok && /7\.5 litres per minute/.test(await m.text()), 'Methodology: explains functional counts and the tap flow assumption')
    await m.page.close()

    const phone = await open(route(bravo), ['Functionality not confirmed'], { width: 390, height: 844 })
    const over = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    check(phone.ok && !over, 'Camp page at phone width shows the functionality state without horizontal scrolling')
    await phone.page.close()

    // the refused count above is logged by UI5 on that page, together with the refresh that shared its
    // batch and was therefore not processed; only these messages are expected, and only on that page
    const EXPECTED = /cannot be more than the total units counted|Failed to invoke .*recordCount|(Failed to request side effects|Failed to refresh entity: \/Camps\(.*\)\/stock\([^)]*\)(\[\d+(;selected)?\])?) - Error: HTTP request was not processed because the previous request failed/
    const noisy = opened.map((o, i) => ({ ...o, errors: i === 0 ? o.errors.filter(e => !EXPECTED.test(e)) : o.errors })).filter(o => o.errors.length)
    check(noisy.length === 0, `no console or page errors on any of the ${opened.length} pages opened${noisy.length ? ':\n      ' + noisy.flatMap(o => o.errors.map(e => o.url.slice(0, 60) + ' -- ' + e.slice(0, 400))).join('\n      ') : ''}`)
  } finally {
    await browser.close()
    server.kill()
  }
  if (failures.length) { console.error(`\n${failures.length} functional check(s) failed`); process.exit(1) }
  console.log('\nAll functional checks passed')
})().catch(e => { console.error(e); process.exit(1) })
