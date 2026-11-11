const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

const methodology = JSON.parse(read('app/methodology/webapp/model/methodology.json'))
const [header, ...rows] = read('db/data/reliefgrid-Standards.csv').trim().split('\n').map(l => l.split(';'))
const standards = rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])))
const byCode = Object.fromEntries(methodology.indicators.map(i => [i.code, i]))
const all = i => JSON.stringify(i)

describe('methodology page content', () => {
  it('documents exactly the indicators ReliefGrid calculates with', () => {
    assert.deepEqual(methodology.indicators.map(i => i.code).sort(), standards.map(s => s.code).sort())
    assert.equal(methodology.indicators.length, 9)
  })

  it('shows the same calculation value and unit as the reference data', () => {
    for (const s of standards) {
      const { calculation } = byCode[s.code]
      assert.equal(calculation.value, s.perHousehold ? Number(s.perHousehold) : s.perPerson === '' ? null : Number(s.perPerson), s.code)
      assert.equal(calculation.unit, s.unit, s.code)
    }
  })

  it('gives every indicator a complete, short handbook reference', () => {
    const required = ['name', 'sector', 'chapter', 'standard', 'element', 'pages', 'quote', 'quotePage', 'summary', 'use']
    for (const i of methodology.indicators) {
      for (const field of required) assert.ok(String(i[field] ?? '').trim(), `${i.code}.${field}`)
      assert.ok(i.reference.value && i.reference.unit, `${i.code}.reference`)
      assert.ok(i.qualifications.length > 0, `${i.code}.qualifications`)
      assert.match(i.pages, /^\d{2,3}/, `${i.code}.pages`)
      assert.ok(i.pages.includes(i.quotePage), `${i.code}: quoted page is one of the cited pages`)
      assert.ok(i.quote.split(/\s+/).length <= 40, `${i.code}: quotation is short`)
      assert.ok(['verified', 'conditional', 'notSphere'].includes(i.verification), `${i.code}.verification`)
      assert.ok(['sphere', 'converted', 'planning', 'none'].includes(i.valueType), `${i.code}.valueType`)
    }
  })

  it('records the source edition, checksum and verification limits', () => {
    const { source } = methodology
    assert.equal(source.edition, 'Fourth edition, 2018')
    assert.equal(source.sha256, 'eeb7e680c296e15389ca8a1e5882a3796f23cbba31cfb21dd4661332c4c8cf63')
    assert.match(source.editionStatus, /2018 edition remains the official reference/)
    assert.match(source.editionStatus, /Q4 2028/)
    assert.equal(source.officialEditionsUrl, 'https://spherestandards.org/handbook/handbook-editions/')
    assert.equal(source.officialRevisionFaqUrl, 'https://spherestandards.org/handbook-revision-2026-2028/faqs/')
    assert.match(source.verificationNote, /not been compared/)
    assert.match(source.verificationNote, /does not show that the two files are identical/)
  })

  it('keeps the review findings for each figure', () => {
    const water = all(byCode.WATER)
    assert.match(water, /never a “maximum”/)
    assert.match(water, /7\.5 litres/)
    assert.match(water, /50 litres/)

    assert.equal(byCode.FOOD.valueType, 'planning')
    assert.match(all(byCode.FOOD), /planning figure/)
    assert.match(all(byCode.FOOD), /not a Sphere measurement/)

    for (const code of ['SOAP', 'LAUNDRY']) {
      assert.match(byCode[code].reference.unit, /per month/, code)
      assert.equal(byCode[code].valueType, 'converted', code)
    }

    assert.match(byCode.CONTAINER.reference.unit, /per household/)
    assert.equal(byCode.CONTAINER.reference.value, '2')
    assert.equal(byCode.CONTAINER.valueType, 'planning')

    assert.match(all(byCode.SHELTER), /excluding cooking space, bathing area and sanitation/)
    assert.match(all(byCode.SHELTER), /4\.5–5\.5/)

    const toilet = all(byCode.TOILET)
    assert.match(toilet, /1 per 50/)
    assert.match(toilet, /1 per 20/)
    assert.match(toilet, /3:1|3 female toilets for every male/)

    assert.match(byCode.TAP.reference.unit, /7\.5 litres per minute/)

    assert.equal(byCode.NET.verification, 'notSphere')
    assert.equal(byCode.NET.valueType, 'none', 'ReliefGrid has no requirement for nets (B4.1)')
    assert.equal(byCode.NET.calculation.value, null)
    assert.doesNotMatch(byCode.NET.reference.value, /\d/, 'no ratio is attributed to Sphere')
    assert.match(all(byCode.NET), /does not prescribe a ratio/)
  })

  it('marks exactly the five adjustable planning settings, with defaults matching the service', () => {
    const { DEFAULTS, FIELDS } = require('../srv/lib/planning')
    const rows = methodology.planningChoices.filter(c => c.setting)
    assert.deepEqual(rows.map(r => r.setting).sort(), [...FIELDS].sort())
    for (const r of rows) assert.equal(r.template.replace('{0}', DEFAULTS[r.setting]), r.value, r.setting)
  })

  it('labels ReliefGrid planning choices as such', () => {
    const values = methodology.planningChoices.map(c => `${c.choice}: ${c.value}`).join('\n')
    for (const needle of [/Under 2 days/, /Under 5 days/, /Under 50 %/, /Under 90 %/, /7 days/, /5 people/, /30 days/])
      assert.match(values, needle)
  })
})

