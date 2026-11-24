// An AWS installation's maintenance pass: a scheduled task will run `bun packages/control/src/aws/cron.ts`.

import { runMaintenanceProcess } from '../bun/cron'
import { createRuntime } from './runtime'

if (import.meta.main) runMaintenanceProcess(createRuntime)
