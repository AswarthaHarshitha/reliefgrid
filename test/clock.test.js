process.env.CDS_ENV ??= 'test'
require('./helpers/test-users')
const cds = require('@sap/cds')
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const clock = require('../srv/lib/clock')

const { GET } = cds.test(__dirname + '/..')
const coordinator = { auth: { username: 'coordinator', password: 'test' } }

describe('ARCH-08 operation time zone', () => {
  it('a moment late in the UTC day is already the next day in India', () => {
    const lateUTC = new Date('2026-11-10T20:00:00Z')
    assert.equal(clock.dateOf(lateUTC, 'UTC'), '2026-11-10')
    assert.equal(clock.dateOf(lateUTC, 'Asia/Kolkata'), '2026-11-11', '01:30 on 11 November in India')
    assert.equal(clock.dateOf(new Date('2026-11-10T18:29:59Z'), 'Asia/Kolkata'), '2026-11-10', 'one second before midnight in India')
  })

  it('adds calendar days in the operation time zone, across a month end', () => {
    const before = process.env.RELIEFGRID_TIME_ZONE
    try {
      process.env.RELIEFGRID_TIME_ZONE = 'Asia/Kolkata'
      assert.equal(clock.timeZone(), 'Asia/Kolkata')
      assert.equal(clock.addDays(7, new Date('2026-11-30T19:00:00Z')), '2026-12-08', 'already 1 December in India, plus 7 days')
      process.env.RELIEFGRID_TIME_ZONE = 'UTC'
      assert.equal(clock.addDays(7, new Date('2026-11-30T19:00:00Z')), '2026-12-07')
    } finally {
      if (before === undefined) delete process.env.RELIEFGRID_TIME_ZONE
      else process.env.RELIEFGRID_TIME_ZONE = before
    }
  })

  it('an unknown time zone is refused instead of silently using another day', () => {
    assert.throws(() => clock.assertTimeZone('Mars/Olympus_Mons'), /unknown operation time zone "Mars\/Olympus_Mons"/)
    assert.equal(clock.assertTimeZone('Asia/Kolkata'), 'Asia/Kolkata')
  })

  it('without configuration the operation stays on UTC days, as before', async () => {
    const { data } = await GET('/odata/v4/relief/operation()', coordinator)
    assert.equal(data.timeZone, 'UTC')
    assert.equal(data.today, new Date().toISOString().slice(0, 10))
  })
})
