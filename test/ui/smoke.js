/**
 * Browser smoke test for all four apps and the launchpad.
 *
 * Starts an isolated server on an in-memory database, creates synthetic
 * fixtures through the public API, then drives every app in headless Chrome
 * and fails on missing content or UI5 errors. Set SCREENSHOT_DIR to keep
 * screenshots; set CHROME_PATH if Chrome is not in the default location.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const puppeteer = require('puppeteer-core')
// Test-only identities (never in package.json or the build): coordinator, admin, admin2, donor.
const { USERS } = require('../helpers/test-users')

const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.PORT || 4199
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.SCREENSHOT_DIR
const CHROME =
  process.env.CHROME_PATH ||
  {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  }[process.platform]

const failures = []
const check = (ok, message) => {
  console.log(`${ok ? '  ✔' : '  ✖'} ${message}`)
  if (!ok) failures.push(message)
}

async function startServer() {
  const server = spawn(process.execPath, [require.resolve('@sap/cds/bin/serve.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT,
      CDS_ENV: 'development',
      CDS_CONFIG: JSON.stringify({ requires: { db: { kind: 'sqlite', credentials: { url: ':memory:' } }, auth: { kind: 'mocked', users: USERS } } })
    },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => String(d).includes('server listening') && resolve())
    server.on('exit', code => reject(new Error(`server exited with ${code}`)))
  })
  return server
}

async function api(method, url, body, user = 'admin', extra = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${user}:test`).toString('base64'), ...extra },
    body: body && JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

/** Synthetic test fixtures; they live only in the in-memory test database. */
async function seed() {
  const R = '/odata/v4/relief'
  const fixtures = [
    { name: 'Test Camp Alpha', district: 'District A', region: 'Region 1', hazard_code: 'FLOOD', headcount: 1200, childrenUnder5: 180,
      stock: { WATER: 9000, FOOD: 1500, SOAP: 40000, LAUNDRY: 60000, SHELTER: 2500, TOILET: 20, TAP: 2, CONTAINER: 300, NET: 200 } },
    { name: 'Test Camp Bravo', district: 'District B', region: 'Region 1', hazard_code: 'CYCLONE', headcount: 450, childrenUnder5: 70,
      stock: { WATER: 40000, FOOD: 2500, SOAP: 30000, LAUNDRY: 25000, SHELTER: 1600, TOILET: 21, TAP: 2, CONTAINER: 160, NET: 230 } },
    { name: 'Test Camp Charlie', district: 'District C', region: 'Region 2', hazard_code: 'EARTHQUAKE', headcount: 800, childrenUnder5: 95,
      stock: { WATER: 30000, FOOD: 6000, SOAP: 50000, LAUNDRY: 40000, SHELTER: 2000, TOILET: 25, TAP: 3, CONTAINER: 200, NET: 300 } }
  ]
  for (const { stock, ...camp } of fixtures) {
    const draft = await api('POST', `${R}/Camps`, {})
    const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
    await api('PATCH', key, camp)
    await api('POST', `${key}/ReliefService.draftActivate`, {})
    const lines = await api('GET', `${R}/Camps(ID=${draft.ID},IsActiveEntity=true)/stock`)
    for (const line of lines.value)
      await api('POST', `${R}/Stock(${line.ID})/ReliefService.recordCount`, { quantity: stock[line.standard_code], ...(['TOILET', 'TAP'].includes(line.standard_code) ? { functionalUnits: stock[line.standard_code] } : {}) })
    await api('POST', `${R}/Camps(ID=${draft.ID},IsActiveEntity=true)/ReliefService.raiseRequests`, { targetDays: 7 })
  }
  // One camp without people recorded and one that has never been counted (B2 states).
  for (const camp of [
    { name: 'Test Camp Delta', district: 'District D', region: 'Region 2', hazard_code: 'FLOOD' },
    { name: 'Test Camp Echo', district: 'District E', region: 'Region 2', hazard_code: 'FLOOD', headcount: 250 }
  ]) {
    const draft = await api('POST', `${R}/Camps`, {})
    const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
    await api('PATCH', key, camp)
    await api('POST', `${key}/ReliefService.draftActivate`, {})
    await api('POST', `${R}/Camps(ID=${draft.ID},IsActiveEntity=true)/ReliefService.raiseRequests`, { targetDays: 7 })
  }
  // Alpha's water request, explicitly: the order of requests is not defined
  // SEC-06: only a donor (Donor role) uses the donor service
  const board = await api('GET', `/odata/v4/donor/Requests?$filter=standard_code eq 'WATER' and campName eq 'Test Camp Alpha'`, null, 'donor')
  await api('POST', `/odata/v4/donor/Requests(${board.value[0].ID})/DonorService.pledge`, {
    donor: 'Test Donor Org', quantity: Math.floor(board.value[0].quantity / 2), eta: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10)
  }, 'donor')
}

// One browser context per user, so a user's credentials are never reused for another user's pages.
const contexts = new Map()
async function open(browser, name, url, { waitFor, width = 1440, height = 900, user = 'admin' }) {
  if (!contexts.has(user)) contexts.set(user, await browser.createBrowserContext())
  const page = await contexts.get(user).newPage()
  await page.authenticate({ username: user, password: 'test' })
  await page.bringToFront()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon|Component-preload|Failed to load resource.*(404|ERR_FAILED)/.test(m.text())) errors.push(m.text())
  })
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' })
  try {
    await page.waitForFunction(waitFor, { timeout: 60000, polling: 500 })
    await new Promise(r => setTimeout(r, 1500)) // let animations settle
    check(true, `${name} renders`)
  } catch {
    check(false, `${name} renders`)
  }
  // Framework-internal logs that do not come from this code base
  const ui5Errors = errors.filter(e =>
    !/ResizeObserver|is deprecated|S\/CUBE is not yet supported|Merging of arrays is not supported for config key groups|getDistinctSemanticObjects/.test(e))
  check(ui5Errors.length === 0, `${name} has no console errors${ui5Errors.length ? `: ${ui5Errors.slice(0, 3).join(' | ')}` : ''}`)
  // Old labels and citations; "Sphere Standard" only as the old title-case label, since "not a Sphere standard" is correct text
  const stale = await page.evaluate(() => {
    const text = document.body.innerText
    return (text.match(/WHO universal|Sphere Compliance|Sphere minimum|Sphere heatmap|household of 5 assumed|General food ration/i) ||
      text.match(/Sphere Standards?\b/) || [])[0]
  })
  check(!stale, `${name} shows no superseded wording${stale ? `: "${stale}"` : ''}`)
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `${name.replace(/\W+/g, '-').toLowerCase()}.png`) })
  }
  return page
}

const textIncludes = (...needles) =>
  new Function(`return ${JSON.stringify(needles)}.every(n => document.body.innerText.includes(n))`)

