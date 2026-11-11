# Test fixtures

## b41-database.sqlite.gz

A SQLite database written by the **B4.1 application**, used by `test/target-migration.test.js` to verify the B4.2 upgrade along CAP's real schema-evolution path. The tests decompress it into a temporary directory; the fixture itself is never written.

- Created on 9 November 2026 from the B4.1 source backed up before B4.2 (`~/reliefgrid-backups/2026-11-09-pre-B4.2/source`, verified against its SHA-256 manifest), through the B4.1 OData API with mocked test users.
- Synthetic records only: one camp ("B4.1 Camp", 200 people), stock counts, raised requests, one pledge with a partial delivery, a planning-settings change, two applicability decisions approved by a second Administrator (soap not applicable, nets applicable), one request review resolved as Keep, and the assessment history these produced.
- SHA-256 of the uncompressed file: `4b735310e142c94abbf04470989c7f1ba91a49f58fdb828db22bd15dc726758a`.

It contains no real camp, person or donor data.

## report-public-address.js

Test-only preload used by the start-up network-guard tests.
