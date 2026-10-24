// The Bun host (`src/bun/runtime.ts`) with the Zerops provider composed in: the runtime of the Zerops installation and
// of the local stack.

import { createRuntime as createBunRuntime, type Runtime, type RuntimeOverrides } from '../bun/runtime'
import { zeropsComposition } from './provider'

export type { Runtime, RuntimeOverrides } from '../bun/runtime'

export function createRuntime(source: Record<string, string | undefined> = process.env, overrides: RuntimeOverrides = {}): Runtime {
	return createBunRuntime(zeropsComposition, source, overrides)
}
