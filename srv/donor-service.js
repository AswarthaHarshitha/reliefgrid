const cds = require('@sap/cds')
const supply = require('./lib/supply')

module.exports = class DonorService extends cds.ApplicationService {
  init() {
    const { Requests, Pledges } = this.entities

    this.on('pledge', Requests, async req => {
      const ID = supply.keyOf(req.params.at(-1))
      // The projection only exposes requests from active camps.
      if (!(await SELECT.one.from(Requests, ID).columns('ID'))) return req.error(404, 'REQUEST_NOT_FOUND')
      const pledgeID = await supply.pledge(ID, req.data, req.user.id)
      req.info('PLEDGE_RECORDED')
      return SELECT.one.from(Pledges, pledgeID)
    })

    return super.init()
  }
}
