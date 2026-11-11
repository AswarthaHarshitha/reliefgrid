/**
 * Test-only worker: runs the scheduled-decision job once against a database
 * file, as a second application instance would. Waits until GO_AT (epoch ms)
 * so that two workers run at the same moment. Prints a JSON line.
 */
const cds = require('@sap/cds')
const path = require('node:path')

// A second process may fail to open a SQLite file another process is writing (SQLITE_BUSY); it then does nothing.
const giveUp = e => { console.log(JSON.stringify({ activated: 0, error: e.message })); process.exit(0) }
process.on('unhandledRejection', giveUp)
process.on('uncaughtException', giveUp)

;(async () => {
  const [dbFile, goAt] = process.argv.slice(2)
  cds.root = path.join(__dirname, '..', '..')
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: dbFile } }
  cds.model = cds.compile.for.nodejs(await cds.load(['db', 'srv']))
  await cds.connect.to('db')
  await new Promise(r => setTimeout(r, Math.max(0, Number(goAt) - Date.now())))
  try {
    const activated = await require('../../srv/lib/decisions').activateDue()
    console.log(JSON.stringify({ activated, ran: true }))
  } catch (e) {
    // e.g. SQLITE_BUSY: this instance's transaction was rolled back
    console.log(JSON.stringify({ activated: 0, ran: true, error: e.message }))
  }
  process.exit(0)
})().catch(giveUp)
