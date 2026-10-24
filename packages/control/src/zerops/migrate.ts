// The Zerops installation's migrations: `zerops.yaml` → `run.initCommands` runs `bun packages/control/src/zerops/migrate.ts`.

import { runMigrationProcess } from '../bun/migrate'

if (import.meta.main) runMigrationProcess()
