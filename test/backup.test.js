const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { backup } = require('../scripts/backup-database')

describe('Stage F: database backup script', () => {
  let dir, source
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliefgrid-backup-test-'))
    source = path.join(dir, 'source.sqlite')
    const db = new DatabaseSync(source)
    db.exec("create table reliefgrid_Camps (ID text primary key, name text); create table reliefgrid_Stock (ID text primary key, quantity integer)")
    for (let i = 0; i < 25; i++) db.prepare('insert into reliefgrid_Camps values (?, ?)').run(`c${i}`, `Camp ${i}`)
    for (let i = 0; i < 40; i++) db.prepare('insert into reliefgrid_Stock values (?, ?)').run(`s${i}`, i)
    db.close()
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('writes a complete, verified copy with a SHA-256 manifest, and only reads the source', () => {
    const before = sha(source)
    const result = backup(source, path.join(dir, 'backups'), { now: new Date('2026-11-11T10:00:00Z') })
    assert.equal(sha(source), before, 'the source is unchanged')
    assert.equal(result.tables, 2)
    assert.equal(result.rows, 65)
    assert.equal(fs.readFileSync(`${result.target}.sha256`, 'utf8'), `${result.sha256}  ${path.basename(result.target)}\n`)
    assert.equal(sha(result.target), result.sha256)
    const copy = new DatabaseSync(result.target, { readOnly: true })
    assert.equal(copy.prepare('select count(*) as n from reliefgrid_Camps').get().n, 25)
    assert.equal(copy.prepare("select name from reliefgrid_Camps where ID = 'c7'").get().name, 'Camp 7')
    copy.close()
  })

  it('never overwrites an existing backup', () => {
    const at = new Date('2026-11-11T11:00:00Z')
    backup(source, path.join(dir, 'backups'), { now: at })
    assert.throws(() => backup(source, path.join(dir, 'backups'), { now: at }), /refusing to overwrite/)
  })

  it('fails clearly without a database or arguments', () => {
    assert.throws(() => backup(path.join(dir, 'missing.sqlite'), dir), /no database at/)
    assert.throws(() => backup(), /usage:/)
  })
})
