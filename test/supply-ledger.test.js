process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH, PUT, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const admin = { auth: { username: 'admin', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`
const outcome = p => p.then(r => r, e => e.response ?? e)
const code = res => res.data?.error?.code
const table = (name, where = {}) => cds.run(SELECT.from(`reliefgrid.${name}`).where(where))

async function createCamp(name, headcount = 100) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}
const line = async (campID, c) => (await GET(`${camp(campID)}/stock?$filter=standard_code eq '${c}'`, coordinator)).data.value[0]
const count = async (campID, c, quantity) => POST(`${R}/Stock(${(await line(campID, c)).ID})/ReliefService.recordCount`, { quantity }, coordinator)
const requestFor = async (campID, c = 'WATER') => (await GET(`${camp(campID)}/requests?$filter=standard_code eq '${c}'`, coordinator)).data.value[0]
const raise = campID => POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator)
const pledge = (requestID, quantity, name = 'Ledger Donor') => POST(`${D}/Requests(${requestID})/DonorService.pledge`, { donor: name, quantity }, donor)
const receive = (pledgeID, body) => POST(`${R}/Pledges(${pledgeID})/ReliefService.confirmDelivery`, body, coordinator)
const pledgeOf = async ID => (await GET(`${R}/Pledges(${ID})`, coordinator)).data
const requestOf = async ID => (await GET(`${R}/Requests(${ID})`, coordinator)).data
const events = (where = {}) => table('AuditEvents', where)
const movements = (where = {}) => table('StockMovements', where)

/** A camp with 100 people and 300 litres of water: a water request of 10,200 litres (7 days at 15 L, less stock). */
async function campWithRequest(name) {
  const c = await createCamp(name)
  await count(c, 'WATER', 300)
  await raise(c)
  return { c, r: await requestFor(c) }
}

describe('Stage C: stock ledger, receipts and audit trail', () => {
  describe('ARCH-01 concurrency', () => {
    it('five simultaneous raises create each request once', async () => {
      const c = await createCamp('Race Raise Camp')
      await count(c, 'WATER', 300)
      await count(c, 'SOAP', 0)
      await Promise.all(Array.from({ length: 5 }, () => outcome(raise(c))))
      const requests = (await GET(`${camp(c)}/requests`, coordinator)).data.value
      const perIndicator = requests.reduce((m, r) => ({ ...m, [r.standard_code]: (m[r.standard_code] ?? 0) + 1 }), {})
      assert.deepEqual(perIndicator, { WATER: 1, SOAP: 1 })
    })

    it('a cancellation racing a pledge leaves no stranded pledge', async () => {
      const { r } = await campWithRequest('Race Cancel Camp')
      const [cancel, pledged] = await Promise.all([outcome(POST(`${R}/Requests(${r.ID})/ReliefService.cancel`, {}, coordinator)), outcome(pledge(r.ID, 100))])
      const after = await requestOf(r.ID)
      if (cancel.status === 200) {
        assert.equal(after.status_code, 'CANCELLED')
        assert.ok(pledged.status >= 400, 'no pledge on a cancelled request')
        assert.equal((await table('Pledges', { request_ID: r.ID })).length, 0)
      } else {
        assert.equal(code(cancel), 'REQUEST_HAS_PLEDGES')
        assert.equal(pledged.status, 201)
      }
    })

    it('closing a camp racing a pledge gives one consistent result', async () => {
      const { c, r } = await campWithRequest('Race Close Camp')
      const [closed, pledged] = await Promise.all([outcome(POST(`${camp(c)}/ReliefService.closeCamp`, {}, coordinator)), outcome(pledge(r.ID, 100))])
      assert.equal(closed.status, 200)
      const after = await requestOf(r.ID)
      if (pledged.status === 201) assert.equal(Number(after.quantity), 100, 'the request shrank to what was pledged')
      else assert.equal(after.status_code, 'CANCELLED')
    })
  })

  describe('ARCH-02 and ARCH-03 receipts', () => {
    it('two partial receipts: the pledge is partly received, then delivered; stock and request follow the accepted goods', async () => {
      const { c, r } = await campWithRequest('Two Receipts Camp')
      const { data: p } = await pledge(r.ID, 1000)
      await receive(p.ID, { receivedQuantity: 400 })
      let pl = await pledgeOf(p.ID)
      assert.equal(pl.status_code, 'PARTIAL')
      assert.equal(Number(pl.receivedQuantity), 400)
      assert.equal(Number((await line(c, 'WATER')).quantity), 700)
      assert.equal(Number((await requestOf(r.ID)).deliveredQuantity), 400)
      await receive(p.ID, { receivedQuantity: 600 })
      pl = await pledgeOf(p.ID)
      assert.equal(pl.status_code, 'DELIVERED')
      assert.equal(Number(pl.acceptedQuantity), 1000)
      assert.equal(Number((await line(c, 'WATER')).quantity), 1300)
      assert.equal((await table('DeliveryReceipts', { pledge_ID: p.ID })).length, 2)
      assert.equal((await outcome(receive(p.ID, { receivedQuantity: 1 }))).status, 409, 'a delivered pledge takes no more receipts')
    })

    it('damaged goods are received but not accepted: they need a reason, never raise usable stock, and go back on the board', async () => {
      const { c, r } = await campWithRequest('Damaged Camp')
      const { data: p } = await pledge(r.ID, 500)
      const noCondition = await outcome(receive(p.ID, { receivedQuantity: 500, acceptedQuantity: 300 }))
      assert.equal(noCondition.status, 400)
      assert.equal(code(noCondition), 'RECEIPT_CONDITION_REQUIRED')
      const noReason = await outcome(receive(p.ID, { receivedQuantity: 500, acceptedQuantity: 300, condition: 'DAMAGED' }))
      assert.equal(code(noReason), 'RECEIPT_REASON_REQUIRED')
      assert.equal((await outcome(receive(p.ID, { receivedQuantity: 500, acceptedQuantity: 600, condition: 'GOOD' }))).status, 400, 'never more accepted than received')
      await receive(p.ID, { receivedQuantity: 500, acceptedQuantity: 300, condition: 'DAMAGED', reason: '200 litres in leaking jerrycans' })
      const [receipt] = await table('DeliveryReceipts', { pledge_ID: p.ID })
      assert.equal(receipt.conditionText, 'Damaged')
      assert.equal(Number(receipt.acceptedQuantity), 300)
      assert.equal(Number((await line(c, 'WATER')).quantity), 600, 'only the 300 usable litres were added')
      const req = await requestOf(r.ID)
      assert.equal(Number(req.deliveredQuantity), 300)
      assert.equal(Number(req.pledgedQuantity), 300, 'the 200 unusable litres are needed again')
    })

    it('more than was pledged is refused without a reason, and recorded as a discrepancy with one (ARCH-02)', async () => {
      const { c, r } = await campWithRequest('Over Receipt Camp')
      const { data: p } = await pledge(r.ID, 1)
      const typo = await outcome(receive(p.ID, { receivedQuantity: 1000000 }))
      assert.equal(typo.status, 400)
      assert.equal(code(typo), 'RECEIPT_EXCEEDS_PLEDGE')
      assert.equal(Number((await line(c, 'WATER')).quantity), 300, 'a typo never inflates stock')
      assert.equal((await table('DeliveryReceipts', { pledge_ID: p.ID })).length, 0)
      await receive(p.ID, { receivedQuantity: 50, reason: 'The donor sent a full tank' })
      const [receipt] = await table('DeliveryReceipts', { pledge_ID: p.ID })
      assert.equal(receipt.overReceipt, true)
      assert.equal(receipt.reason, 'The donor sent a full tank')
      assert.equal(Number((await line(c, 'WATER')).quantity), 350)
    })

    it('closing a partly received pledge needs a reason and frees what never arrived; a pledge with nothing received is withdrawn instead', async () => {
      const { r } = await campWithRequest('Close Pledge Camp')
      const { data: p } = await pledge(r.ID, 1000)
      assert.equal(code(await outcome(POST(`${R}/Pledges(${p.ID})/ReliefService.closePledge`, { reason: 'x' }, coordinator))), 'PLEDGE_NOT_PARTLY_RECEIVED')
      await receive(p.ID, { receivedQuantity: 250 })
      assert.equal((await outcome(POST(`${R}/Pledges(${p.ID})/ReliefService.withdraw`, {}, coordinator))).status, 409, 'goods that arrived cannot be withdrawn')
      assert.equal((await outcome(POST(`${R}/Pledges(${p.ID})/ReliefService.closePledge`, { reason: ' ' }, coordinator))).status, 400)
      await POST(`${R}/Pledges(${p.ID})/ReliefService.closePledge`, { reason: 'Donor cannot send the rest' }, coordinator)
      const pl = await pledgeOf(p.ID)
      assert.equal(pl.status_code, 'DELIVERED')
      assert.equal(pl.closeReason, 'Donor cannot send the rest')
      assert.equal(pl.closedBy, 'coordinator')
      assert.equal(Number((await requestOf(r.ID)).pledgedQuantity), 250)
    })

    it('a receipt can close the pledge in the same step', async () => {
      const { r } = await campWithRequest('Close With Receipt Camp')
      const { data: p } = await pledge(r.ID, 1000)
      assert.equal((await outcome(receive(p.ID, { receivedQuantity: 600, closePledge: true }))).status, 400, 'closing short needs a reason')
      await receive(p.ID, { receivedQuantity: 600, closePledge: true, reason: 'Last truck of the season' })
      assert.equal((await pledgeOf(p.ID)).status_code, 'DELIVERED')
      assert.equal(Number((await requestOf(r.ID)).pledgedQuantity), 600)
    })

    it('ARCH-06: goods that arrive after the camp closed are recorded as received after closure', async () => {
      const { c, r } = await campWithRequest('Late Goods Camp')
      const { data: p } = await pledge(r.ID, 800)
      await POST(`${camp(c)}/ReliefService.closeCamp`, {}, coordinator)
      const res = await receive(p.ID, { receivedQuantity: 800 })
      assert.equal(res.status, 200)
      const [receipt] = await table('DeliveryReceipts', { pledge_ID: p.ID })
      assert.equal(receipt.afterClosure, true)
      const { data: shown } = await GET(`${camp(c)}/receipts`, coordinator)
      assert.equal(shown.value.length, 1, 'the late delivery is shown on the closed camp')
      assert.match((await events({ pledgeID: p.ID, kind: 'RECEIPT_RECORDED' }))[0].detail, /received after the camp closed/)
    })
  })

  describe('UX-14 donors see what happened to their pledges', () => {
    it('a pledge on a closed camp keeps its camp and indicator, and says the camp closed', async () => {
      const { c, r } = await campWithRequest('Donor Closed Camp')
      const { data: p } = await pledge(r.ID, 100, 'Visible Donor')
      await POST(`${camp(c)}/ReliefService.closeCamp`, {}, coordinator)
      const { data } = await GET(`${D}/MyPledges?$filter=ID eq ${p.ID}`, donor)
      assert.equal(data.value.length, 1)
      assert.equal(data.value[0].campName, 'Donor Closed Camp')
      assert.equal(data.value[0].standardName, 'Water')
      assert.equal(data.value[0].situation, 'Camp closed')
      const { data: one } = await GET(`${D}/Pledges(${p.ID})`, donor)
      assert.equal(one.situation, 'Camp closed')
    })

    it('a pledge whose request was cancelled through its review says so', async () => {
      const { r } = await campWithRequest('Donor Cancelled Camp')
      const { data: p } = await pledge(r.ID, 100)
      await POST(`${R}/Pledges(${p.ID})/ReliefService.withdraw`, {}, coordinator)
      await POST(`${R}/Requests(${r.ID})/ReliefService.cancel`, {}, coordinator)
      const { data } = await GET(`${D}/MyPledges?$filter=ID eq ${p.ID}`, donor)
      assert.equal(data.value[0].situation, 'Request cancelled')
    })

    it('MyPledges lists only the signed-in donor\'s own pledges', async () => {
      const donor2 = { auth: { username: 'donor2', password: 'test' } }
      const { r } = await campWithRequest('Two Donors Camp')
      const { data: mine } = await pledge(r.ID, 10, 'First Organisation')
      const { data: theirs } = await POST(`${D}/Requests(${r.ID})/DonorService.pledge`, { donor: 'Second Organisation', quantity: 20 }, donor2)
      const first = (await GET(`${D}/MyPledges`, donor)).data.value.map(p => p.ID)
      const second = (await GET(`${D}/MyPledges`, donor2)).data.value.map(p => p.ID)
      assert.ok(first.includes(mine.ID) && !first.includes(theirs.ID))
      assert.deepEqual(second, [theirs.ID])
    })
  })

  describe('ARCH-04 deleting camps', () => {
    it('a camp with counts, requests or decisions cannot be deleted, and says so', async () => {
      const c = await createCamp('History Keep Camp')
      await count(c, 'WATER', 10)
      assert.equal((await GET(camp(c), coordinator)).data.deletable, false)
      const res = await outcome(axios.delete(camp(c), coordinator))
      assert.equal(res.status, 409)
      assert.equal(code(res), 'CAMP_HAS_HISTORY')
      assert.equal((await table('Stock', { camp_ID: c })).length, 9)
    })

    it('an untouched camp can be deleted, leaves no orphan rows, and the deletion is audited', async () => {
      const c = await createCamp('Mistyped Camp')
      assert.equal((await GET(camp(c), coordinator)).data.deletable, true)
      await axios.delete(camp(c), coordinator)
      for (const t of ['Camps', 'Stock', 'AssessmentRecords']) assert.equal((await table(t, t === 'Camps' ? { ID: c } : { camp_ID: c })).length, 0, t)
      const [e] = await events({ campID: c, kind: 'CAMP_DELETED' })
      assert.equal(e.campName, 'Mistyped Camp')
      assert.equal(e.actor, 'coordinator')
    })
  })

  describe('ARCH-05 ledger and audit trail', () => {
    it('every count and receipt writes exactly one movement, and the ledger reconciles to stock on hand', async () => {
      const { c, r } = await campWithRequest('Ledger Camp')
      const w = await line(c, 'WATER')
      assert.equal((await movements({ stock_ID: w.ID })).length, 1, 'the first count')
      const { data: p } = await pledge(r.ID, 500)
      await receive(p.ID, { receivedQuantity: 200 })
      await receive(p.ID, { receivedQuantity: 300, acceptedQuantity: 250, condition: 'REJECTED', reason: 'Not drinkable' })
      await count(c, 'WATER', 720)
      const ledger = (await movements({ stock_ID: w.ID })).sort((a, b) => a.movedAt.localeCompare(b.movedAt))
      assert.deepEqual(ledger.map(m => [m.kind, Number(m.quantityBefore ?? NaN), Number(m.quantityAfter)]),
        [['COUNT', NaN, 300], ['RECEIPT', 300, 500], ['RECEIPT', 500, 750], ['COUNT', 750, 720]])
      assert.equal(Number(ledger.at(-1).change), -30, 'the count found 30 litres fewer than expected')
      for (let i = 1; i < ledger.length; i++) assert.equal(Number(ledger[i].quantityBefore), Number(ledger[i - 1].quantityAfter), 'each movement starts where the last ended')
      assert.equal(Number(ledger.at(-1).quantityAfter), Number((await line(c, 'WATER')).quantity))
    })

    it('every supply operation writes exactly one audit event, with who and what', async () => {
      const { c, r } = await campWithRequest('Audit Camp')
      const before = (await events({ campID: c })).length
      const { data: p } = await pledge(r.ID, 100)
      await POST(`${R}/Pledges(${p.ID})/ReliefService.withdraw`, {}, coordinator)
      await POST(`${camp(c)}/ReliefService.requestSupplies`, { standard: 'SOAP', quantity: 10, note: 'Extra' }, coordinator).catch(() => {})
      await POST(`${R}/Requests(${r.ID})/ReliefService.cancel`, {}, coordinator)
      await POST(`${camp(c)}/ReliefService.closeCamp`, {}, coordinator)
      const kinds = (await events({ campID: c })).slice(before).map(e => e.kind).sort()
      assert.deepEqual(kinds.filter(k => k !== 'REQUEST_CREATED'), ['CAMP_CLOSED', 'PLEDGE_MADE', 'PLEDGE_WITHDRAWN', 'REQUEST_CANCELLED'])
      const made = (await events({ pledgeID: p.ID, kind: 'PLEDGE_MADE' }))[0]
      assert.equal(made.actor, 'donor')
      assert.match(made.detail, /^100 of WATER by Ledger Donor$/)
    })

    it('a failed operation writes neither a movement nor an event', async () => {
      const { c, r } = await campWithRequest('Failed Audit Camp')
      const { data: p } = await pledge(r.ID, 5)
      const counts = [(await events()).length, (await movements()).length]
      await outcome(receive(p.ID, { receivedQuantity: 9999 }))
      await outcome(POST(`${R}/Pledges(${p.ID})/ReliefService.closePledge`, { reason: 'x' }, coordinator))
      assert.deepEqual([(await events()).length, (await movements()).length], counts)
      assert.equal(Number((await line(c, 'WATER')).quantity), 300)
    })

    it('the ledger and the trail are read-only through the services, and hidden from donors', async () => {
      const [m] = await movements()
      const [e] = await events()
      for (const attempt of [
        () => POST(`${R}/StockMovements`, { kind: 'COUNT' }, admin),
        () => PATCH(`${R}/StockMovements(${m.ID})`, { quantityAfter: 1 }, admin),
        () => axios.delete(`${R}/StockMovements(${m.ID})`, admin),
        () => POST(`${R}/AuditEvents`, { kind: 'CAMP_CLOSED' }, admin),
        () => PUT(`${R}/AuditEvents(${e.ID})`, { detail: 'x' }, admin),
        () => axios.delete(`${R}/AuditEvents(${e.ID})`, admin),
        () => POST(`${R}/DeliveryReceipts`, { receivedQuantity: 1 }, admin)
      ]) assert.ok((await outcome(attempt())).status >= 400)
      for (const path of ['StockMovements', 'AuditEvents', 'DeliveryReceipts']) assert.equal((await outcome(GET(`${R}/${path}`, donor))).status, 403, path)
      const { data: md } = await GET(`${D}/$metadata`, donor)
      assert.doesNotMatch(md, /StockMovements|AuditEvents|DeliveryReceipts|movedBy|receivedBy|acceptedBy/)
    })
  })
})
