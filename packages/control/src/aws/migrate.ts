// An AWS installation's migrations: a one-off task before Control's service is updated will run
// `bun packages/control/src/aws/migrate.ts`.

import { runMigrationProcess } from '../bun/migrate'

if (import.meta.main) runMigrationProcess()
