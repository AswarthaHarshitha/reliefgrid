const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { plan, requestStatus, addDays } = require('../srv/lib/supply')

const today = new Date('2026-11-01T08:00:00Z')

describe('replenishment plan', () => {
  const water = { standard_code: 'WATER', basis: 'Consumption', perPerson: 15, headcount: 100, quantity: 1000, severity: 1 }
  const toilets = { standard_code: 'TOILET', basis: 'Coverage', perPerson: 0.05, headcount: 100, quantity: 2, severity: 1 }

  it('tops consumables up to the target days of supply', () => {
    const [line] = plan([water], {}, 7, today)
    assert.equal(line.quantity, 100 * 15 * 7 - 1000)
    assert.equal(line.priority_code, 1)
    // 1,000 L at 1,500 L/day runs out today
    assert.equal(line.neededBy, '2026-11-01')
  })

  it('subtracts goods that are already on their way', () => {
    const [line] = plan([water], { WATER: 5000 }, 7, today)
    assert.equal(line.quantity, 10500 - 1000 - 5000)
  })

  it('tops coverage items up to the reference requirement', () => {
    const [line] = plan([toilets], {}, 7, today)
    assert.equal(line.quantity, 3)
    assert.equal(line.neededBy, '2026-11-02')
  })

  it('rounds fractional needs up to whole units', () => {
    const [line] = plan([{ ...toilets, headcount: 41, quantity: 0 }], {}, 7, today)
    assert.equal(line.quantity, 3) // 41 people need 2.05 toilets
  })

  it('raises nothing when stock and pipeline meet the target', () => {
    assert.deepEqual(plan([{ ...water, quantity: 11000, severity: 3 }], {}, 7, today), [])
    assert.deepEqual(plan([water], { WATER: 9500 }, 7, today), [])
  })

  it('ignores camps with nobody sheltered', () => {
    assert.deepEqual(plan([{ ...water, headcount: 0 }], {}, 7, today), [])
  })

  it('ignores camps whose population is not recorded', () => {
    assert.deepEqual(plan([{ ...water, headcount: null }], {}, 7, today), [])
  })

  it('never plans from stock that has not been counted', () => {
    assert.deepEqual(plan([{ ...water, quantity: null, severity: null }], {}, 7, today), [])
    // a counted zero is real: the full target is requested
    assert.equal(plan([{ ...water, quantity: 0 }], {}, 7, today)[0].quantity, 100 * 15 * 7)
  })

  it('orders the most urgent lines first', () => {
    const soap = { standard_code: 'SOAP', basis: 'Consumption', perPerson: 8.333333, headcount: 100, quantity: 3000, severity: 2 }
    const lines = plan([soap, toilets, water], {}, 7, today)
    assert.deepEqual(lines.map(l => l.standard_code), ['WATER', 'TOILET', 'SOAP'])
  })
})

describe('request status', () => {
  const base = { status_code: 'OPEN', quantity: 100, pledgedQuantity: 0, deliveredQuantity: 0 }
  it('follows pledges and deliveries', () => {
    assert.equal(requestStatus(base), 'OPEN')
    assert.equal(requestStatus({ ...base, pledgedQuantity: 40 }), 'PARTIAL')
    assert.equal(requestStatus({ ...base, pledgedQuantity: 100 }), 'PLEDGED')
    assert.equal(requestStatus({ ...base, pledgedQuantity: 100, deliveredQuantity: 100 }), 'FULFILLED')
  })
  it('keeps cancelled requests cancelled', () => {
    assert.equal(requestStatus({ ...base, status_code: 'CANCELLED', pledgedQuantity: 100 }), 'CANCELLED')
  })
  it('treats decimal strings from the database as numbers', () => {
    assert.equal(requestStatus({ ...base, quantity: '100.00', pledgedQuantity: '99.50' }), 'PARTIAL')
  })
})

describe('addDays', () => {
  it('crosses month boundaries', () => {
    assert.equal(addDays(3, new Date('2026-10-30T00:00:00Z')), '2026-11-02')
  })
})
