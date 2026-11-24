// The Bun host (`src/bun/runtime.ts`) with the AWS provider composed in: the runtime of an AWS installation.

import { createRuntime as createBunRuntime, type Runtime, type RuntimeOverrides } from '../bun/runtime'
import { awsComposition } from './provider'

export type { Runtime, RuntimeOverrides } from '../bun/runtime'

export function createRuntime(source: Record<string, string | undefined> = process.env, overrides: RuntimeOverrides = {}): Runtime {
	return createBunRuntime(awsComposition, source, overrides)
}