;(async () => {
  const server = await startServer()
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--lang=en-US'] })
  try {
    console.log('UI smoke test')
    const unit = await open(browser, 'Unit tests', '/command/webapp/test/unit/unitTests.qunit.html', {
      waitFor: () => window.qunitResult
    })
    const result = await unit.evaluate(() => window.qunitResult)
    await unit.close()
    check(result && result.failed === 0 && result.total > 0, `QUnit: ${result?.passed}/${result?.total} assertions passed`)

    const methodUnit = await open(browser, 'Methodology unit tests', '/methodology/webapp/test/unit/unitTests.qunit.html', {
      waitFor: () => window.qunitResult
    })
    const methodResult = await methodUnit.evaluate(() => window.qunitResult)
    await methodUnit.close()
    check(methodResult && methodResult.failed === 0 && methodResult.total > 0,
      `Methodology QUnit: ${methodResult?.passed}/${methodResult?.total} assertions passed`)

    await (await open(browser, 'Command Center empty', '/command/webapp/index.html', {
      waitFor: textIncludes('No camps are reporting', 'Register the first relief camp')
    })).close()

    await seed()

    const cc = await open(browser, 'Command Center', '/command/webapp/index.html', {
      waitFor: textIncludes('Test Camp Alpha', 'Test Camp Charlie', 'Camps with Critical Gaps')
    })
    const order = await cc.evaluate(() =>
      ['Test Camp Alpha', 'Test Camp Bravo', 'Test Camp Charlie'].map(n => document.body.innerText.indexOf(n))
    )
    check(order[0] < order[2], 'Heatmap lists the camp in the worst state first')
    const states = await cc.evaluate(() => {
      const text = document.body.innerText
      const row = name => [...document.querySelectorAll('[id$="--heatmap"] .sapMListTblRow')].find(r => r.innerText.includes(name))?.innerText || ''
      return {
        legend: ['Not counted: stock never counted', 'Not assessed: no people recorded'].every(t => text.includes(t)),
        kpi: text.includes('1 not assessed'),
        subtitle: /1 not assessed · 8 indicators not counted/.test(text),
        delta: row('Test Camp Delta'), echo: row('Test Camp Echo'),
        deltaPercent: /\d+\s*%/.test(row('Test Camp Delta')), echoPercent: /\d+\s*%/.test(row('Test Camp Echo'))
      }
    })
    check(states.legend, 'Heatmap legend explains Not counted and Not assessed')
    const thresholds = await cc.evaluate(() => {
      const text = document.body.innerText
      const shortfall = sap.ui.core.Element.getElementById('container-reliefgrid.command---main--gaps').getColumns()[3].getHeader().getText()
      return { critical: text.includes('Critical: under 2 days or 50 %'), warning: text.includes('Needs attention: under 5 days or 90 %'), shortfall }
    })
    check(thresholds.critical && thresholds.warning && thresholds.shortfall === 'Shortfall for 7 Days',
      `Command Center shows the thresholds and target from the planning settings (${thresholds.shortfall})`)
    check(states.kpi && states.subtitle, 'Command Center KPIs report the camp not assessed and the indicators not counted')
    check(states.delta.includes('Not assessed') && !states.deltaPercent, 'Camp without people shows Not assessed, with no percentage')
    check((states.echo.match(/Not counted/g) || []).length >= 8 && !states.echoPercent, 'Camp never counted shows Not counted, with no percentage')

    await cc.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('transit'))
    await cc.waitForFunction(textIncludes('Test Donor Org'), { timeout: 20000 }).then(
      () => check(true, 'Deliveries in transit lists the pledge'),
      () => check(false, 'Deliveries in transit lists the pledge')
    )
    const transitQuantity = await cc.evaluate(() =>
      document.querySelector('[id$="--transit"] .sapMObjectNumberText')?.innerText
    )
    check(/^\d[\d,]*$/.test((transitQuantity || '').trim()), `Pledged quantity is shown (${transitQuantity})`)
    if (SHOTS) await cc.screenshot({ path: path.join(SHOTS, 'command-center-transit.png') })

    // The coordinator confirms the delivery; stock at the camp goes up.
    const [inTransit] = (await api('GET', `/odata/v4/relief/Pledges?$filter=status_code eq 'PLEDGED'&$expand=request`)).value
    const stockBefore = await api('GET',
      `/odata/v4/relief/Stock?$filter=camp_ID eq ${inTransit.request.camp_ID} and standard_code eq '${inTransit.request.standard_code}'`)
    const clickButton = async (page, scope, label) => {
      const handles = await page.$$(`${scope} button`)
      for (const h of handles) if ((await h.evaluate(b => b.innerText.trim())) === label) return h.click()
      throw new Error(`button "${label}" not found`)
    }
    // UX-06: Record Received Quantity, with the received and accepted quantity (ARCH-03)
    await clickButton(cc, '[id$="--transit"]', 'Record Received Quantity')
    await cc.waitForSelector('.sapMDialog .sapMStepInput', { visible: true, timeout: 10000 })
    await new Promise(r => setTimeout(r, 800))
    if (SHOTS) await cc.screenshot({ path: path.join(SHOTS, 'confirm-delivery-dialog.png') })
    await clickButton(cc, '.sapMDialog', 'Record')
    let delivered
    for (let i = 0; i < 20 && delivered?.status_code !== 'DELIVERED'; i++) {
      await new Promise(r => setTimeout(r, 500))
      delivered = await api('GET', `/odata/v4/relief/Pledges(${inTransit.ID})`)
    }
    const stockAfter = await api('GET', `/odata/v4/relief/Stock(${stockBefore.value[0].ID})`)
    check(
      delivered?.status_code === 'DELIVERED' &&
        Number(stockAfter.quantity) === Number(stockBefore.value[0].quantity) + Number(inTransit.quantity),
      'Confirming a delivery adds it to camp stock'
    )
    // The disclaimer links to the methodology page.
    check(await cc.evaluate(() => document.body.innerText.includes('not an official Sphere assessment')), 'Command Center shows the disclaimer')
    await cc.evaluate(() => document.querySelector('[id$="--methodologyLink"]').scrollIntoView())
    await cc.click('[id$="--methodologyLink"]')
    await cc.waitForFunction(() => location.pathname.endsWith('/methodology/webapp/index.html'), { timeout: 10000 }).then(
      () => check(true, 'Command Center links to the methodology page'),
      () => check(false, 'Command Center links to the methodology page')
    )
    await cc.close()

    await open(browser, 'Command Center phone', '/command/webapp/index.html', {
      waitFor: textIncludes('Test Camp Alpha'), width: 390, height: 844
    })

    await open(browser, 'Manage Camps list', '/camps/webapp/index.html', {
      waitFor: textIncludes('Test Camp Alpha', 'Test Camp Bravo', 'Applicable Indicators Met', 'Test Camp Delta', 'Not assessed', 'Not counted', 'Assessed')
    })
    const echo = await api('GET', `/odata/v4/relief/Camps?$filter=name eq 'Test Camp Echo'`)
    await open(browser, 'Manage Camps not-counted camp', `/camps/webapp/index.html#/Camps(ID=${echo.value[0].ID},IsActiveEntity=true)`, {
      waitFor: textIncludes('Stock & Indicator Gaps', 'Water', 'Not counted', 'Status', 'Last Counted')
    })

    const camps = await api('GET', `/odata/v4/relief/Camps?$filter=name eq 'Test Camp Alpha'`)
    await open(browser, 'Manage Camps object page', `/camps/webapp/index.html#/Camps(ID=${camps.value[0].ID},IsActiveEntity=true)`, {
      waitFor: textIncludes('Stock & Indicator Gaps', 'Water', 'Cover', 'days', 'Supply Requests')
    })

    const board = await open(browser, 'Pledge Board', '/pledge/webapp/index.html', {
      waitFor: textIncludes('Test Camp Alpha', 'Still Needed'), user: 'donor'
    })
    check(await board.evaluate(() => !/Test Camp (Delta|Echo)/.test(document.body.innerText)),
      'Pledge Board shows no requests for camps that are not assessed or not counted')
    // A donor pledges through the Fiori elements action dialog.
    await board.click('.sapMListTblRow .sapMRb')
    await board.waitForFunction(
      () => !document.querySelector('[id$="DataFieldForAction::DonorService.pledge"]')?.disabled,
      { timeout: 10000 }
    )
    await board.click('[id$="DataFieldForAction::DonorService.pledge"]')
    await board.waitForSelector('input[id^="APD_::donor-inner"]', { visible: true, timeout: 10000 })
    await new Promise(r => setTimeout(r, 800)) // dialog open animation
    await board.click('input[id="APD_::donor-inner-inner"]')
    await board.type('input[id="APD_::donor-inner-inner"]', 'UI Test Donor')
    // UX-11: the quantity starts at what is still needed; the donor replaces it
    const prefilled = await board.$eval('input[id="APD_::quantity-inner-inner"]', e => e.value)
    check(Number(prefilled.replace(/,/g, '')) > 0, `Pledge dialog starts at the quantity still needed (${prefilled})`)
    await board.click('input[id="APD_::quantity-inner-inner"]')
    await board.$eval('input[id="APD_::quantity-inner-inner"]', e => e.select())
    await board.type('input[id="APD_::quantity-inner-inner"]', '25')
    if (SHOTS) await board.screenshot({ path: path.join(SHOTS, 'pledge-dialog.png') })
    await board.click('[id="fe::APD_::DonorService.pledge::Action::Ok"]')
    const pledged = await (async () => {
      for (let i = 0; i < 20; i++) {
        const { value } = await api('GET', `/odata/v4/donor/Pledges?$filter=donor eq 'UI Test Donor'`, null, 'donor')
        if (value.length) return value[0]
        await new Promise(r => setTimeout(r, 500))
      }
    })()
    check(Number(pledged?.quantity) === 25, 'Pledge dialog records a pledge')
    await board.close()

    const method = await open(browser, 'Methodology', '/methodology/webapp/index.html', {
      waitFor: textIncludes('Methodology and References', 'Indicators at a glance', 'Mosquito nets', 'Planning choices')
    })
    const content = await method.evaluate(() => {
      const ops = sap.ui.core.Element.getElementById('container-reliefgrid.methodology---main--indicators')
      const statuses = [...document.querySelectorAll('.sapMObjStatus')]
      return {
        indicators: ops.getSubSections().map(s => s.getTitle()),
        text: document.body.innerText,
        unlabelledStatuses: statuses.filter(s => !s.innerText.trim()).length,
        statuses: statuses.length
      }
    })
    check(content.indicators.length === 9, `Methodology has one section per indicator (${content.indicators.join(', ')})`)
    for (const needle of [
      'not an official Sphere assessment', 'never a “maximum”', '7.5 litres per person per day', 'kcal per person per day (planning figure)',
      'grams per person per month', 'water containers per household', 'excluding cooking space', '1 per 50 people',
      'people per tap, at 7.5 litres per minute', 'Not a Sphere figure', 'Sphere does not prescribe a ratio',
      'None of them is a Sphere standard', 'ReliefGrid planning choice', 'Current planning settings', 'These are the shipped default values',
      'Adjustable planning setting', 'Under 2 days of supply', 'Under 90 % of the reference requirement', 'Fourth edition, 2018', 'eeb7e680c296e15389ca8a1e5882a3796f23cbba31cfb21dd4661332c4c8cf63',
      'expected in Q4 2028', 'spherestandards.org/handbook/handbook-editions/', 'spherestandards.org/handbook-revision-2026-2028/faqs/'
    ]) check(content.text.includes(needle), `Methodology shows "${needle.slice(0, 50)}"`)
    check(content.statuses > 20 && content.unlabelledStatuses === 0, `Every status label has text (${content.statuses})`)

    // Keyboard: Enter on a summary row moves to that indicator.
    const rows = await method.$$('[id$="--summary"] tr.sapMLIB')
    check(rows.length === 9, `Summary table lists nine indicators (${rows.length})`)
    await rows[8].focus()
    await method.keyboard.press('Enter')
    await method.waitForFunction(() => {
      const ops = sap.ui.core.Element.getElementById('container-reliefgrid.methodology---main--indicators')
      const net = ops.getSubSections()[8].getDomRef().getBoundingClientRect()
      return net.top >= 0 && net.top < window.innerHeight / 2
    }, { timeout: 10000 }).then(
      () => check(true, 'Enter on a summary row scrolls to that indicator'),
      () => check(false, 'Enter on a summary row scrolls to that indicator')
    )
    if (SHOTS) await method.screenshot({ path: path.join(SHOTS, 'methodology-net.png') })
    await method.close()

    await (await open(browser, 'Methodology phone', '/methodology/webapp/index.html', {
      waitFor: textIncludes('Methodology and References', 'Mosquito nets'), width: 390, height: 844
    })).close()

    // SEC-06: the Pledge Board tile is for donors; an Administrator without the Donor role does not get it
    const pad = await open(browser, 'Launchpad', '/index.html', {
      waitFor: textIncludes('Relief Command Center', 'Manage Relief Camps', 'Methodology and References')
    })
    check(!(await pad.evaluate(() => document.body.innerText.includes('Pledge Board'))), 'Launchpad: the Pledge Board is offered only to donors')
    await pad.close()

    // Every tile's intent resolves inside the launchpad, including a deep link to one camp.
    const intents = [
      ['ReliefNetwork-monitor', 'Indicator Heatmap'],
      ['ReliefMethodology-display', 'Planning choices'],
      ['ReliefCamp-manage', 'Relief Camps'],
      ['SupplyRequest-pledge', 'Open Needs'],
      [`ReliefCamp-manage&/Camps(ID=${camps.value[0].ID},IsActiveEntity=true)`, 'Stock & Indicator Gaps']
    ]
    for (const [hash, expected] of intents) {
      const name = `Launchpad #${hash.split('&')[0]}${hash.includes('&') ? ' (camp page)' : ''}`
      const user = hash.startsWith('SupplyRequest') ? 'donor' : 'admin'
      await (await open(browser, name, `/index.html#${hash}`, { waitFor: textIncludes(expected), user })).close()
    }

    // Raise Requests feedback: skipped lines make the result partial, and a failure never reads as success.
    const R = '/odata/v4/relief'
    const dialogText = page => page.evaluate(() =>
      [...document.querySelectorAll('.sapMDialog')].filter(d => !/Review and Publish Requests/.test(d.innerText)).map(d => d.innerText.replace(/\s+/g, ' ')).join(' || '))
    // The text of the dialog that matches; the closing parameter dialog may still be in the page.
    const waitForDialog = async (page, pattern) => {
      for (let i = 0; i < 40; i++) {
        const match = (await dialogText(page)).split(' || ').find(t => pattern.test(t))
        if (match) return match
        await new Promise(r => setTimeout(r, 250))
      }
      return dialogText(page)
    }
    // UX-05: Review and Publish Requests shows the preview first; Publish raises exactly what it shows
    // Opening the camp page can, rarely, race with the app reloading itself; then Puppeteer reports a detached
    // frame. Only that is retried, once, on a fresh page; any check failure still counts.
    const raiseOnCampPage = async (name, campID, options = {}) => {
      try {
        return await raiseOnCampPageOnce(name, campID, options)
      } catch (e) {
        if (!/detached Frame/.test(e.message)) throw e
        console.log(`      (${name}: the page reloaded while it was read; opened again)`)
        return raiseOnCampPageOnce(name, campID, options)
      }
    }
    const raiseOnCampPageOnce = async (name, campID, { publish = true } = {}) => {
      const page = await open(browser, name, `/camps/webapp/index.html#/Camps(ID=${campID},IsActiveEntity=true)`, {
        waitFor: textIncludes('Review and Publish Requests', 'Stock & Indicator Gaps')
      })
      await clickButton(page, 'body', 'Review and Publish Requests')
      await page.waitForSelector('.sapMDialog .sapMStepInput input', { visible: true, timeout: 10000 })
      await page.waitForFunction(() => /Publish [1-9]|Publish 1 Request|Nothing to request/.test(document.querySelector('.sapMDialog')?.innerText || ''), { timeout: 20000 })
      await new Promise(r => setTimeout(r, 1500))
      lastTargetDefault = await page.evaluate(() => document.querySelector('.sapMDialog .sapMStepInput input')?.value)
      lastPreview = await page.evaluate(() => document.querySelector('.sapMDialog').innerText.replace(/\s+/g, ' '))
      lastPublishEnabled = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.sapMDialog button')].find(x => /^Publish/.test(x.innerText.trim()))
        return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
      })
      if (publish && lastPublishEnabled) {
        for (const h of await page.$$('.sapMDialog button'))
          if (/^Publish/.test(await h.evaluate(b => b.innerText.trim()))) { await h.click(); break }
      }
      return page
    }
    let lastTargetDefault, lastPreview, lastPublishEnabled

    const echoPage = await raiseOnCampPage('Manage Camps raise on never-counted camp', echo.value[0].ID)
    check(lastTargetDefault === '7', `Manage Camps: the request preview starts at the stored target (${lastTargetDefault})`)
    await echoPage.waitForFunction(() => /Skipped: 8 indicators never counted/.test(document.querySelector('.sapMDialog')?.innerText || ''), { timeout: 10000 }).catch(() => {})
    const echoText = await echoPage.evaluate(() => document.querySelector('.sapMDialog').innerText.replace(/\s+/g, ' '))
    check(!lastPublishEnabled && /Nothing to request/.test(echoText) &&
      /Skipped: 8 indicators never counted, so no confirmed shortage can be calculated\. Record stock counts first/.test(echoText) &&
      (await api('GET', `${R}/Camps(ID=${echo.value[0].ID},IsActiveEntity=true)/requests`)).value.length === 0,
      `Manage Camps: nothing can be published from uncounted stock, and the preview says why and what to do next (${echoText.slice(0, 60)}…)`)
    if (SHOTS) await echoPage.screenshot({ path: path.join(SHOTS, 'raise-requests-not-counted.png') })
    await echoPage.close()

    // Test camps for the Raise Requests checks (synthetic, in-memory only).
    const makeCamp = async (name, counts) => {
      const d = await api('POST', `${R}/Camps`, {})
      const key = `${R}/Camps(ID=${d.ID},IsActiveEntity=false)`
      await api('PATCH', key, { name, district: 'District T', region: 'Region 3', hazard_code: 'FLOOD', headcount: 120 })
      await api('POST', `${key}/ReliefService.draftActivate`, {})
      const lines = Object.fromEntries((await api('GET', `${R}/Camps(ID=${d.ID},IsActiveEntity=true)/stock`)).value.map(l => [l.standard_code, l]))
      for (const [code, quantity] of Object.entries(counts)) await api('POST', `${R}/Stock(${lines[code].ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(code) ? { functionalUnits: quantity } : {}) })
      return { ID: d.ID, lines }
    }
    const allZero = { WATER: 0, FOOD: 0, SOAP: 0, LAUNDRY: 0, SHELTER: 0, TOILET: 0, TAP: 0, CONTAINER: 0, NET: 0 }
    // the request preview (UX-05) is not feedback: its own text mentions publishing and skipped lines
    const feedbackText = page => page.evaluate(() =>
      [...document.querySelectorAll('.sapMMessageToast, .sapMDialog')].filter(d => !/Review and Publish Requests/.test(d.innerText))
        .map(d => d.innerText.replace(/\s+/g, ' ')).join(' || '))
    const waitForFeedback = async (page, pattern) => {
      for (let i = 0; i < 40; i++) {
        const match = (await feedbackText(page)).split(' || ').find(t => pattern.test(t))
        if (match) return match
        await new Promise(r => setTimeout(r, 250))
      }
      return feedbackText(page)
    }
    const openGaps = async (name, campName) => {
      const page = await open(browser, name, '/command/webapp/index.html', { waitFor: textIncludes(campName) })
      await page.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('gaps'))
      await page.waitForFunction(n => [...document.querySelectorAll('[id$="--gaps"] .sapMGHLI')].some(g => g.innerText.includes(n)), { timeout: 20000 }, campName)
      return page
    }
    // A real click: UI5 ignores synthetic DOM clicks.
    // UX-05: Review Requests opens the preview; Publish (when there is something to publish) raises what it shows.
    // Returns the preview text, or null when no preview opened (for example because the camp was closed).
    const clickRaiseFor = async (page, campName, { publish = true } = {}) => {
      const button = await page.evaluateHandle(n => {
        const group = [...document.querySelectorAll('[id$="--gaps"] .sapMGHLI')].find(g => g.innerText.includes(n))
        return group.nextElementSibling.querySelector('button')
      }, campName)
      await button.click()
      const opened = await page.waitForFunction(() => {
        const d = [...document.querySelectorAll('.sapMDialog')].find(x => /Review and Publish Requests/.test(x.innerText))
        return d && /Publish [1-9]|Publish 1 Request|Nothing to request/.test(d.innerText)
      }, { timeout: 15000 }).then(() => true, () => false)
      if (!opened) return null
      await new Promise(r => setTimeout(r, 1200))
      const text = await page.evaluate(() => ([...document.querySelectorAll('.sapMDialog')].find(x => /Review and Publish Requests/.test(x.innerText))?.innerText || '').replace(/\s+/g, ' '))
      for (const h of await page.$$('.sapMDialog button')) {
        const label = await h.evaluate(b => b.innerText.trim())
        const enabled = await h.evaluate(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
        if (publish && enabled && /^Publish/.test(label)) { await h.click(); return text }
      }
      for (const h of await page.$$('.sapMDialog button')) if ((await h.evaluate(b => b.innerText.trim())) === 'Cancel') { await h.click(); break }
      return text
    }

    // Regression: the warning shows what this operation skipped, even when the camp changes before the
    // result is displayed. The Raise Requests batch is forwarded by the test, three more lines are counted
    // (the camp's not-counted figure drops from 7 to 4), and only then is the original response released.
    const foxtrot = await makeCamp('Test Camp Foxtrot', { FOOD: 0, TOILET: 6 })
    const ccRaise = await openGaps('Command Center raise with the camp changing meanwhile', 'Test Camp Foxtrot')
    await ccRaise.setRequestInterception(true)
    let held = false
    ccRaise.on('request', async request => {
      if (request.method() !== 'POST' || !/raiseRequests/.test(request.postData() || '')) return request.continue()
      held = true
      const res = await fetch(request.url(), { method: 'POST', body: request.postData(),
        headers: { ...request.headers(), authorization: 'Basic ' + Buffer.from('admin:test').toString('base64') } })
      const body = await res.text()
      for (const code of ['SOAP', 'LAUNDRY', 'SHELTER'])
        await api('POST', `${R}/Stock(${foxtrot.lines[code].ID})/ReliefService.recordCount`, { quantity: 5000 })
      const headers = Object.fromEntries([...res.headers].filter(([k]) => !/^(content-length|content-encoding|transfer-encoding)$/i.test(k)))
      request.respond({ status: res.status, headers, body })
    })
    await clickRaiseFor(ccRaise, 'Test Camp Foxtrot')
    const ccText = await waitForFeedback(ccRaise, /Skipped/)
    const foxtrotNow = await api('GET', `${R}/Camps(ID=${foxtrot.ID},IsActiveEntity=true)/health`)
    const foxtrotRequests = (await api('GET', `${R}/Camps(ID=${foxtrot.ID},IsActiveEntity=true)/requests`)).value
    check(held && foxtrotNow.notCountedIndicators === 3 && ccText.includes('Requests partly raised') &&
      ccText.includes('Supply requests raised for Test Camp Foxtrot: 1.') && ccText.includes('Skipped: 6 indicators never counted') &&
      !ccText.includes('Skipped: 3') && foxtrotRequests.map(r => r.standard_code).join() === 'FOOD',
      `Command Center: the partial-result warning shows the operation's own counts (1 raised, 6 skipped) although the camp now has ${foxtrotNow.notCountedIndicators} not counted`)
    if (SHOTS) await ccRaise.screenshot({ path: path.join(SHOTS, 'raise-requests-command-center-partial.png') })
    await ccRaise.close()

    // Command Center: normal success, then zero requests, then a failure.
    await makeCamp('Test Camp Hotel', allZero)
    const ccOk = await openGaps('Command Center raise: success, nothing new, failure', 'Test Camp Hotel')
    await clickRaiseFor(ccOk, 'Test Camp Hotel')
    const okText = await waitForFeedback(ccOk, /published to donors/)
    check(okText.trim() === '8 requests published to donors', `Command Center: a full success shows a success toast (${okText})`)
    await ccOk.waitForFunction(() => !document.querySelector('.sapMMessageToast'), { timeout: 15000 }).catch(() => {})
    const noneText = await clickRaiseFor(ccOk, 'Test Camp Hotel')
    check(/Nothing to request: every counted, assessed line is covered/.test(noneText || '') && !/never counted/.test(noneText || ''),
      `Command Center: with nothing new to request, the preview says so and nothing can be published (${(noneText || '').slice(0, 80)})`)
    await new Promise(r => setTimeout(r, 800))
    const hotel = await api('GET', `${R}/Camps?$filter=name eq 'Test Camp Hotel'`)
    await api('POST', `${R}/Camps(ID=${hotel.value[0].ID},IsActiveEntity=true)/ReliefService.closeCamp`, {})
    await ccOk.waitForFunction(() => !document.querySelector('.sapMMessageToast'), { timeout: 15000 }).catch(() => {})
    await clickRaiseFor(ccOk, 'Test Camp Hotel')
    const ccFail = await waitForFeedback(ccOk, /closed/)
    check(/^Error/.test(ccFail.trim()) && ccFail.includes('This camp is closed') && !/published|No new requests/.test(ccFail),
      'Command Center: a failed raise shows an error and no success message')
    await ccOk.close()

    // Manage Camps: normal success, then zero requests.
    const india = await makeCamp('Test Camp India', allZero)
    const fePage = await raiseOnCampPage('Manage Camps raise: success, then nothing new', india.ID)
    const feOk = await waitForFeedback(fePage, /published to donors/)
    check(feOk.includes('Supply requests raised and published to donors: 8.') && !/Warning|Skipped/.test(feOk),
      `Manage Camps: a full success shows the number raised and no warning (${feOk.slice(0, 70)})`)
    await fePage.close()
    const feAgain = await raiseOnCampPage('Manage Camps raise again: nothing new', india.ID)
    check(!lastPublishEnabled && /Nothing to request: every counted, assessed line is covered/.test(lastPreview) && !/never counted/.test(lastPreview),
      `Manage Camps: with nothing new to request, the preview says so and nothing can be published (${(lastPreview || '').slice(0, 70)})`)
    await feAgain.close()

    // Manage Camps failure: the camp is closed after the page was opened.
    const failPage = await open(browser, 'Manage Camps raise on a camp closed meanwhile', `/camps/webapp/index.html#/Camps(ID=${foxtrot.ID},IsActiveEntity=true)`, {
      waitFor: textIncludes('Review and Publish Requests', 'Stock & Indicator Gaps')
    })
    await api('POST', `${R}/Camps(ID=${foxtrot.ID},IsActiveEntity=true)/ReliefService.closeCamp`, {})
    await clickButton(failPage, 'body', 'Review and Publish Requests')
    const failText = await waitForDialog(failPage, /closed/)
    check(/^Error/.test(failText.trim()) && failText.includes('This camp is closed') && !/raised and published|Information/.test(failText),
      'Manage Camps: a failed raise shows an error and no success message')
    await failPage.close()

    // An administrator changes the planning settings in the methodology page; every view follows at once.
    const admin = await open(browser, 'Methodology planning settings change', '/methodology/webapp/index.html', {
      waitFor: textIncludes('Current planning settings', 'Change planning settings')
    })
    await admin.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.methodology---main--page')
      .scrollToSection('container-reliefgrid.methodology---main--planning', 0))
    await new Promise(r => setTimeout(r, 800))
    await clickButton(admin, 'body', 'Change planning settings')
    await admin.waitForSelector('.sapMDialog textarea', { visible: true, timeout: 10000 })
    await new Promise(r => setTimeout(r, 600))
    const impactNote = await dialogText(admin)
    const setStep = async (index, value) => {
      const inputs = await admin.$$('.sapMDialog .sapMStepInput input')
      // clear the formatted value ("2.00") with the keyboard, as a user would, then type
      await inputs[index].click()
      await admin.keyboard.press('End')
      for (let i = 0; i < 10; i++) await admin.keyboard.press('Backspace')
      await inputs[index].type(String(value))
      await admin.keyboard.press('Tab')
    }
    const statesBefore = (await api('GET', `${R}/Stock?$select=ID,assessment&$expand=camp($select=name,status_code),standard($select=code,name)&$top=5000`)).value
    await setStep(0, '3')
    await setStep(4, '9')
    await clickButton(admin, '.sapMDialog', 'Save and apply')
    await new Promise(r => setTimeout(r, 500))
    const noReason = await admin.evaluate(() =>
      sap.ui.core.Element.closestTo(document.querySelector('.sapMDialog .sapMTextArea')).getValueState() === 'Error')
    await admin.click('.sapMDialog textarea')
    await admin.type('.sapMDialog textarea', 'Smoke test: earlier escalation and a longer target')
    await clickButton(admin, '.sapMDialog', 'Save and apply')
    const saved = await waitForFeedback(admin, /Planning settings saved/)
    const current = await api('GET', `${R}/PlanningSettings('CURRENT')`)
    const history = (await api('GET', `${R}/PlanningSettingsChanges?$orderby=changedAt desc`)).value
    check(/Saving applies immediately.*Critical Gaps list, Camps with Critical Gaps.*not Sphere requirements/.test(impactNote),
      'Methodology: the change dialog warns that camp classifications and Command Center indicators can change')
    check(noReason, 'Methodology: a change without a reason is not sent; the reason field is marked')
    check(/Indicator lines that changed state: \d+, in \d+ camps/.test(saved) &&
      Number(current.criticalDays) === 3 && Number(current.targetDays) === 9 && Number(current.warningDays) === 5 &&
      history[0].reason === 'Smoke test: earlier escalation and a longer target' && Number(history[0].previousCriticalDays) === 2,
      `Methodology: an administrator change is saved, logged and its impact reported (${saved.slice(0, 80)})`)
    await new Promise(r => setTimeout(r, 1500))
    const afterText = await admin.evaluate(() => document.body.innerText)
    check(afterText.includes('Under 3 days of supply') && afterText.includes('Change history') && afterText.includes('Smoke test: earlier escalation'),
      'Methodology: the page shows the new values and the change history')
    if (SHOTS) await admin.screenshot({ path: path.join(SHOTS, 'methodology-settings-changed.png') })
    await admin.close()

    // A line whose state the change moved: the Command Center and Manage Camps must now agree on it.
    const statesAfter = Object.fromEntries((await api('GET', `${R}/Stock?$select=ID,assessment&$top=5000`)).value.map(l => [l.ID, l.assessment]))
    const moved = statesBefore.find(l => l.camp.status_code === 'ACTIVE' && statesAfter[l.ID] !== l.assessment)
    check(!!moved, `the change reclassified at least one line (${moved ? `${moved.camp.name} ${moved.standard.name}: ${moved.assessment} -> ${statesAfter[moved.ID]}` : 'none'})`)

    const ccAfter = await open(browser, 'Command Center after a settings change', '/command/webapp/index.html', {
      waitFor: textIncludes('Critical: under 3 days or 50 %')
    })
    const shortfallAfter = await ccAfter.evaluate(() =>
      sap.ui.core.Element.getElementById('container-reliefgrid.command---main--gaps').getColumns()[3].getHeader().getText())
    check(shortfallAfter === 'Shortfall for 9 Days', `Command Center follows the new settings at once (${shortfallAfter})`)
    const STATE = { CRITICAL: 'Error', ATTENTION: 'Warning', MET: 'Success' }
    const ccCell = moved && await ccAfter.evaluate((camp, code) => {
      const row = sap.ui.core.Element.getElementById('container-reliefgrid.command---main').getModel('view').getProperty('/camps').find(r => r.name === camp)
      return row && row.cells[code].state
    }, moved.camp.name, moved.standard.code)
    check(moved && ccCell === STATE[statesAfter[moved.ID]], `Command Center heatmap shows the new state for that line (${ccCell})`)
    await ccAfter.close()

    const movedCamp = moved && (await api('GET', `${R}/Camps?$filter=name eq '${moved.camp.name}' and IsActiveEntity eq true`)).value[0]
    const LABEL = { CRITICAL: 'Critical', ATTENTION: 'Needs attention', MET: 'Met' }
    const fe = await open(browser, 'Manage Camps after a settings change', `/camps/webapp/index.html#/Camps(ID=${movedCamp.ID},IsActiveEntity=true)`, {
      waitFor: textIncludes('Stock & Indicator Gaps', moved.standard.name)
    })
    const feStatus = await fe.evaluate(name => {
      const row = [...document.querySelectorAll('.sapMListTblRow')].find(r => r.querySelector('td')?.innerText.trim() === name ||
        [...r.querySelectorAll('td')].some(td => td.innerText.trim() === name))
      return row ? row.innerText.replace(/\s+/g, ' ') : ''
    }, moved.standard.name)
    check(feStatus.includes(LABEL[statesAfter[moved.ID]]), `Manage Camps shows the same state for that line (${feStatus.slice(0, 60)})`)
    await fe.close()

    // With no target given, the Command Center's Raise Requests uses the stored target of 9 days.
    const juliet = await makeCamp('Test Camp Juliet', allZero)
    const ccTarget = await openGaps('Command Center raise with the stored target', 'Test Camp Juliet')
    await clickRaiseFor(ccTarget, 'Test Camp Juliet')
    await waitForFeedback(ccTarget, /published to donors/)
    const julietWater = (await api('GET', `${R}/Camps(ID=${juliet.ID},IsActiveEntity=true)/requests?$filter=standard_code eq 'WATER'`)).value[0]
    check(Number(julietWater?.quantity) === 120 * 15 * 9, `Command Center raise uses the stored 9-day target (${julietWater?.quantity} L)`)
    await ccTarget.close()
    const followPage = await raiseOnCampPage('Manage Camps after a settings change', echo.value[0].ID, { publish: false })
    check(lastTargetDefault === '9', `Manage Camps: the request preview starts at the new target (${lastTargetDefault})`)
    await followPage.close()

    // ------------------------------------------------------------------
    // B4.1: applicability decisions, approval, request review (real users)
    // ------------------------------------------------------------------
    // decision actions carry the decision's ETag as If-Match, as UI5 sends it
    const approveAs = async (ID, user) => {
      const d = await api('GET', `${R}/CampDecisions(${ID})`)
      return api('POST', `${R}/CampDecisions(${ID})/ReliefService.approve`, { version: d.version }, user, { 'if-match': d['@odata.etag'] })
    }
    const campOf = async name => (await api('GET', `${R}/Camps?$filter=name eq '${name}' and IsActiveEntity eq true`)).value[0].ID
    const alphaID = await campOf('Test Camp Alpha')
    const decisionsOf = async (campID, filter) => (await api('GET', `${R}/CampDecisions?$filter=camp_ID eq ${campID}${filter ? ' and ' + filter : ''}&$orderby=createdAt desc`)).value
    const typeInto = async (page, id, text) => {
      await page.click(`[id="${id}"] input, [id="${id}"] textarea`)
      await page.keyboard.type(text)
      await page.keyboard.press('Tab')
      await new Promise(r => setTimeout(r, 400))
    }
    const uiDate = (page, days) => page.evaluate(d => sap.ui.core.format.DateFormat.getDateInstance({ style: 'medium' }).format(new Date(Date.now() + d * 864e5)), days)
    const buttonState = (page, label) => page.evaluate(l => {
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === l && x.offsetParent !== null)
      return b ? (b.disabled || b.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled') : 'absent'
    }, label)

    // A coordinator proposes through the Fiori dialog; a missing source for Not applicable is refused with a clear message.
    const coordPage = await open(browser, 'Manage Camps applicability proposal (coordinator)', `/camps/webapp/index.html#/Camps(ID=${alphaID},IsActiveEntity=true)`, {
      waitFor: textIncludes('Propose Applicability Decision', 'Applicability Decisions', 'Applicability not decided'), user: 'coordinator'
    })
    await clickButton(coordPage, 'body', 'Propose Applicability Decision')
    await coordPage.waitForSelector('[id="APD_::reason"]', { visible: true, timeout: 10000 })
    await new Promise(r => setTimeout(r, 800))
    await typeInto(coordPage, 'APD_::standard', 'Mosquito nets')
    await typeInto(coordPage, 'APD_::applicability', 'Not applicable')
    await typeInto(coordPage, 'APD_::reason', 'No malaria transmission in this district')
    await typeInto(coordPage, 'APD_::reviewDate', await uiDate(coordPage, 90))
    await clickButton(coordPage, '.sapMDialog', 'Propose Applicability Decision')
    const noSource = await waitForFeedback(coordPage, /supporting source/)
    check(/supporting source or reference/.test(noSource) && (await decisionsOf(alphaID)).length === 0,
      'Manage Camps: Not applicable without a source is refused with an explanation, and nothing is saved')
    await coordPage.close()

    const proposePage = await open(browser, 'Manage Camps applicability proposal submitted', `/camps/webapp/index.html#/Camps(ID=${alphaID},IsActiveEntity=true)`, {
      waitFor: textIncludes('Propose Applicability Decision'), user: 'coordinator'
    })
    await clickButton(proposePage, 'body', 'Propose Applicability Decision')
    await proposePage.waitForSelector('[id="APD_::reason"]', { visible: true, timeout: 10000 })
    await new Promise(r => setTimeout(r, 800))
    await typeInto(proposePage, 'APD_::standard', 'Mosquito nets')
    await typeInto(proposePage, 'APD_::applicability', 'Not applicable')
    await typeInto(proposePage, 'APD_::reason', 'No malaria transmission in this district')
    await typeInto(proposePage, 'APD_::source', 'District health office letter 14/2026')
    await typeInto(proposePage, 'APD_::reviewDate', await uiDate(proposePage, 90))
    if (SHOTS) await proposePage.screenshot({ path: path.join(SHOTS, 'decision-propose-dialog.png') })
    await clickButton(proposePage, '.sapMDialog', 'Propose Applicability Decision')
    const submitted = await waitForFeedback(proposePage, /proposal was submitted/)
    const [pending] = await decisionsOf(alphaID, "status_code eq 'PENDING'")
    check(/Administrator other than you must approve/.test(submitted) && pending?.proposedBy === 'coordinator' && pending.applicable === false,
      'Manage Camps: a coordinator submits a proposal and is told another person approves it')
    await proposePage.close()

    // The coordinator cannot approve; another Administrator approves after seeing the proposal, its impact and history.
    const decisionRoute = (campID, ID) => `/camps/webapp/index.html#/Camps(ID=${campID},IsActiveEntity=true)/decisions(${ID})`
    const coordView = await open(browser, 'Decision page (coordinator)', decisionRoute(alphaID, pending.ID), {
      waitFor: textIncludes('Pending approval', 'Previous Value', 'Open Requests Affected'), user: 'coordinator'
    })
    check(await buttonState(coordView, 'Approve') !== 'enabled', 'Decision page: a coordinator cannot approve')
    await coordView.close()

    const adminView = await open(browser, 'Decision page (administrator)', decisionRoute(alphaID, pending.ID), {
      waitFor: textIncludes('Pending approval', 'Not applicable', 'None (not decided)', 'District health office letter 14/2026', 'coordinator')
    })
    check(await buttonState(adminView, 'Approve') === 'enabled', 'Decision page: another Administrator can approve')
    if (SHOTS) await adminView.screenshot({ path: path.join(SHOTS, 'decision-approval.png') })
    await clickButton(adminView, 'body', 'Approve')
    await adminView.waitForSelector('.sapMDialog', { visible: true, timeout: 10000 })
    await new Promise(r => setTimeout(r, 600))
    const confirmLabels = await adminView.evaluate(() => [...document.querySelectorAll('.sapMDialog button')].map(b => b.innerText.trim()).filter(Boolean))
    await clickButton(adminView, '.sapMDialog', confirmLabels.find(l => l !== 'Cancel'))
    const approved = await waitForFeedback(adminView, /Approved and in force/)
    const alphaNet = (await api('GET', `${R}/Stock?$filter=camp_ID eq ${alphaID} and standard_code eq 'NET'`)).value[0]
    check(/Approved and in force/.test(approved) && alphaNet.assessment === 'NOT_APPLICABLE' &&
      (await api('GET', `${R}/CampDecisions(${pending.ID})`)).approvedBy === 'admin',
      `Decision page: approval takes effect at once and re-assesses the camp (${approved.slice(0, 120)} | NET ${alphaNet.assessment} | buttons ${confirmLabels})`)
    await adminView.close()

    // An Administrator's own proposal: the page explains that someone else must approve it.
    const bravoID = await campOf('Test Camp Bravo')
    const own = await api('POST', `${R}/Camps(ID=${bravoID},IsActiveEntity=true)/ReliefService.proposeApplicability`,
      { standard: 'NET', applicability: 'APPLICABLE', reason: 'Malaria season', reviewDate: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10) }, 'admin')
    const ownView = await open(browser, 'Decision page (own proposal)', decisionRoute(bravoID, own.ID), {
      waitFor: textIncludes('You proposed this decision, so another Administrator must approve it.')
    })
    check(await buttonState(ownView, 'Approve') !== 'enabled', 'Decision page: an Administrator cannot approve their own proposal, and is told why')
    await ownView.close()
    await approveAs(own.ID, 'admin2')
    const bravoNet = (await api('GET', `${R}/Stock?$filter=camp_ID eq ${bravoID} and standard_code eq 'NET'`)).value[0]
    check(bravoNet.assessment === 'NO_REQUIREMENT', 'Applicable alone: mosquito nets show Requirement not established')

    // A request flagged by a decision is reviewed through its own dialog; nothing is cancelled automatically.
    const charlieID = await campOf('Test Camp Charlie')
    const charlieWater = (await api('GET', `${R}/Camps(ID=${charlieID},IsActiveEntity=true)/requests?$filter=standard_code eq 'WATER'`)).value[0]
    const w = await api('POST', `${R}/Camps(ID=${charlieID},IsActiveEntity=true)/ReliefService.proposeApplicability`,
      { standard: 'WATER', applicability: 'NOT_APPLICABLE', reason: 'Piped municipal supply', source: 'Water utility confirmation',
        reviewDate: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) }, 'coordinator')
    await approveAs(w.ID, 'admin2')
    const flaggedReq = await api('GET', `${R}/Requests(${charlieWater.ID})`)
    check(flaggedReq.review_code === 'PENDING' && flaggedReq.status_code === charlieWater.status_code, 'The open water request is flagged for review, not cancelled')
    const reqPage = await open(browser, 'Request review (coordinator)', `/camps/webapp/index.html#/Camps(ID=${charlieID},IsActiveEntity=true)/requests(${charlieWater.ID})`, {
      waitFor: textIncludes('Review needed', 'Resolve Review'), user: 'coordinator'
    })
    await clickButton(reqPage, 'body', 'Resolve Review')
    await reqPage.waitForSelector('[id="APD_::resolution"]', { visible: true, timeout: 10000 })
    await new Promise(r => setTimeout(r, 800))
    await typeInto(reqPage, 'APD_::resolution', 'Keep')
    await typeInto(reqPage, 'APD_::reason', 'Keep until the utility supply is confirmed for a week')
    await clickButton(reqPage, '.sapMDialog', 'Resolve Review')
    await waitForFeedback(reqPage, /request was kept/)
    const resolved = await api('GET', `${R}/Requests(${charlieWater.ID})?$expand=currentReview`)
    check(resolved.review_code === 'KEPT' && resolved.currentReview.resolvedBy === 'coordinator' && resolved.status_code === charlieWater.status_code,
      `Request page: the coordinator resolves the review with a reason, and the request keeps its status (${resolved.review_code}, ${resolved.currentReview?.resolvedBy}, ${resolved.status_code} vs ${charlieWater.status_code})`)
    await reqPage.close()

    // A scheduled decision is shown as such and does not change today's state.
    const echoID = echo.value[0].ID
    const later = await api('POST', `${R}/Camps(ID=${echoID},IsActiveEntity=true)/ReliefService.proposeApplicability`,
      { standard: 'NET', applicability: 'APPLICABLE', reason: 'Rainy season starts', effectiveFrom: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10),
        reviewDate: new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10) }, 'coordinator')
    await approveAs(later.ID, 'admin')
    await api('POST', `${R}/Camps(ID=${await campOf('Test Camp Juliet')},IsActiveEntity=true)/ReliefService.proposeApplicability`,
      { standard: 'NET', applicability: 'APPLICABLE', reason: 'Outbreak nearby', reviewDate: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) }, 'coordinator')
    const echoPage2 = await open(browser, 'Manage Camps decisions list', `/camps/webapp/index.html#/Camps(ID=${echoID},IsActiveEntity=true)`, {
      waitFor: textIncludes('Applicability Decisions', 'Scheduled from'), user: 'coordinator'
    })
    const echoNet = (await api('GET', `${R}/Stock?$filter=camp_ID eq ${echoID} and standard_code eq 'NET'`)).value[0]
    check(echoNet.assessment === 'NOT_DECIDED', 'A scheduled decision does not change the current state before its date')
    await echoPage2.close()

    // Command Center: the heatmap shows the decided states, and one tab lists what needs a decision.
    const ccB41 = await open(browser, 'Command Center decisions', '/command/webapp/index.html', {
      waitFor: textIncludes('Needs Decision', 'Not decided', 'Not applicable', 'No requirement: no gap is calculated'.slice(0, 0) || 'Not decided, not applicable or no requirement'), user: 'coordinator'
    })
    const cells = await ccB41.evaluate(() => {
      const rows = sap.ui.core.Element.getElementById('container-reliefgrid.command---main').getModel('view').getProperty('/camps')
      const at = (camp, code) => rows.find(r => r.name === camp).cells[code]
      return { alpha: at('Test Camp Alpha', 'NET'), charlie: at('Test Camp Charlie', 'WATER'), bravo: at('Test Camp Bravo', 'NET'), echo: at('Test Camp Echo', 'NET') }
    })
    check(cells.alpha.text === 'Not applicable' && cells.charlie.text === 'Not applicable' && cells.bravo.text === 'No requirement' && cells.echo.text === 'Not decided' &&
      [cells.alpha, cells.charlie, cells.bravo, cells.echo].every(c => c.state === 'None'),
      'Command Center heatmap shows Not applicable, No requirement and Not decided as words, without a colour')
    await ccB41.evaluate(() => sap.ui.core.Element.getElementById('container-reliefgrid.command---main--tabs').setSelectedKey('attention'))
    await ccB41.waitForFunction(() => document.querySelector('[id$="--attention"]')?.innerText.includes('Decision waiting for approval'), { timeout: 20000 })
    const attentionText = await ccB41.evaluate(() => document.querySelector('[id$="--attention"]').innerText)
    check(['Decision waiting for approval', 'Decision takes effect on', 'Applicability not decided', 'Test Camp Juliet', 'Test Camp Echo'].every(t => attentionText.includes(t)),
      'Command Center lists pending, scheduled and undecided items in Needs Decision')
    if (SHOTS) await ccB41.screenshot({ path: path.join(SHOTS, 'command-center-needs-decision.png') })
    const pendingRow = await ccB41.evaluateHandle(() => [...document.querySelectorAll('[id$="--attention"] .sapMListTblRow')].find(r => r.innerText.includes('Decision waiting for approval')))
    await pendingRow.click()
    await ccB41.waitForFunction(() => location.href.includes('/camps/webapp/index.html#') && location.href.includes('/decisions('), { timeout: 20000 }).then(
      () => check(true, 'Needs Decision opens the decision in Manage Camps'),
      () => check(false, 'Needs Decision opens the decision in Manage Camps')
    )
    await ccB41.close()

    // Phone width
    await (await open(browser, 'Decision page phone', decisionRoute(alphaID, pending.ID), {
      waitFor: textIncludes('In force', 'Not applicable'), width: 390, height: 844, user: 'coordinator'
    })).close()
  } finally {
    await browser.close()
    server.kill()
  }
  if (failures.length) {
    console.error(`\n${failures.length} UI check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll UI checks passed')
})().catch(e => {
  console.error(e)
  process.exit(1)
})
