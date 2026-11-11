/**
 * Test-only clock for the overdue-review browser test (test/ui/overdue.js).
 * Loaded into the test server with `node --require`; the application never
 * loads it, and it is not part of the build. The offset in milliseconds is
 * read from RELIEFGRID_TEST_CLOCK_FILE at start and again on SIGUSR2, so the
 * test can move the server's "today" forward without touching any data.
 */
const fs = require('node:fs')

const file = process.env.RELIEFGRID_TEST_CLOCK_FILE
if (!file) throw new Error('test clock: RELIEFGRID_TEST_CLOCK_FILE is not set')

const RealDate = Date
let offset = 0
const read = () => { offset = Number(fs.readFileSync(file, 'utf8')) || 0 }
read()
process.on('SIGUSR2', read)

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args)
    else super(RealDate.now() + offset)
  }
  static now() { return RealDate.now() + offset }
}
globalThis.Date = ShiftedDate
