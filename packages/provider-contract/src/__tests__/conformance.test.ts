import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { describeControlProviderConformance } from '../conformance'
import { memoryHarness } from './fixtures/memory-provider'

describeControlProviderConformance('MemoryProvider', memoryHarness())

/** The suite's own cases register through `bun:test`, so a suite that must fail a provider runs in a separate process. */
async function runFixture(name: string): Promise<{ readonly exitCode: number; readonly output: string }> {
	const fixture = join(import.meta.dir, 'fixtures', name)
	const run = Bun.spawn([process.execPath, 'test', fixture], { stdout: 'pipe', stderr: 'pipe' })
	const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
	return { exitCode, output: `${stdout}\n${stderr}` }
}

test('the suite fails a provider that stops its work when its lease is lost', async () => {
	const { exitCode, output } = await runFixture('cancelling-provider.ts')

	expect(exitCode).not.toBe(0)
	for (
		const name of [
			'a lease lost at any event of a deploy stops nothing, and the deploy claims no success',
			'a lease lost once the cloud accepted the deploy stops nothing, in the deploy, a reconcile or a cancel',
		]
	) {
		expect(output).toContain(`(fail) CancellingProvider conforms to ControlProvider > ${name}`)
	}
	expect(output).toContain(' 2 fail')
}, 30_000)

test('the suite fails a provider whose recorded state is larger than Control stores', async () => {
	const { exitCode, output } = await runFixture('oversized-state-provider.ts')

	expect(exitCode).not.toBe(0)
	for (
		const name of [
			'a deploy succeeds, and nothing it reports carries a credential',
			'a lease lost at any event of a deploy stops nothing, and the deploy claims no success',
		]
	) {
		expect(output).toContain(`(fail) OversizedStateProvider conforms to ControlProvider > ${name}`)
	}
	expect(output).toContain(" over Control's limit of 16384")
	expect(output).toContain(' 2 fail')
}, 30_000)
