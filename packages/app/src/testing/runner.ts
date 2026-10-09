// The test functions the generated tests register through. The platform's run preloads `@fabrika/app/testing/preload`,
// which captures Bun's own `test`, `describe`, `expect` and `afterAll` before any application module loads, so a
// `mock.module('bun:test', …)` in application code cannot replace what the generated tests use. Each case counts
// the `expect` calls it ran; one that ran none fails, whatever the runner reports.

import * as bunTest from 'bun:test'

interface TestRunner {
	readonly test: typeof bunTest.test
	readonly describe: typeof bunTest.describe
	readonly expect: typeof bunTest.expect
	readonly afterAll: typeof bunTest.afterAll
}

const RUNNER = Symbol.for('fabrika.test-runner')

function isRunner(value: unknown): value is TestRunner {
	return typeof value === 'object' && value !== null
		&& ['test', 'describe', 'expect', 'afterAll'].every((name) => typeof Reflect.get(value, name) === 'function')
}

/** Captures Bun's test functions process-wide, once; the platform's preload calls it before the application loads. */
export function installTestRunner(): void {
	if (isRunner(Reflect.get(globalThis, RUNNER))) {
		return
	}
	const captured: TestRunner = Object.freeze({ test: bunTest.test, describe: bunTest.describe, expect: bunTest.expect, afterAll: bunTest.afterAll })
	Object.defineProperty(globalThis, RUNNER, { value: captured, writable: false, configurable: false, enumerable: false })
}

/** The captured functions, or, in a run without the preload, those this module imported. */
function runner(): TestRunner {
	const installed: unknown = Reflect.get(globalThis, RUNNER)
	return isRunner(installed) ? installed : bunTest
}

let expectCalls = 0

export function describe(name: string, body: () => void): void {
	runner().describe(name, body)
}

/** Registers a case that fails unless its body ran at least one `expect`. */
export function test(name: string, body: () => Promise<void>): void {
	runner().test(name, async () => {
		const before = expectCalls
		await body()
		if (expectCalls === before) {
			throw new Error(`the generated case '${name}' ran no expect, so it proved nothing`)
		}
	})
}

export function expect<T>(value: T): ReturnType<typeof bunTest.expect<T>> {
	expectCalls++
	return runner().expect(value)
}

export function afterAll(body: () => Promise<void>): void {
	runner().afterAll(body)
}
