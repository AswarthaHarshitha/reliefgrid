process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`

async function createCamp(data) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, data, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}

async function stockOf(campID) {
  const { data } = await GET(`${camp(campID)}/stock`, coordinator)
  return Object.fromEntries(data.value.map(s => [s.standard_code, s]))
}

const count = (line, quantity) => POST(`${R}/Stock(${line.ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(line.standard_code) ? { functionalUnits: quantity } : {}) }, coordinator)
const health = async campID => (await GET(`${camp(campID)}/health`, coordinator)).data
const sapMessages = res => JSON.parse(res.headers['sap-messages'] ?? '[]')
const messages = res => sapMessages(res).map(m => m.code)
const severities = res => sapMessages(res).map(m => m.numericSeverity)
const texts = res => sapMessages(res).map(m => m.message)
const result = res => ({ created: res.data.created, skipped: res.data.skipped, notAssessed: res.data.notAssessed })
const base = { district: 'District T', region: 'Region T', hazard_code: 'FLOOD' }

/** Every per-person figure of a line is unknown rather than zero or met. */
function assertUnassessable(line, assessment) {
  assert.equal(line.assessment, assessment, line.standard_code)
  assert.equal(line.severity, null, line.standard_code)
  assert.equal(line.daysOfCover, null, line.standard_code)
  assert.equal(line.coveragePct, null, line.standard_code)
  assert.equal(line.shortfall, null, line.standard_code)
}

