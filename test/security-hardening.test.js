process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const hardening = require('../srv/lib/http-hardening')

const { GET, POST, PATCH, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const visitor = { auth: { username: 'visitor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`
const outcome = p => p.then(r => r, e => e.response ?? e)
const code = res => res.data?.error?.code

async function campWithRequest(name) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount: 1000 }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  const water = (await GET(`${camp(draft.ID)}/stock?$filter=standard_code eq 'WATER'`, coordinator)).data.value[0]
  await POST(`${R}/Stock(${water.ID})/ReliefService.recordCount`, { quantity: 0 }, coordinator)
  await POST(`${camp(draft.ID)}/ReliefService.raiseRequests`, {}, coordinator)
  return (await GET(`${camp(draft.ID)}/requests?$filter=standard_code eq 'WATER'`, coordinator)).data.value[0]
}

describe('Stage D: security hardening', () => {
  describe('SEC-03 security headers', () => {
    const expectHeaders = headers => {
      assert.equal(headers['x-content-type-options'], 'nosniff')
      assert.equal(headers['x-frame-options'], 'SAMEORIGIN')
      assert.match(headers['content-security-policy'], /default-src 'self'/)
      assert.match(headers['content-security-policy'], /script-src [^;]*https:\/\/ui5\.sap\.com/)
      assert.match(headers['content-security-policy'], /frame-ancestors 'self'/)
      assert.ok(headers['referrer-policy'])
    }
    it('are sent with an app page and with an OData response', async () => {
      expectHeaders((await axios.get('/index.html', coordinator)).headers)
      expectHeaders((await GET(`${R}/Standards`, coordinator)).headers)
    })
    it('are sent even with a refusal', async () => {
      expectHeaders((await outcome(GET(`${R}/Camps`, donor))).headers)
    })
    it('add HSTS only for HTTPS', async () => {
      assert.equal((await GET(`${R}/Standards`, coordinator)).headers['strict-transport-security'], undefined)
      const res = await GET(`${R}/Standards`, { ...coordinator, headers: { 'x-forwarded-proto': 'https' } })
      assert.match(res.headers['strict-transport-security'], /max-age=31536000/)
    })
  })

  describe('SEC-07 test pages', () => {
    it('are served only in development and test', () => {
      assert.equal(hardening.testPagesAllowed(['development']), true)
      assert.equal(hardening.testPagesAllowed(['test']), true)
      assert.equal(hardening.testPagesAllowed(['selfhost']), false)
      assert.equal(hardening.testPagesAllowed(['production', 'hana']), false)
    })
    it('are answered with 404 outside development and test', () => {
      const profiles = cds.env.profiles
      try {
        cds.env.profiles = ['selfhost']
        let status = null, passed = false
        hardening.hideTestPages({ path: '/command/webapp/test/unit/unitTests.qunit.html' }, { status: s => ({ end: () => { status = s } }) }, () => { passed = true })
        assert.equal(status, 404)
        assert.equal(passed, false)
        hardening.hideTestPages({ path: '/command/webapp/index.html' }, {}, () => { passed = true })
        assert.equal(passed, true)
      } finally {
        cds.env.profiles = profiles
      }
    })
    it('are removed from the Docker image and the BTP build', () => {
      const root = path.join(__dirname, '..')
      assert.match(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'), /find app -path '\*\/webapp\/test' -type d -prune -exec rm -rf \{\} \+/)
      assert.match(fs.readFileSync(path.join(root, 'mta.yaml'), 'utf8'), /find gen\/srv\/app -path '\*\/webapp\/test' -type d -prune -exec rm -rf \{\} \+/)
    })
  })

  describe('SEC-06 donors are a controlled list', () => {
    it('a signed-in user without the Donor role cannot read or pledge', async () => {
      assert.equal((await outcome(GET(`${D}/Requests`, visitor))).status, 403)
      const r = await campWithRequest('Visitor Camp')
      assert.equal((await outcome(POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Anyone', quantity: 1 }, visitor))).status, 403)
      // the launchpad's access check answers every signed-in user, and only says which roles they hold
      const mine = async who => { const { planner, administrator, donor: d } = (await GET('/odata/v4/access/access()', who)).data; return { planner, administrator, donor: d } }
      assert.deepEqual(await mine(visitor), { planner: false, administrator: false, donor: false })
      assert.deepEqual(await mine(donor), { planner: false, administrator: false, donor: true })
      assert.deepEqual(await mine(admin), { planner: true, administrator: true, donor: false })
      assert.equal((await outcome(axios.get('/odata/v4/access/access()'))).status, 401)
    })
    it('a coordinator without the Donor role is not a donor either', async () => {
      assert.equal((await outcome(GET(`${D}/Requests`, coordinator))).status, 403)
    })
  })

  describe('SEC-05 pledge limits', () => {
    const limits = cds.env.reliefgrid.pledges
    const saved = { ...limits }
    after(() => Object.assign(limits, saved))

    it('one account cannot hold more open pledges than allowed', async () => {
      const r = await campWithRequest('Open Limit Camp')
      const open = Number((await cds.run(SELECT.one.from('reliefgrid.Pledges').columns('count(1) as n').where({ createdBy: 'donor', status_code: { in: ['PLEDGED', 'PARTIAL'] } }))).n)
      Object.assign(limits, { maxOpenPerDonor: open + 2, maxPerHour: 1000 })
      await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Busy Donor', quantity: 1 }, donor)
      await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Busy Donor', quantity: 1 }, donor)
      const third = await outcome(POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Busy Donor', quantity: 1 }, donor))
      assert.equal(third.status, 429)
      assert.equal(code(third), 'PLEDGE_LIMIT_OPEN')
    })

    it('one account cannot pledge faster than allowed', async () => {
      const r = await campWithRequest('Rate Limit Camp')
      const since = new Date(Date.now() - 3600e3).toISOString()
      const recent = Number((await cds.run(SELECT.one.from('reliefgrid.Pledges').columns('count(1) as n').where({ createdBy: 'donor', createdAt: { '>': since } }))).n)
      Object.assign(limits, { maxOpenPerDonor: 100000, maxPerHour: recent + 1 })
      await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Fast Donor', quantity: 1 }, donor)
      const next = await outcome(POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Fast Donor', quantity: 1 }, donor))
      assert.equal(next.status, 429)
      assert.equal(code(next), 'PLEDGE_LIMIT_RATE')
    })

    it('a coordinator can withdraw every pledge in transit of one account, with a reason, and each is audited', async () => {
      Object.assign(limits, { maxOpenPerDonor: 100000, maxPerHour: 100000 })
      const r = await campWithRequest('Withdraw All Camp')
      const { data: p } = await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Blocking Donor', quantity: 5 }, donor)
      await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Blocking Donor', quantity: 5 }, donor)
      assert.equal((await outcome(POST(`${R}/Pledges(${p.ID})/ReliefService.withdrawAllOfDonor`, {}, coordinator))).status, 400)
      assert.equal((await outcome(POST(`${R}/Pledges(${p.ID})/ReliefService.withdrawAllOfDonor`, { reason: 'x' }, donor))).status, 403)
      const { data } = await POST(`${R}/Pledges(${p.ID})/ReliefService.withdrawAllOfDonor`, { reason: 'Account pledged the whole board' }, coordinator)
      assert.ok(data.value >= 2)
      const left = await cds.run(SELECT.from('reliefgrid.Pledges').where({ createdBy: 'donor', status_code: 'PLEDGED' }))
      assert.equal(left.length, 0)
      const events = await cds.run(SELECT.from('reliefgrid.AuditEvents').where({ kind: 'PLEDGE_WITHDRAWN', actor: 'coordinator' }))
      assert.ok(events.filter(e => /all pledges of account donor withdrawn: Account pledged the whole board/.test(e.detail)).length >= 2)
      assert.equal(Number((await GET(`${R}/Requests(${r.ID})`, coordinator)).data.pledgedQuantity), 0)
    })
  })
})

describe('Stage F: the self-hosted container configuration', () => {
  const { execFileSync } = require('node:child_process')
  const dockerEnv = () => {
    const file = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8')
    const block = file.match(/ENV ((?:[A-Z_]+=\S+\s*\\?\s*)+)/)[1]
    return Object.fromEntries([...block.matchAll(/([A-Z_]+)=(\S+)/g)].map(m => [m[1], m[2]]))
  }
  const resolve = env => JSON.parse(execFileSync(process.execPath, ['-e', `
    const cds = require('@sap/cds')
    console.log(JSON.stringify({ profiles: cds.env.profiles, db: cds.env.requires.db?.kind, url: cds.env.requires.db?.credentials?.url,
      auth: cds.env.requires.auth?.kind, log: cds.env.log?.format, testPages: require('./srv/lib/http-hardening').testPagesAllowed() }))`],
  { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).trim().split('\n').at(-1))

  it('resolves to SQLite on the data volume, basic authentication, JSON logs and no test pages', () => {
    const env = dockerEnv()
    assert.equal(env.NODE_ENV, 'production')
    const c = resolve(env)
    assert.ok(c.profiles.includes('selfhost') && c.profiles.includes('production') && !c.profiles.includes('development'))
    assert.equal(c.db, 'sqlite')
    assert.equal(c.url, '/data/reliefgrid.sqlite')
    assert.equal(c.auth, 'basic')
    assert.equal(c.log, 'json')
    assert.equal(c.testPages, false)
  })

  it('without the two overrides it would silently fall back to SAP HANA and XSUAA (the defect they prevent)', () => {
    const { CDS_REQUIRES_DB_KIND, CDS_REQUIRES_AUTH_KIND, ...rest } = dockerEnv()
    const c = resolve(rest)
    assert.equal(c.db, 'hana')
    assert.equal(c.auth, 'xsuaa')
  })
})
