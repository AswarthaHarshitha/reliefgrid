process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

const { GET, POST, PATCH, axios } = cds.test(__dirname + '/..')

const coordinator = { auth: { username: 'coordinator', password: 'test' } }
const donor = { auth: { username: 'donor', password: 'test' } }
const R = '/odata/v4/relief'
const D = '/odata/v4/donor'

const fail = promise =>
  promise.then(
    () => assert.fail('expected the request to fail'),
    e => e.response ?? e
  )

async function createCamp(data) {
  const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
  const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
  await PATCH(key, data, coordinator)
  await POST(`${key}/ReliefService.draftActivate`, {}, coordinator)
  return draft.ID
}

const camp = ID => `${R}/Camps(ID=${ID},IsActiveEntity=true)`

/** Records the same count on every stock line of a camp that has not been counted yet. */
async function countRemaining(campID, quantity) {
  for (const line of Object.values(await stockOf(campID)))
    if (!line.countedAt) await POST(`${R}/Stock(${line.ID})/ReliefService.recordCount`, { quantity, ...(['TOILET', 'TAP'].includes(line.standard_code) ? { functionalUnits: quantity } : {}) }, coordinator)
}

async function stockOf(campID) {
  const { data } = await GET(`${camp(campID)}/stock?$orderby=standard_code`, coordinator)
  return Object.fromEntries(data.value.map(s => [s.standard_code, s]))
}

describe('reference indicator data', () => {
  it('loads the nine reference indicators', async () => {
    const { data } = await GET(`${R}/Standards?$orderby=sortOrder`, coordinator)
    assert.equal(data.value.length, 9)
    const water = data.value.find(s => s.code === 'WATER')
    assert.equal(Number(water.perPerson), 15)
    assert.equal(water.basis, 'Consumption')
    assert.match(water.reference, /Sphere Handbook 2018/)
  })
})

