const cds = require('@sap/cds')

module.exports = class AccessService extends cds.ApplicationService {
  init() {
    this.on('access', req => ({
      planner: req.user.is('Coordinator'),
      administrator: req.user.is('Administrator'),
      donor: req.user.is('Donor')
    }))
    return super.init()
  }
}
