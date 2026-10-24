import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { describeControlProviderConformance } from '../conformance'
import { memoryHarness } from './fixtures/memory-provider'

describeControlProviderConformance('MemoryProvider', memoryHarness())

// The suite's own cases register through `bun:test`, so a suite that must fail a provider runs in a separate process.
test('the suite fails a provider that stops its work when its lease is lost', async () => {
	const fixture = join(import.meta.dir, 'fixtures', 'cancelling-provider.ts')
	const run = Bun.spawn([process.execPath, 'test', fixture], { stdout: 'pipe', stderr: 'pipe' })
	const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
	const output = `${stdout}\n${stderr}`

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
