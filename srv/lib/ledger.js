const cds = require('@sap/cds')

/**
 * Append-only stock ledger and supply audit trail (ARCH-05). Both write in the
 * caller's transaction, so a movement or an event exists exactly when the
 * operation it describes succeeded. Nothing here updates or deletes a row.
 */

const now = () => new Date().toISOString()
const actorOf = actor => actor ?? cds.context?.user?.id ?? 'system'

/** Records a change of one stock line, with its quantity before and after. */
async function movement({ stockID, campID, standardCode, kind, before, after, change = null, functionalBefore = null, functionalAfter = null, receiptID = null, note = null, actor }) {
  const { StockMovements } = cds.entities('reliefgrid')
  await INSERT.into(StockMovements).entries({
    ID: cds.utils.uuid(), stock_ID: stockID, camp_ID: campID, standardCode, movedAt: now(), movedBy: actorOf(actor), kind,
    quantityBefore: before ?? null, quantityAfter: after ?? null, change, functionalBefore, functionalAfter, receipt_ID: receiptID, note
  })
}

/** Records one supply operation; the camp and request are copied as plain values. */
async function event(kind, { campID = null, campName = null, requestID = null, pledgeID = null, detail = null, actor } = {}) {
  const { AuditEvents, Camps } = cds.entities('reliefgrid')
  if (campID && campName === null) campName = (await SELECT.one.from(Camps).columns('name').where({ ID: campID }))?.name ?? null
  await INSERT.into(AuditEvents).entries({
    ID: cds.utils.uuid(), occurredAt: now(), actor: actorOf(actor), kind, campID, campName, requestID, pledgeID,
    detail: detail === null ? null : String(detail).slice(0, 500)
  })
}

/** Locks a camp row for the rest of the transaction (ARCH-01) and returns it, read again inside the lock. */
async function lockCamp(campID, columns = ['ID', 'name', 'status_code', 'headcount']) {
  const { Camps } = cds.entities('reliefgrid')
  return SELECT.one.from(Camps).columns(...columns).where({ ID: campID }).forUpdate()
}

module.exports = { movement, event, lockCamp }
