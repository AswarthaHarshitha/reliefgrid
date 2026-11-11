/**
 * Test-only users for mocked authentication. They live here, not in
 * package.json, so no test credentials reach the build output. Require this
 * before '@sap/cds': CAP reads CDS_CONFIG when it loads its configuration.
 */
const USERS = {
  coordinator: { password: 'test', roles: ['Coordinator'] },
  admin: { password: 'test', roles: ['Coordinator', 'Administrator'] },
  // a second Administrator, for two-person approval
  admin2: { password: 'test', roles: ['Coordinator', 'Administrator'] },
  // SEC-06: donors have the Donor role; a signed-in user without it cannot use the Pledge Board
  donor: { password: 'test', roles: ['Donor'] },
  // a second donor organisation, to show that donors see only their own pledges
  donor2: { password: 'test', roles: ['Donor'] },
  visitor: { password: 'test', roles: [] }
}

const config = process.env.CDS_CONFIG ? JSON.parse(process.env.CDS_CONFIG) : {}
config.requires = { ...config.requires, auth: { kind: 'mocked', users: USERS } }
process.env.CDS_CONFIG = JSON.stringify(config)

module.exports = { USERS }
