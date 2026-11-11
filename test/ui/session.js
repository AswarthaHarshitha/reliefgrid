/**
 * Browser test for signing in and out, and for every page each role can open,
 * with real test identities on an isolated server and in-memory database.
 * Puppeteer answers the browser's sign-in prompt the way a user would, or
 * leaves it unanswered (as a user pressing Cancel).
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer-core')
const { USERS } = require('../helpers/test-users')

const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.SESSION_PORT || 4193
const BASE = `http://localhost:${PORT}`
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
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
const IGNORED = /favicon|Component-preload|Failed to load resource|ResizeObserver|is deprecated|S\/CUBE|Merging of arrays|getDistinctSemanticObjects/

async function api(method, url, body, user = 'admin') {
  const res = await fetch(BASE + url, { method, body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${user}:test`).toString('base64') } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text}`)
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
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) } }

  /** A browser window for one person: one context, so stored credentials persist as in a real browser. */
  const person = async () => {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', e => errors.push(`${page.url()}: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error' && !IGNORED.test(m.text())) errors.push(`${page.url()}: ${m.text().slice(0, 300)}`) })
    // what the person types when the browser asks for a user name and password (null: Cancel)
    const signInAs = async (user, password = 'test') => page.authenticate(user ? { username: user, password } : null)
    // each page is opened as a fresh load, as from the address bar (two launchpad URLs that differ only after # would otherwise be one page)
    const go = async (url, needles, timeout = 60000) => {
      await page.goto('about:blank')
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded' })
      // polled, and tolerant of the launchpad reloading itself once while it starts
      let ok = false
      for (const until = Date.now() + timeout; !ok && Date.now() < until; await wait(500))
        ok = await page.evaluate(n => n.every(x => document.body.innerText.includes(x)), needles).catch(() => false)
      await wait(1000)
      if (!ok) console.log(`      (${url} shows: ${(await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)})`)
      return ok
    }
    const text = () => page.evaluate(() => document.body.innerText)
    return { context, page, errors, signInAs, go, text }
  }

  try {
    // ---- data, through the public API ----
    const d = await api('POST', `${R}/Camps`, {})
    const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
    await api('PATCH', key, { name: 'Session Camp', district: 'District S', region: 'Region S', hazard_code: 'FLOOD', headcount: 100 })
    await api('POST', `${key}/ReliefService.draftActivate`, {})
    const camp = d.ID
    const lines = (await api('GET', `${R}/Camps(ID=${camp},IsActiveEntity=true)/stock`)).value
    await api('POST', `${R}/Stock(${lines.find(l => l.standard_code === 'WATER').ID})/ReliefService.recordCount`, { quantity: 300 })
    await api('POST', `${R}/Camps(ID=${camp},IsActiveEntity=true)/ReliefService.raiseRequests`, {})
    const request = (await api('GET', `${R}/Camps(ID=${camp},IsActiveEntity=true)/requests`)).value[0]
    const decision = await api('POST', `${R}/Camps(ID=${camp},IsActiveEntity=true)/ReliefService.proposeApplicability`,
      { standard: 'NET', applicability: 'APPLICABLE', reason: 'Malaria season', source: 'Health cluster', reviewDate: new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10) }, 'coordinator')
    const record = (await api('GET', `${R}/Camps(ID=${camp},IsActiveEntity=true)/assessmentRecords?$top=1`)).value[0]
    const campRoute = `/camps/webapp/index.html#/Camps(ID=${camp},IsActiveEntity=true)`

    // ---- every role: sign in, home page, every page it may open, nothing else ----
    const ROLES = {
      admin: { tiles: ['Relief Command Center', 'Manage Relief Camps', 'Methodology and References'], hidden: ['Pledge Board'], chip: 'Signed in with planning access' },
      admin2: { tiles: ['Relief Command Center', 'Manage Relief Camps', 'Methodology and References'], hidden: ['Pledge Board'], chip: 'Signed in with planning access' },
      coordinator: { tiles: ['Relief Command Center', 'Manage Relief Camps', 'Methodology and References'], hidden: ['Pledge Board'], chip: 'Signed in with planning access' },
      donor: { tiles: ['Pledge Board', 'Methodology and References'], hidden: ['Relief Command Center', 'Manage Relief Camps'], chip: 'Signed in with donor access' },
      visitor: { tiles: ['Methodology and References'], hidden: ['Relief Command Center', 'Manage Relief Camps', 'Pledge Board'], chip: 'Signed in' }
    }
    const PLANNER_PAGES = [
      ['/index.html#ReliefNetwork-monitor', ['Relief Command Center', 'Indicator Heatmap', 'Act Now'], 'Command Center'],
      ['/command/webapp/index.html', ['Session Camp', 'Requests Awaiting Pledge'], 'Command Center (direct)'],
      ['/index.html#ReliefCamp-manage', ['Relief Camps', 'Session Camp'], 'Manage Relief Camps list'],
      [campRoute, ['Session Camp', 'Stock & Indicator Gaps', 'Goods Received', 'Stock Ledger', 'Supply Activity'], 'camp page'],
      [`${campRoute}/requests(${request.ID})`, ['Water', 'Pledges', 'Reviews', 'Quantity'], 'request page'],
      [`${campRoute}/decisions(${decision.ID})`, ['Pending approval', 'Mosquito nets'], 'decision page'],
      [`${campRoute}/assessmentRecords(${record.ID})`, ['Indicators as Assessed'], 'assessment record page'],
      ['/index.html#ReliefMethodology-display', ['Methodology and References', 'Planning choices'], 'Methodology']
    ]
    for (const [user, expect] of Object.entries(ROLES)) {
      const p = await person()
      await p.signInAs(user)
      const home = await p.go('/index.html', [...expect.tiles, expect.chip, 'Sign out'])
      const homeText = await p.text()
      check(home && expect.hidden.every(t => !homeText.includes(t)), `${user}: signs in and the home page shows only their applications (${expect.tiles.length})`)
      if (expect.tiles.includes('Relief Command Center')) {
        for (const [url, needles, label] of PLANNER_PAGES) check(await p.go(url, needles), `${user}: ${label} opens`)
        await p.page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs')?.setSelectedKey('attention')).catch(() => {})
      }
      if (expect.tiles.includes('Pledge Board')) {
        check(await p.go('/index.html#SupplyRequest-pledge', ['Open Needs', 'Session Camp']), `${user}: Pledge Board opens with the open needs`)
        check(await p.go('/pledge/webapp/index.html', ['Open Needs', 'My Pledges']), `${user}: Pledge Board has the Open Needs and My Pledges tabs`)
        check(await p.go('/index.html#ReliefMethodology-display', ['Methodology and References']), `${user}: Methodology opens`)
      }
      if (user === 'visitor') check(await p.go('/index.html#ReliefMethodology-display', ['Methodology and References']), 'visitor: Methodology opens')
      // the services refuse what the home page does not offer, whatever the URL
      const refusals = await p.page.evaluate(async ([R, D]) => Promise.all([`${R}/Camps`, `${D}/Requests`].map(u => fetch(u).then(r => r.status))), [R, D])
      const planner = expect.tiles.includes('Relief Command Center'), donor = expect.tiles.includes('Pledge Board')
      check(refusals[0] === (planner ? 200 : 403) && refusals[1] === (donor ? 200 : 403), `${user}: the services allow exactly their role (planning ${refusals[0]}, donor ${refusals[1]})`)
      check(p.errors.length === 0, `${user}: no console or page errors on any page${p.errors.length ? ':\n      ' + p.errors.slice(0, 5).join('\n      ') : ''}`)
      await p.context.close()
    }

    // ---- signing out from the home page, then another person signs in in the same browser ----
    {
      const p = await person()
      await p.signInAs('admin')
      await p.go('/index.html', ['Relief Command Center', 'Sign out'])
      for (const h of await p.page.$$('a.rg-signout')) { await h.click(); break }
      const out = await p.page.waitForFunction(() => location.pathname.endsWith('/signout.html') && /You have signed out/.test(document.body.innerText), { timeout: 15000 }).then(() => true, () => false)
      check(out, 'Sign out on the home page leads to "You have signed out"')
      await shot(p.page, 'signed-out')
      // someone else signs in in the same browser window: the browser must ask (the administrator's
      // password is no longer sent), and the home page must be the donor's, not the administrator's
      await p.signInAs('donor')
      await p.go('/index.html', ['Pledge Board', 'Signed in with donor access'])
      const t = await p.text()
      check(t.includes('Pledge Board') && !t.includes('Relief Command Center') && !t.includes('planning access'),
        'after signing out, the browser asks again: another user signs in in the same window and sees only their applications')
      const planning = await p.page.evaluate(() => fetch('odata/v4/relief/Camps').then(r => r.status))
      check(planning === 403, `after signing out, nothing is done as the administrator any more (coordinator service: ${planning})`)
      check(p.errors.length === 0, `sign-out and sign-in again: no console or page errors${p.errors.length ? ':\n      ' + p.errors.slice(0, 5).join('\n      ') : ''}`)
      await p.context.close()
    }

    // ---- signing out from the user menu inside an application ----
    {
      const p = await person()
      await p.signInAs('coordinator')
      await p.go('/index.html#ReliefNetwork-monitor', ['Relief Command Center', 'Indicator Heatmap'])
      const avatar = await p.page.$('[id$="meAreaHeaderButton"], [id="userActionsMenuHeaderButton"]')
      if (avatar) await avatar.click()
      await wait(1500)
      await p.page.waitForFunction(() => [...document.querySelectorAll('[role=menuitem], li')].some(e => /^Sign Out$/.test(e.innerText.trim())), { timeout: 10000 }).catch(() => {})
      const entry = await p.page.evaluateHandle(() => [...document.querySelectorAll('[role=menuitem], li')].find(e => /^Sign Out$/.test(e.innerText.trim())))
      const found = await entry.evaluate(x => !!x)
      if (found) await entry.click()
      // the shell asks to confirm
      await p.page.waitForFunction(() => [...document.querySelectorAll('.sapMDialog button')].some(b => b.innerText.trim() === 'OK' && b.offsetParent), { timeout: 10000 }).catch(() => {})
      await wait(500)
      for (const b of await p.page.$$('.sapMDialog button')) if ((await b.evaluate(x => x.innerText.trim())) === 'OK') { await b.click(); break }
      const out = await p.page.waitForFunction(() => location.pathname.endsWith('/signout.html') && /You have signed out/.test(document.body.innerText), { timeout: 15000 }).then(() => true, () => false)
      check(found && out, `Sign Out in the user menu of an application leads to "You have signed out" (menu entry ${found ? 'found' : 'missing'}, now at ${p.page.url().replace(BASE, '')})`)
      await p.signInAs('donor')
      await p.go('/index.html', ['Pledge Board', 'Signed in with donor access'])
      const t = await p.text()
      check(!t.includes('Relief Command Center'), 'after signing out in an application, the next person signs in as themselves, not as the coordinator')
      await p.context.close()
    }

    // ---- a wrong password, then the right one ----
    {
      const p = await person()
      await p.signInAs('admin', 'wrong')
      await p.page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' })
      const refused = await p.page.waitForFunction(() => location.pathname.endsWith('/signin.html'), { timeout: 20000 }).then(() => true, () => false)
      check(refused && !(await p.text()).includes('Relief Command Center'), 'a wrong password opens no application and shows the sign-in page')
      await p.signInAs('admin')
      for (const h of await p.page.$$('a.button')) { await h.click(); break }
      const back = await p.page.waitForFunction(() => /Relief Command Center/.test(document.body.innerText), { timeout: 30000 }).then(() => true, () => false)
      check(back, 'Sign in again with the right password opens the home page')
      await p.context.close()
    }

    // ---- the sign-in and sign-out pages on a phone ----
    {
      const p = await person()
      await p.page.setViewport({ width: 390, height: 844 })
      for (const url of ['/signin.html', '/signout.html']) {
        await p.page.goto(BASE + url, { waitUntil: 'domcontentloaded' })
        await wait(300)
        const over = await p.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
        check(!over, `${url} fits a phone screen without horizontal scrolling`)
      }
      await p.context.close()
    }
  } finally {
    await browser.close()
    server.kill()
  }
  if (failures.length) { console.error(`\n${failures.length} session check(s) failed`); process.exit(1) }
  console.log('\nAll session checks passed')
})().catch(e => { console.error(e); process.exit(1) })
