# Deployment

ReliefGrid runs as one container: the CAP service serves the OData APIs and the apps, with SQLite on a persistent volume. This guide covers Render; any Docker host works the same way (see the end).

## What the container expects

| Setting | Value | Where it comes from |
| --- | --- | --- |
| `NODE_ENV` | `production` | Dockerfile |
| `CDS_ENV` | `selfhost` | Dockerfile |
| `CDS_REQUIRES_DB_KIND`, `CDS_REQUIRES_AUTH_KIND` | `sqlite`, `basic` | Dockerfile. `NODE_ENV=production` also activates CAP's `production` profile (SAP HANA, XSUAA), which is applied after `selfhost`; these two keep the container on SQLite and basic authentication. A test checks the resolved configuration. |
| Database | `/data/reliefgrid.sqlite` | the `selfhost` profile; `/data` must be a persistent volume |
| `CDS_CONFIG` | user accounts and roles (JSON) | **secret**, set on the host only |
| `RELIEFGRID_TIME_ZONE` | IANA zone of the operation | optional, default UTC |
| `PORT`, `HOST` | port and address | the host platform (Render sets `PORT`) |

Roles: `Coordinator` (camp work), `Administrator` (with Coordinator: approvals, settings), `Donor` (Pledge Board only).

```json
{"requires":{"auth":{"users":{
  "<user>": {"password": "<strong, unique password>", "roles": ["Coordinator", "Administrator"]},
  "<donor organisation>": {"password": "<strong, unique password>", "roles": ["Donor"]}
}}}}
```

Never commit this value. The accounts in `test/helpers` exist only for the automated tests; they are not part of the image's configuration, so they do not exist in a deployment unless someone adds them to `CDS_CONFIG` (do not).

## Render

1. **Create the service.** In the Render dashboard, create a Blueprint from the repository; `render.yaml` defines a Docker web service `reliefgrid` with a 1 GB persistent disk at `/data`, `/ready` as health check and automatic deploys off. A persistent disk needs a paid instance type.
2. **Set the secrets.** In the service's environment, set `CDS_CONFIG` (the JSON above) as a secret. Set `RELIEFGRID_TIME_ZONE` to the zone where the camps are, for example `Asia/Kolkata`.
3. **Deploy.** Start a manual deploy. The first start creates the schema and reference data; no business data is created.
4. **Verify** (next section) before announcing the URL.

### Upgrading an existing deployment

1. **Back up first**, from the service shell:
   ```bash
   node scripts/backup-database.js /data/reliefgrid.sqlite /data/backups
   ```
   The script writes a consistent copy (SQLite `VACUUM INTO`, safe while the server runs), checks its integrity and row counts, and writes a SHA-256 manifest. Copy the backup off the instance as well.
2. Deploy the new version. On start-up the schema evolves in place; existing rows are not changed. A change of reference figures writes one explained assessment record per active camp.
3. Verify.
4. **Rollback** if needed: older code refuses to start on a newer database and leaves it untouched. Stop the service, restore the backup file to `/data/reliefgrid.sqlite` (remove `-wal` and `-shm` files of the newer database), and deploy the previous version.

## Verification after every deployment

| Check | Expected |
| --- | --- |
| `GET /health` | `200 {"status":"ok"}` |
| `GET /ready` | `200 {"status":"ready"}` (database readable) |
| `GET /odata/v4/relief/Camps` without sign-in | `401` |
| the same as a donor account | `403` |
| as a coordinator | `200` |
| `GET /odata/v4/donor/Requests` as a coordinator without Donor | `403` |
| a test account (`admin` / `test`) | `401` |
| `GET /command/webapp/test/unit/unitTests.qunit.html` | `404` |
| response headers | `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security` |
| home page as coordinator, administrator and donor | each sees only their applications; no console errors |
| a camp page on a phone-width screen | no horizontal scrolling |

## Other Docker hosts

```bash
docker build -t reliefgrid .
docker run -d --name reliefgrid -p 4004:4004 -v reliefgrid-data:/data \
  -e CDS_CONFIG="$RELIEFGRID_USERS" -e RELIEFGRID_TIME_ZONE=Asia/Kolkata reliefgrid
```

Terminate HTTPS in front of the container (reverse proxy or the platform's load balancer): basic authentication sends the password with every request.

## SAP BTP

`mta.yaml` builds for SAP HANA Cloud with XSUAA and an approuter (`mbt build`, `cf deploy mta_archives/*.mtar`). Role collections *Coordinator*, *Planning Administrator* and *Donor* are created but assigned to nobody. Before production use on HANA, run the checks in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md), including parallel-transaction tests, which have not been run on HANA.
