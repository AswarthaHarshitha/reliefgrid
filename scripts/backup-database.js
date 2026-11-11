#!/usr/bin/env node
/**
 * Consistent backup of a ReliefGrid SQLite database (Stage F).
 *
 *   node scripts/backup-database.js <database file> <backup directory>
 *
 * Uses SQLite's VACUUM INTO, which writes a complete, consistent copy even while
 * the server is running (readers and writers are not blocked). The copy is then
 * opened read-only and checked with PRAGMA integrity_check, its tables are
 * counted against the source, and a SHA-256 manifest is written next to it.
 * The source database is only read. An existing backup file is never overwritten.
 * Exit code 0 only when the backup is complete and verified.
 */
const { DatabaseSync } = require('node:sqlite')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function backup(source, directory, { now = new Date() } = {}) {
  if (!source || !directory) throw new Error('usage: node scripts/backup-database.js <database file> <backup directory>')
  if (!fs.existsSync(source)) throw new Error(`no database at ${source}`)
  fs.mkdirSync(directory, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const target = path.join(directory, `${path.basename(source, path.extname(source))}-${stamp}.sqlite`)
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite ${target}`)

  const db = new DatabaseSync(source, { readOnly: true })
  let counts
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    counts = tableCounts(db)
  } finally {
    db.close()
  }

  const copy = new DatabaseSync(target, { readOnly: true })
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0])
    if (integrity.join() !== 'ok') throw new Error(`integrity check failed: ${integrity.join('; ')}`)
    const copied = tableCounts(copy)
    for (const [table, n] of Object.entries(counts))
      if (copied[table] !== n) throw new Error(`table ${table}: ${n} rows in the source, ${copied[table]} in the backup`)
  } finally {
    copy.close()
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  fs.writeFileSync(`${target}.sha256`, `${sha256}  ${path.basename(target)}\n`)
  return { target, sha256, tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0) }
}

function tableCounts(db) {
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all().map(t => t.name)
  return Object.fromEntries(tables.map(t => [t, Number(db.prepare(`select count(*) as n from "${t.replace(/"/g, '""')}"`).get().n)]))
}

if (require.main === module) {
  try {
    const result = backup(process.argv[2], process.argv[3])
    console.log(`backup written and verified: ${result.target}\n  ${result.tables} tables, ${result.rows} rows, sha256 ${result.sha256}`)
  } catch (e) {
    console.error(`backup failed: ${e.message}`)
    process.exit(1)
  }
}

module.exports = { backup }
