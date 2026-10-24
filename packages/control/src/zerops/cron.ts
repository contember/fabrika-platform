// The Zerops installation's maintenance pass: `zerops.yaml` → `run.crontab` runs `bun packages/control/src/zerops/cron.ts`.

import { runMaintenanceProcess } from '../bun/cron'
import { createRuntime } from './runtime'

if (import.meta.main) runMaintenanceProcess(createRuntime)
