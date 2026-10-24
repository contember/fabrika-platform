// The Zerops installation's Control process: `zerops.yaml` → `run.start` runs `bun packages/control/src/zerops/server.ts`.

import { runControlServer } from '../bun/server'
import { createRuntime } from './runtime'

export { startControlServer } from '../bun/server'

if (import.meta.main) runControlServer(createRuntime)