describe('mosquito nets (B4.1)', () => {
  it('carries no net ratio anywhere: reference data, methodology, README or app texts', () => {
    const net = standards.find(s => s.code === 'NET')
    assert.equal(net.perPerson, '', 'no per-person figure')
    assert.equal(net.applicability, 'DECISION_REQUIRED')
    const RATIO = /1 per 2\b|one net (per|for every) two|per 2 people|1-per-2|0\.5 nets/i
    for (const f of ['db/data/reliefgrid-Standards.csv', 'app/methodology/webapp/model/methodology.json', 'README.md',
      'app/command/webapp/i18n/i18n.properties', 'app/methodology/webapp/i18n/i18n.properties', '_i18n/i18n.properties', '_i18n/messages.properties'])
      assert.doesNotMatch(read(f), RATIO, f)
  })
})

describe('reference data citations', () => {
  it('cites the handbook page for every Sphere figure and never attributes the net ratio to Sphere', () => {
    for (const s of standards) assert.match(s.reference, /Sphere Handbook 2018, .*p\. \d+/, s.code)
    const net = standards.find(s => s.code === 'NET').reference
    assert.match(net, /^Not a Sphere figure/)
    assert.doesNotMatch(net, /WHO/)
    assert.match(standards.find(s => s.code === 'CONTAINER').reference, /ReliefGrid planning assumption/)
    assert.match(standards.find(s => s.code === 'FOOD').reference, /ReliefGrid planning assumption/)
  })
})

describe('terminology', () => {
  const SOURCES = ['README.md', 'package.json', 'app', 'srv', 'db', '_i18n']
  const files = []
  const walk = p => {
    const full = path.join(ROOT, p)
    if (fs.statSync(full).isDirectory()) for (const f of fs.readdirSync(full)) walk(path.join(p, f))
    else if (/\.(cds|js|json|properties|xml|html|csv|md|css)$/.test(p)) files.push(p)
  }
  SOURCES.forEach(walk)

  it('never claims compliance with, or certification by, Sphere', () => {
    const banned = /sphere[\s-]*(compliance|compliant|certified|certification|minimum)|certified by sphere/i
    const offenders = files.filter(f => banned.test(read(f)))
    assert.deepEqual(offenders, [])
  })

  it('names the camp score "Applicable Indicators Met"', () => {
    assert.match(read('_i18n/i18n.properties'), /^Compliance=Applicable Indicators Met$/m)
    assert.match(read('app/command/webapp/i18n/i18n.properties'), /^colCompliance=Applicable Indicators Met$/m)
  })

  it('shows the disclaimer on the methodology page and the Command Center', () => {
    assert.match(read('app/methodology/webapp/i18n/i18n.properties'), /^disclaimer=.*not an official Sphere assessment/m)
    assert.match(read('app/command/webapp/i18n/i18n.properties'), /^disclaimer=.*not an official Sphere assessment/m)
  })
})