describe('camp lifecycle', () => {
  let campID

  before(async () => {
    campID = await createCamp({
      name: 'Riverside School Shelter',
      district: 'Test District',
      region: 'Test Region',
      hazard_code: 'FLOOD',
      headcount: 400,
      childrenUnder5: 60
    })
  })

  it('creates one stock line per standard on activation', async () => {
    const stock = await stockOf(campID)
    assert.equal(Object.keys(stock).length, 9)
    // Nothing counted yet: unknown, not zero and not critical
    assert.equal(stock.WATER.quantity, null)
    assert.equal(stock.WATER.assessment, 'NOT_COUNTED')
    assert.equal(stock.WATER.severity, null)
    assert.equal(Number(stock.WATER.required), 6000)
  })

  it('rejects more children under five than people sheltered', async () => {
    const { data: draft } = await POST(`${R}/Camps`, {}, coordinator)
    const key = `${R}/Camps(ID=${draft.ID},IsActiveEntity=false)`
    await PATCH(key, { name: 'X', district: 'X', region: 'X', hazard_code: 'FLOOD', headcount: 10, childrenUnder5: 11 }, coordinator)
    const res = await fail(POST(`${key}/ReliefService.draftActivate`, {}, coordinator))
    assert.equal(res.status, 400)
  })

  it('computes days of cover and coverage from a stock count', async () => {
    const stock = await stockOf(campID)
    await POST(`${R}/Stock(${stock.WATER.ID})/ReliefService.recordCount`, { quantity: 24000 }, coordinator)
    await POST(`${R}/Stock(${stock.TOILET.ID})/ReliefService.recordCount`, { quantity: 10, functionalUnits: 10 }, coordinator)
    const after = await stockOf(campID)
    assert.equal(Number(after.WATER.daysOfCover), 4)
    assert.equal(after.WATER.severity, 2)
    assert.equal(Number(after.TOILET.coveragePct), 50)
    assert.equal(after.TOILET.severity, 2)
    assert.match(after.WATER.cover, /^4(\.0)? days$/)
    assert.equal(after.TOILET.cover, '50 %')
    assert.ok(after.WATER.countedAt)
  })

  it('treats a count of zero as a real count', async () => {
    await countRemaining(campID, 0)
    const stock = await stockOf(campID)
    assert.equal(Number(stock.FOOD.quantity), 0)
    assert.equal(stock.FOOD.assessment, 'CRITICAL')
    assert.equal(stock.FOOD.severity, 1)
  })

  it('summarises camp health', async () => {
    const { data } = await GET(`${camp(campID)}/health`, coordinator)
    assert.equal(data.worstSeverity, 1)
    // eight classified lines: mosquito nets are not decided for this camp (B4.1)
    assert.equal(data.criticalGaps, 6)
    assert.equal(data.warningGaps, 2)
    assert.equal(data.compliance, 0)
    assert.equal(data.assessedIndicators, 8)
    assert.equal(data.notDecidedIndicators, 1)
    assert.equal(data.assessment, 'Assessed')
  })

  it('rejects negative counts', async () => {
    const stock = await stockOf(campID)
    const res = await fail(POST(`${R}/Stock(${stock.FOOD.ID})/ReliefService.recordCount`, { quantity: -5 }, coordinator))
    assert.equal(res.status, 400)
  })

  let waterRequest
  it('raises requests for every gap, once', async () => {
    const { data } = await POST(`${camp(campID)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    assert.equal(data.created, 8, 'no request for mosquito nets while their applicability is not decided')
    assert.equal(data.needsDecision, 1)
    assert.equal(data.skipped, 0)
    const again = await POST(`${camp(campID)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    assert.equal(again.data.created, 0)
    assert.equal(again.data.skipped, 0)

    const { data: requests } = await GET(`${camp(campID)}/requests`, coordinator)
    waterRequest = requests.value.find(r => r.standard_code === 'WATER')
    assert.equal(Number(waterRequest.quantity), 400 * 15 * 7 - 24000)
    assert.equal(waterRequest.status_code, 'OPEN')
  })

  it('publishes requests to donors without private contact details', async () => {
    const { data } = await GET(`${D}/Requests?$filter=campName eq 'Riverside School Shelter'`, donor)
    assert.equal(data.value.length, 8)
    assert.equal(data.value[0].contactPhone, undefined)
    assert.equal(data.value[0].district, 'Test District')
  })

  let pledgeID
  it('accepts a partial pledge and tracks what is still needed', async () => {
    const { data } = await POST(
      `${D}/Requests(${waterRequest.ID})/DonorService.pledge`,
      { donor: 'Clean Water Collective', donorContact: 'ops@example.org', quantity: 10000 },
      donor
    )
    pledgeID = data.ID
    const { data: r } = await GET(`${D}/Requests(${waterRequest.ID})`, donor)
    assert.equal(r.status_code, 'PARTIAL')
    assert.equal(Number(r.remaining), 8000)
  })

  it('hides donor contact details from other donors', async () => {
    const { data } = await GET(`${D}/Requests(${waterRequest.ID})/pledges`, donor)
    assert.equal(data.value[0].donor, 'Clean Water Collective')
    assert.equal(data.value[0].donorContact, undefined)
  })

  it('refuses pledges above what is still needed', async () => {
    const res = await fail(
      POST(`${D}/Requests(${waterRequest.ID})/DonorService.pledge`, { donor: 'Big Donor', quantity: 8001 }, donor)
    )
    assert.equal(res.status, 400)
    assert.match(res.data.error.message, /at most 8000/)
  })

  it('updates stock when a delivery is confirmed', async () => {
    await POST(`${R}/Pledges(${pledgeID})/ReliefService.confirmDelivery`, { receivedQuantity: 9000 }, coordinator)
    const stock = await stockOf(campID)
    assert.equal(Number(stock.WATER.quantity), 33000)
    // ARCH-03: part of the pledge arrived; it stays committed until the rest arrives or the coordinator closes it
    const { data: partly } = await GET(`${R}/Pledges(${pledgeID})`, coordinator)
    assert.equal(partly.status_code, 'PARTIAL')
    assert.equal(Number((await GET(`${R}/Requests(${waterRequest.ID})`, coordinator)).data.pledgedQuantity), 10000)
    await POST(`${R}/Pledges(${pledgeID})/ReliefService.closePledge`, { reason: 'The truck carried 9,000 litres; no second trip' }, coordinator)

    const { data: r } = await GET(`${R}/Requests(${waterRequest.ID})`, coordinator)
    assert.equal(Number(r.deliveredQuantity), 9000)
    // the 1,000 L short delivery goes back on the board
    assert.equal(Number(r.pledgedQuantity), 9000)
    assert.equal(r.status_code, 'PARTIAL')

    const res = await fail(POST(`${R}/Pledges(${pledgeID})/ReliefService.confirmDelivery`, { receivedQuantity: 1 }, coordinator))
    assert.equal(res.status, 409)
  })

  it('reports the network overview', async () => {
    const { data } = await GET(`${R}/overview()`, coordinator)
    assert.equal(data.activeCamps, 1)
    assert.equal(data.people, 400)
    assert.equal(data.childrenUnder5, 60)
    assert.equal(data.campsInCrisis, 1)
    assert.equal(data.openRequests, 8)
    assert.equal(data.pledgesInTransit, 0)
  })

  it('withdraws a pledge and reopens the request', async () => {
    const { data: food } = await GET(`${D}/Requests?$filter=campName eq 'Riverside School Shelter' and standard_code eq 'FOOD'`, donor)
    const foodRequest = food.value[0]
    const { data: p } = await POST(
      `${D}/Requests(${foodRequest.ID})/DonorService.pledge`,
      { donor: 'Food Bank', quantity: foodRequest.quantity },
      donor
    )
    let { data: r } = await GET(`${R}/Requests(${foodRequest.ID})`, coordinator)
    assert.equal(r.status_code, 'PLEDGED')

    const res = await fail(POST(`${R}/Requests(${foodRequest.ID})/ReliefService.cancel`, {}, coordinator))
    assert.equal(res.status, 409)

    await POST(`${R}/Pledges(${p.ID})/ReliefService.withdraw`, {}, coordinator)
    ;({ data: r } = await GET(`${R}/Requests(${foodRequest.ID})`, coordinator))
    assert.equal(r.status_code, 'OPEN')
    assert.equal(Number(r.pledgedQuantity), 0)
  })

  it('records manual requests with the current severity as priority', async () => {
    const { data } = await POST(
      `${camp(campID)}/ReliefService.requestSupplies`,
      { standard: 'TAP', quantity: 2, note: 'Broken pump' },
      coordinator
    )
    assert.equal(data.priority_code, 1)
    const res = await fail(POST(`${camp(campID)}/ReliefService.requestSupplies`, { standard: 'NOPE', quantity: 5 }, coordinator))
    assert.equal(res.status, 400)
  })

  it('closes the camp and withdraws its unpledged requests', async () => {
    await POST(`${camp(campID)}/ReliefService.closeCamp`, {}, coordinator)
    const { data } = await GET(`${camp(campID)}/requests`, coordinator)
    const statuses = new Set(data.value.map(r => r.status_code))
    assert.ok(!statuses.has('OPEN'))
    const water = data.value.find(r => r.ID === waterRequest.ID)
    // everything that was pledged has arrived, so the shrunk request is complete
    assert.equal(water.status_code, 'FULFILLED')
    assert.equal(Number(water.quantity), 9000)

    const board = await GET(`${D}/Requests?$filter=campName eq 'Riverside School Shelter'`, donor)
    assert.equal(board.data.value.length, 0)

    const res = await fail(POST(`${camp(campID)}/ReliefService.raiseRequests`, {}, coordinator))
    assert.equal(res.status, 409)
  })
})

describe('authorization', () => {
  it('keeps donors out of the coordinator service', async () => {
    const res = await fail(GET(`${R}/Camps`, donor))
    assert.equal(res.status, 403)
  })

  it('requires a login for the pledge board', async () => {
    const res = await fail(axios.get(`${D}/Requests`))
    assert.equal(res.status, 401)
  })

  it('does not let donors create requests directly', async () => {
    const res = await fail(POST(`${D}/Requests`, { quantity: 1 }, donor))
    assert.ok([403, 405].includes(res.status))
  })
})

describe('donor privacy', () => {
  const PRIVATE = ['createdBy', 'modifiedBy', 'createdAt', 'modifiedAt', 'donorContact']
  // UX-14 adds what was pledged and where, and what happened to it, so a pledge never shows an empty request
  const PUBLIC_PLEDGE = ['ID', 'request_ID', 'donor', 'quantity', 'receivedQuantity', 'acceptedQuantity', 'eta', 'status_code', 'campName', 'standardName', 'unit', 'situation']
  let requestID, pledgeID

  before(async () => {
    const campID = await createCamp({
      name: 'Privacy Test Camp', district: 'P', region: 'P', hazard_code: 'CYCLONE', headcount: 100,
      coordinator: 'Private Coordinator', contactPhone: '+91 98888 77777', latitude: 12.5, longitude: 80.25
    })
    await countRemaining(campID, 0)
    await POST(`${camp(campID)}/ReliefService.raiseRequests`, { targetDays: 7 }, coordinator)
    // water: a request large enough for the two pledges below (the order of requests is not defined)
    const { data } = await GET(`${D}/Requests?$filter=campName eq 'Privacy Test Camp' and standard_code eq 'WATER'`, donor)
    requestID = data.value[0].ID
    const { data: p } = await POST(
      `${D}/Requests(${requestID})/DonorService.pledge`,
      { donor: 'Private Donor Org', donorContact: '+91 90000 00000', quantity: 1 },
      donor
    )
    pledgeID = p.ID
  })

  const noPrivateFields = (row, where) => {
    for (const f of PRIVATE) assert.equal(row[f], undefined, `${f} leaked through ${where}`)
  }

  it('returns only the public pledge fields', async () => {
    const { data } = await GET(`${D}/Pledges(${pledgeID})`, donor)
    assert.deepEqual(Object.keys(data).filter(k => !k.startsWith('@')).sort(), [...PUBLIC_PLEDGE].sort())
  })

  it('returns only public fields from the pledge action itself', async () => {
    const { data } = await POST(`${D}/Requests(${requestID})/DonorService.pledge`, { donor: 'Second Org', donorContact: 'x@example.org', quantity: 1 }, donor)
    noPrivateFields(data, 'the pledge action response')
  })

  it('keeps private fields out of $expand', async () => {
    const { data } = await GET(`${D}/Requests(${requestID})?$expand=pledges`, donor)
    assert.ok(data.pledges.length > 0)
    for (const p of data.pledges) noPrivateFields(p, '$expand=pledges')
    const { data: back } = await GET(`${D}/Pledges(${pledgeID})?$expand=request`, donor)
    for (const f of ['createdBy', 'modifiedBy']) assert.equal(back.request[f], undefined, `${f} leaked through $expand=request`)
  })

  for (const field of ['createdBy', 'modifiedBy', 'donorContact'])
    it(`rejects ${field} in $select, nested $select and $filter`, async () => {
      for (const url of [
        `${D}/Pledges?$select=${field}`,
        `${D}/Requests(${requestID})?$expand=pledges($select=${field})`,
        `${D}/Pledges?$filter=${field} ne null`
      ]) {
        const res = await fail(GET(url, donor))
        assert.equal(res.status, 400, url)
      }
    })

  it('does not declare private fields in the donor metadata', async () => {
    const { data } = await GET(`${D}/$metadata`, donor)
    const pledgeType = data.match(/<EntityType Name="Pledges">[\s\S]*?<\/EntityType>/)[0]
    for (const f of ['createdBy', 'modifiedBy', 'donorContact']) assert.ok(!pledgeType.includes(`"${f}"`), f)
  })

  // Everything a donor can reach, through any association, must stay free of these.
  const DENIED = ['createdBy', 'modifiedBy', 'modifiedAt', 'donorContact', 'contactPhone', 'coordinator', 'latitude', 'longitude', 'childrenUnder5', 'camp_ID', 'camp']
  const SECRETS = /Private Coordinator|98888 77777|90000 00000|"donor"\s*:\s*"donor"/

  it('declares no private property or association on any donor entity type', async () => {
    const { data } = await GET(`${D}/$metadata`, donor)
    const types = [...data.matchAll(/<EntityType Name="(\w+)"[^>]*>([\s\S]*?)<\/EntityType>/g)]
    assert.ok(types.length >= 8)
    for (const [, name, body] of types) {
      const members = [...body.matchAll(/<(?:Navigation)?Property Name="(\w+)"/g)].map(m => m[1])
      for (const f of DENIED) assert.ok(!members.includes(f), `${name}.${f} is exposed to donors`)
    }
    assert.ok(!/EntitySet Name="(Camps|Stock|CampHealth)"/.test(data))
  })

  it('rejects $expand on plain fields', async () => {
    const res = await fail(GET(`${D}/Pledges(${pledgeID})?$expand=donor`, donor))
    assert.equal(res.status, 400)
  })

  for (const path of [
    'Pledges(ID)?$expand=request',
    'Pledges(ID)?$expand=request($expand=pledges($expand=request($expand=pledges)))',
    'Pledges?$expand=*',
    'Requests(REQ)?$expand=*',
    'Requests(REQ)?$expand=pledges($expand=*)',
    'Requests(REQ)?$expand=standard($expand=*),sector,hazard,priority,status,pledges($expand=status,request)',
    'Requests(REQ)/pledges(ID)/request',
    'Standards?$expand=*'
  ])
    it(`keeps private data out of ${path}`, async () => {
      const url = `${D}/${path.replace('(ID)', `(${pledgeID})`).replace('(REQ)', `(${requestID})`)}`
      const { data } = await GET(url, donor)
      const body = JSON.stringify(data)
      for (const f of DENIED) assert.ok(!body.includes(`"${f}"`), `${f} in ${path}`)
      assert.ok(!SECRETS.test(body), `private value in ${path}`)
    })

  it('cannot use $search or $orderby to probe hidden fields', async () => {
    const { data } = await GET(`${D}/Pledges?$search=90000`, donor)
    assert.equal(data.value.length, 0)
    const { data: camps } = await GET(`${D}/Requests?$search=Private Coordinator`, donor)
    assert.equal(camps.value.length, 0)
    const res = await fail(GET(`${D}/Pledges?$orderby=createdBy`, donor))
    assert.equal(res.status, 400)
  })

  it('keeps contact and audit fields available to coordinators', async () => {
    const { data } = await GET(`${R}/Pledges(${pledgeID})`, coordinator)
    assert.equal(data.donorContact, '+91 90000 00000')
    assert.equal(data.createdBy, 'donor')
    assert.ok(data.createdAt)
  })
})
