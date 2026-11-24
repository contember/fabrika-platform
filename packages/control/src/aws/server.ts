// An AWS installation's Control process: its ECS task's command will run `bun packages/control/src/aws/server.ts`.

import { runControlServer } from '../bun/server'
import { createRuntime } from './runtime'

export { startControlServer } from '../bun/server'

if (import.meta.main) runControlServer(createRuntime)
