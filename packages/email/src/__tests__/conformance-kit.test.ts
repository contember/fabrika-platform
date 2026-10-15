import { expect, test } from 'bun:test'
import { join } from 'node:path'

// The kit's own cases register through `bun:test`, so a kit that must fail an adapter runs in a separate process.
test('the conformance kit fails an adapter that copies the provider answer into its error', async () => {
	const fixture = join(import.meta.dir, 'fixtures', 'leaky-adapter.ts')
	const run = Bun.spawn([process.execPath, 'test', fixture], { stdout: 'pipe', stderr: 'pipe' })
	const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
	const output = `${stdout}\n${stderr}`

	expect(exitCode).not.toBe(0)
	expect(output).toContain('(fail) LeakyEmailSender conforms to EmailSender > every provider answer maps to its code and keeps the HTTP status')
	expect(output).toContain('not.toContain')
	expect(output).toContain(' 1 fail')
}, 30_000)
