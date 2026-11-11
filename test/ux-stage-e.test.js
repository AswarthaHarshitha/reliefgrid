process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'
const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`

async function createCamp(name, headcount, counts) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, { name, district: 'D', region: 'R', hazard_code: 'FLOOD', headcount }, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  const lines = (await GET(`${camp(draft.ID)}/stock`, coordinator)).data.value
  for (const [c, q] of Object.entries(counts))
    await POST(`${R}/Stock(${lines.find(l => l.standard_code === c).ID})/ReliefService.recordCount`, { quantity: q, ...(['TOILET', 'TAP'].includes(c) ? { functionalUnits: q } : {}) }, coordinator)
  return draft.ID
}
const overview = async () => (await GET(`${R}/overview()`, coordinator)).data
const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10)

describe('Stage E: operational usability', () => {
  it('UX-05: the preview shows exactly what Raise Requests then publishes, and publishes nothing itself', async () => {
    const c = await createCamp('Preview Camp', 100, { WATER: 300, SOAP: 0, TOILET: 1, SHELTER: 350 })
    const { data: preview } = await GET(`${camp(c)}/ReliefService.previewRequests(targetDays=7)`, coordinator)
    assert.equal((await GET(`${camp(c)}/requests`, coordinator)).data.value.length, 0, 'a preview publishes nothing')
    const water = preview.value.find(l => l.standardCode === 'WATER')
    assert.equal(Number(water.requirement), 1500, '15 litres for 100 people per day')
    assert.equal(Number(water.target), 10500, 'seven days of supply')
    assert.equal(Number(water.onHand), 300)
    assert.equal(Number(water.incoming), 0)
    assert.equal(water.quantity, 10200)
    assert.equal(water.unit, 'litres')
    assert.equal(water.targetDays, 7)
    assert.ok(!preview.value.some(l => l.standardCode === 'SHELTER'), 'a met line requests nothing')
    await POST(`${camp(c)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    const published = (await GET(`${camp(c)}/requests`, coordinator)).data.value
    assert.deepEqual(published.map(r => [r.standard_code, Number(r.quantity), r.priority_code, r.neededBy]).sort(),
      preview.value.map(l => [l.standardCode, l.quantity, l.priority, l.neededBy]).sort())
    const { data: again } = await GET(`${camp(c)}/ReliefService.previewRequests(targetDays=7)`, coordinator)
    assert.equal(again.value.length, 0, 'once published, the same gaps are covered by requests still to arrive')
    const { data: longer } = await GET(`${camp(c)}/ReliefService.previewRequests(targetDays=10)`, coordinator)
    assert.equal(longer.value.find(l => l.standardCode === 'WATER').quantity, 4500, 'three more days, less what is already requested')
  })

  it('UX-05: a camp without people previews nothing; a closed camp is refused', async () => {
    const empty = await createCamp('Empty Preview Camp', 0, {})
    assert.equal((await GET(`${camp(empty)}/ReliefService.previewRequests(targetDays=7)`, coordinator)).data.value.length, 0)
    await POST(`${camp(empty)}/ReliefService.closeCamp`, {}, coordinator)
    const res = await GET(`${camp(empty)}/ReliefService.previewRequests(targetDays=7)`, coordinator).catch(e => e.response)
    assert.equal(res.status, 409)
  })

  it('UX-01: requests awaiting a pledge and requests with incoming pledges are counted apart', async () => {
    const before = await overview()
    const c = await createCamp('Split Count Camp', 100, { WATER: 0, SOAP: 0 })
    await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
    let now = await overview()
    assert.equal(now.requestsAwaitingPledge - before.requestsAwaitingPledge, 2)
    assert.equal(now.requestsWithIncomingPledges - before.requestsWithIncomingPledges, 0)
    const water = (await GET(`${D}/Requests?$filter=campName eq 'Split Count Camp' and standard_code eq 'WATER'`, donor)).data.value[0]
    await POST(`${D}/Requests(${water.ID})/DonorService.pledge`, { donor: 'Split Donor', quantity: Number(water.remaining) }, donor)
    now = await overview()
    assert.equal(now.requestsAwaitingPledge - before.requestsAwaitingPledge, 1, 'the fully pledged request no longer waits for donors')
    assert.equal(now.requestsWithIncomingPledges - before.requestsWithIncomingPledges, 1)
    assert.equal(now.pledgesInTransit - before.pledgesInTransit, 1)
  })

  it('UX-01: a request under review is not counted as awaiting a pledge, as it is not offered to donors', async () => {
    const c = await createCamp('Review Count Camp', 100, { WATER: 0 })
    await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
    const before = await overview()
    const [r] = (await GET(`${camp(c)}/requests`, coordinator)).data.value
    // a recorded household change or a decision would flag it; the effect on the count is the same
    await cds.run(UPDATE('reliefgrid.Requests').set({ review_code: 'PENDING' }).where({ ID: r.ID }))
    const now = await overview()
    assert.equal(before.requestsAwaitingPledge - now.requestsAwaitingPledge, 1)
    assert.equal(now.requestsToReview - before.requestsToReview, 1)
  })

  it('UX-08: act now lists critical gaps by time to stock-out, overdue deliveries and unanswered requests', async () => {
    const c = await createCamp('Act Now Camp', 100, { WATER: 100, FOOD: 150, SOAP: 0 })
    await POST(`${camp(c)}/ReliefService.raiseRequests`, {}, coordinator)
    const requests = (await GET(`${camp(c)}/requests`, coordinator)).data.value
    const water = requests.find(r => r.standard_code === 'WATER')
    const food = requests.find(r => r.standard_code === 'FOOD')
    const { data: p } = await POST(`${D}/Requests(${water.ID})/DonorService.pledge`, { donor: 'Late Donor', quantity: 100 }, donor)
    // time passes: the expected arrival and the needed-by date are now behind us
    await cds.run(UPDATE('reliefgrid.Pledges').set({ eta: yesterday() }).where({ ID: p.ID }))
    await cds.run(UPDATE('reliefgrid.Requests').set({ neededBy: yesterday() }).where({ ID: food.ID }))
    const items = (await GET(`${R}/actNow()`, coordinator)).data.value.filter(i => i.campName === 'Act Now Camp')
    const gaps = items.filter(i => i.kind === 'CRITICAL_GAP')
    assert.deepEqual(gaps.map(g => g.standardName), ['Bathing soap', 'Water', 'Food rations'], 'the soonest stock-out first: 0, 0.1 and 1.5 days')
    const late = items.find(i => i.kind === 'OVERDUE_DELIVERY')
    assert.equal(late.donor, 'Late Donor')
    assert.equal(late.pledgeID, p.ID)
    assert.equal(Number(late.quantity), 100)
    const unanswered = items.find(i => i.kind === 'UNANSWERED_REQUEST')
    assert.equal(unanswered.requestID, food.ID)
    assert.ok(!items.some(i => i.kind === 'UNANSWERED_REQUEST' && i.requestID === water.ID), 'a request with a pledge is not unanswered')
  })
})
