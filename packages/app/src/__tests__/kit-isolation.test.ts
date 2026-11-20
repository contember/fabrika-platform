// The guard against state leaking between test files that share one process (`bun test --no-isolate`, as a
// `--parallel` worker runs them): the files of `kit-isolation-fixture/` each boot the same application's kit over a
// fresh database, check that they start clean (no other file's rows, deps, clock, module state or mock), and
// leave state behind; a generated policy isolation file and a generated endpoint access file run among them. They pass
// in randomized orders on two workers, and a file that leaks a clock, a module's value or a mock fails the file after it
// in one process.

import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const FIXTURE = new URL('./kit-isolation-fixture/', import.meta.url)
const fixture = (name: string): string => fileURLToPath(new URL(`${name}.fixture.ts`, FIXTURE))
const CLEAN = ['one', 'two', 'three', 'four', 'five'].map(fixture)
const GENERATED = ['policy', 'endpoint-access'].map(fixture)

/** A `bun test --no-isolate` of `files`: one process, in the order given, unless `args` add workers or randomize it. */
async function runWithoutIsolation(
	files: readonly string[],
	args: readonly string[] = [],
): Promise<{ readonly code: number; readonly output: string }> {
	const child = Bun.spawn([process.execPath, 'test', '--no-isolate', ...args, ...files], {
		cwd: fileURLToPath(FIXTURE),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	return { code, output: `${stdout}${stderr}` }
}

describe('test files of one application in one process', () => {
	test.each([1, 2, 3])('start clean in the randomized order of seed %d', async (seed) => {
		const { code, output } = await runWithoutIsolation([...CLEAN, ...GENERATED], ['--parallel=2', '--randomize', `--seed=${seed}`])
		expect(output).toContain(`${CLEAN.length + GENERATED.length} pass`)
		expect(code, output).toBe(0)
	}, 60_000)

	test.each([
		['clock', 'a file left the clock set'],
		['module', 'a file changed or mocked a module'],
		['mock', 'a file changed or mocked a module'],
	])('a file that leaks a %s fails the next one', async (kind, message) => {
		const { code, output } = await runWithoutIsolation([fixture(`leaks-${kind}`), fixture('one')])
		expect(output).toContain(message)
		expect(code).not.toBe(0)
	}, 60_000)
})
