# Integration tests

Unit tests live next to the code they cover (`src/**/*.test.ts`). This directory holds the
cross-subsystem tests that need real infrastructure:

- end-to-end bidirectional sync against a dockerised Samba server (T22)
- privileged-helper argument fuzzing (T7)
- migration apply/rollback against a scratch database (T3/T4)
- API contract tests via Supertest (T29/T30)

They run under the same Jest configuration as the unit tests.