describe('population and assessment', () => {
  let zero, missing

  before(async () => {
    zero = await createCamp({ ...base, name: 'Zero Population Camp', headcount: 0 })
    missing = await createCamp({ ...base, name: 'Missing Population Camp' })
  })

  it('keeps a missing population empty instead of turning it into 0', async () => {
    const { data } = await GET(`${camp(missing)}?$select=headcount`, coordinator)
    assert.equal(data.headcount, null)
  })

  for (const [label, id] of [['zero population', () => zero], ['missing population', () => missing]]) {
    it(`does not assess a camp with ${label}`, async () => {
      const stock = await stockOf(id())
      for (const line of Object.values(stock)) {
        assertUnassessable(line, 'NOT_ASSESSED')
        assert.equal(line.required, null, 'no per-person requirement without people')
        assert.equal(line.cover, 'Not assessed')
        assert.equal(line.status, 'Not assessed')
      }
      const h = await health(id())
      assert.equal(h.compliance, null, 'never 100 % without people')
      assert.equal(h.worstSeverity, null)
      assert.equal(h.criticalGaps, 0)
      assert.equal(h.assessedIndicators, 0)
      assert.equal(h.assessment, 'Not assessed')
    })
  }

  it('stays not assessed even after stock is counted', async () => {
    const stock = await stockOf(zero)
    await count(stock.WATER, 500)
    const after = await stockOf(zero)
    assert.equal(Number(after.WATER.quantity), 500)
    assertUnassessable(after.WATER, 'NOT_ASSESSED')
    assert.equal((await health(zero)).compliance, null)
  })

  it('raises no requests for a camp that is not assessed, and says why', async () => {
    const res = await POST(`${camp(zero)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    assert.deepEqual(result(res), { created: 0, skipped: 0, notAssessed: true })
    assert.deepEqual(messages(res), ['CAMP_NOT_ASSESSED'])
    const board = await GET(`${D}/Requests?$filter=campName eq 'Zero Population Camp'`, donor)
    assert.equal(board.data.value.length, 0)
  })

  it('assesses the camp once people are recorded', async () => {
    const { data: draft } = await POST(`${camp(missing)}/ReliefService.draftEdit`, { PreserveChanges: true }, coordinator)
    const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
    await PATCH(key, { headcount: 100 }, coordinator)
    await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
    const stock = await stockOf(missing)
    assert.equal(Number(stock.WATER.required), 1500)
    assertUnassessable(stock.WATER, 'NOT_COUNTED')
    assert.equal((await health(missing)).assessment, 'Not counted')
  })
})

describe('stock count state', () => {
  let campID

  before(async () => {
    campID = await createCamp({ ...base, name: 'Count State Camp', headcount: 200 })
  })

  it('shows never-counted stock as not counted, with no quantity', async () => {
    const stock = await stockOf(campID)
    assert.equal(Object.keys(stock).length, 9)
    // mosquito nets need an applicability decision first (B4.1); every other line is not counted
    assertUnassessable(stock.NET, 'NOT_DECIDED')
    assert.equal(stock.NET.required, null)
    for (const line of Object.values(stock).filter(l => l.standard_code !== 'NET')) {
      assert.equal(line.quantity, null)
      assert.equal(line.countedAt, null)
      assertUnassessable(line, 'NOT_COUNTED')
      assert.equal(line.cover, 'Not counted')
      assert.equal(line.status, 'Not counted')
      assert.ok(Number(line.required) > 0, 'the requirement is known once people are recorded')
    }
    const h = await health(campID)
    assert.equal(h.compliance, null)
    assert.equal(h.notCountedIndicators, 8)
    assert.equal(h.notDecidedIndicators, 1)
    assert.equal(h.criticalGaps, 0)
    assert.equal(h.assessment, 'Not counted')
  })

  it('raises no requests from unknown stock, and says why', async () => {
    const res = await POST(`${camp(campID)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    assert.deepEqual(result(res), { created: 0, skipped: 8, notAssessed: false })
    assert.equal(res.data.needsDecision, 1)
    assert.deepEqual(messages(res), ['NO_REQUESTS_NOT_COUNTED', 'LINES_NOT_COUNTED', 'LINES_NEED_DECISION'])
    assert.deepEqual(severities(res), [3, 3, 2], 'nothing raised because of uncounted stock is a warning, not a success')
    assert.match(texts(res)[1], /^Skipped: 8 indicators never counted, so no confirmed shortage can be calculated\. Record stock counts first/)
  })

  it('treats a count of zero as a real, critical zero', async () => {
    await count((await stockOf(campID)).WATER, 0)
    const { WATER } = await stockOf(campID)
    assert.equal(Number(WATER.quantity), 0)
    assert.ok(WATER.countedAt, 'the count time is recorded')
    assert.equal(WATER.assessment, 'CRITICAL')
    assert.equal(WATER.status, 'Critical')
    assert.equal(WATER.severity, 1)
    assert.equal(Number(WATER.daysOfCover), 0)
    assert.match(WATER.cover, /^0(\.0)? days$/)
    assert.equal(Number(WATER.shortfall), 200 * 15 * 7)
  })

  it('assesses a positive count', async () => {
    await count((await stockOf(campID)).TOILET, 10)
    const { TOILET } = await stockOf(campID)
    assert.equal(TOILET.assessment, 'MET')
    assert.equal(TOILET.status, 'Met')
    assert.equal(TOILET.severity, 3)
    assert.equal(Number(TOILET.coveragePct), 100)
    assert.equal(Number(TOILET.shortfall), 0)
  })

  it('leaves not-counted indicators out of Applicable Indicators Met', async () => {
    const h = await health(campID)
    assert.equal(h.assessedIndicators, 2)
    assert.equal(h.metIndicators, 1)
    assert.equal(h.notCountedIndicators, 6)
    assert.equal(h.compliance, 50, '1 met of 2 assessed, not 1 of 9')
    assert.equal(h.criticalGaps, 1, 'the counted critical gap stays visible')
    assert.equal(h.worstSeverity, 1)
    assert.equal(h.assessment, 'Partly counted')
  })

  it('raises requests only for counted gaps', async () => {
    const res = await POST(`${camp(campID)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    assert.deepEqual(result(res), { created: 1, skipped: 6, notAssessed: false })
    assert.deepEqual(messages(res), ['REQUESTS_RAISED', 'LINES_NOT_COUNTED', 'LINES_NEED_DECISION'])
    assert.deepEqual(severities(res), [2, 3, 2], 'a partial result carries a warning (2 information, 3 warning)')
    assert.match(texts(res)[0], /published to donors: 1\./)
    assert.match(texts(res)[1], /^Skipped: 6 indicators never counted/)
    const { data } = await GET(`${camp(campID)}/requests`, coordinator)
    assert.deepEqual(data.value.map(r => r.standard_code), ['WATER'])
    assert.equal(Number(data.value[0].quantity), 200 * 15 * 7)
  })

  it('reports the counts of each operation itself, not the camp\'s later state', async () => {
    const other = await createCamp({ ...base, name: 'Operation Result Camp', headcount: 100 })
    const lines = await stockOf(other)
    await count(lines.WATER, 0)
    await count(lines.TOILET, 5)
    const first = await POST(`${camp(other)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    assert.deepEqual(result(first), { created: 1, skipped: 6, notAssessed: false })

    for (const code of ['SOAP', 'LAUNDRY', 'SHELTER']) await count(lines[code], 0)
    assert.equal((await health(other)).notCountedIndicators, 3, 'the camp has changed since the first operation')
    assert.equal(first.data.skipped, 6, 'the first operation still reports what it skipped')

    const second = await POST(`${camp(other)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    assert.deepEqual(result(second), { created: 3, skipped: 3, notAssessed: false })
    assert.match(texts(second)[1], /^Skipped: 3 indicators/)
  })

  it('keeps a delivery onto a never-counted line unknown until it is counted', async () => {
    const { data: request } = await POST(`${camp(campID)}/ReliefService.requestSupplies`, { standard: 'SOAP', quantity: 500 }, coordinator)
    const { data: pledge } = await POST(`${D}/Requests(${request.ID})/DonorService.pledge`, { donor: 'Count State Donor', quantity: 500 }, donor)
    await POST(`${R}/Pledges(${pledge.ID})/ReliefService.confirmDelivery`, { receivedQuantity: 500 }, coordinator)
    const { SOAP } = await stockOf(campID)
    assert.equal(SOAP.quantity, null)
    assertUnassessable(SOAP, 'NOT_COUNTED')
    const { data: p } = await GET(`${R}/Pledges(${pledge.ID})`, coordinator)
    assert.equal(Number(p.receivedQuantity), 500, 'the receipt is kept on the pledge')

    await count(SOAP, 900)
    const after = await stockOf(campID)
    assert.equal(Number(after.SOAP.quantity), 900)
    assert.notEqual(after.SOAP.assessment, 'NOT_COUNTED')
  })
})

describe('consistency across consumers', () => {
  it('gives the overview the same numbers as camp health and the stock lines', async () => {
    const { data: overview } = await GET(`${R}/overview()`, coordinator)
    const { data: camps } = await GET(`${R}/Camps?$filter=IsActiveEntity eq true and status_code eq 'ACTIVE'&$expand=health,stock($select=assessment)`, coordinator)

    const sum = f => camps.value.reduce((n, c) => n + (c.health?.[f] ?? 0), 0)
    const lines = camps.value.flatMap(c => c.stock)
    const countOf = state => lines.filter(l => l.assessment === state).length

    assert.equal(overview.criticalGaps, sum('criticalGaps'))
    assert.equal(overview.criticalGaps, countOf('CRITICAL'))
    assert.equal(overview.warningGaps, countOf('ATTENTION'))
    assert.equal(overview.indicatorsNotCounted, sum('notCountedIndicators'))
    assert.equal(overview.indicatorsNotCounted, countOf('NOT_COUNTED'))
    assert.equal(overview.campsNotAssessed, camps.value.filter(c => !(c.headcount > 0)).length)
    assert.equal(overview.campsNotAssessed, camps.value.filter(c => c.health?.assessment === 'Not assessed').length)
    assert.ok(overview.campsNotAssessed >= 1)
    assert.equal(overview.campsInCrisis, camps.value.filter(c => c.health?.worstSeverity === 1).length)
  })

  it('lists critical gaps only for counted lines in assessed camps', async () => {
    const { data } = await GET(`${R}/Stock?$filter=severity eq 1&$expand=camp($select=headcount)`, coordinator)
    assert.ok(data.value.length > 0)
    for (const line of data.value) {
      assert.ok(line.camp.headcount > 0)
      assert.ok(line.countedAt)
      assert.notEqual(line.quantity, null)
    }
  })

  it('shows donors requests only for counted gaps and manual requests', async () => {
    const { data } = await GET(`${D}/Requests?$filter=campName eq 'Count State Camp'&$orderby=standard_code`, donor)
    assert.deepEqual(data.value.map(r => r.standard_code), ['SOAP', 'WATER'])
    const { data: board } = await GET(`${D}/Requests`, donor)
    for (const r of board.value) assert.ok(r.campHeadcount > 0, `${r.campName} is assessed`)
    for (const r of board.value) assert.equal(r.severity, undefined, 'donors get no stock assessment fields')
  })
})
