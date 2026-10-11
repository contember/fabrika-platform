// The serving entry is a launcher (ADR-0017): handed the provisioning credential, it never loads the application; it
// runs the entrypoint again with the runtime role's credential in its place. The application's process, its
// `/proc/self/environ` and anything it spawns never hold the provisioning credential. Linux only (`/proc`).

import { applicationRuntimeUrl } from '@fabrika/platform-node'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const ENTRY = join(import.meta.dir, 'launcher-entry.ts')
const PROVISIONING = 'postgres://db:provisioning-secret-a1b2@127.0.0.1:1/db?sslmode=disable'
const scratch = mkdtempSync(join(tmpdir(), 'fabrika-launcher-'))
const reportSchema = z.object({
	pid: z.number(),
	environ: z.string(),
	child: z.string(),
	env: z.string(),
	parentEnviron: z.string(),
	parentMemory: z.string(),
	holders: z.array(z.number()),
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const launch = (name: string, mode: string) => {
	const report = join(scratch, `${name}.json`)
	const child = Bun.spawn(['bun', ENTRY, report, mode], {
		env: { PATH: process.env['PATH'] ?? '', FABRIKA_APP_ID: 'notes', FABRIKA_APP_DATABASE_URL: PROVISIONING },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	return { child, report }
}

const readReport = (path: string) => reportSchema.parse(JSON.parse(readFileSync(path, 'utf8')))

describe.skipIf(!existsSync('/proc/self/environ'))('the serving launcher', () => {
	test('the application runs in a process whose environment, /proc/self/environ and children hold the runtime credential only', async () => {
		const { child, report } = launch('clean', '0')
		expect(await child.exited).toBe(0)
		const seen = readReport(report)
		expect(seen.pid).not.toBe(child.pid)
		for (const text of [seen.environ, seen.child, seen.env]) {
			expect(text).not.toContain('provisioning-secret-a1b2')
			expect(text).not.toContain('FABRIKA_APP_DATABASE_URL')
		}
		expect(seen.environ).toContain(`FABRIKA_APP_RUNTIME_DATABASE_URL=${applicationRuntimeUrl(PROVISIONING, 'notes')}`)
		// The framework scrubbed every FABRIKA_* variable before the application loaded.
		expect(seen.env).not.toContain('FABRIKA_')
	})

	test('the launcher, which holds the provisioning credential, is not readable by the application it launched', async () => {
		const { child, report } = launch('parent', '0')
		expect(await child.exited).toBe(0)
		const seen = readReport(report)
		expect(seen.parentEnviron).toBe('EACCES')
		expect(seen.parentMemory).toBe('EACCES')
		expect(seen.holders).toEqual([])
	})

	test("the application's exit code is the launcher's", async () => {
		const { child } = launch('code', '7')
		expect(await child.exited).toBe(7)
	})

	test('SIGTERM reaches the application, which drains and exits', async () => {
		const { child, report } = launch('signal', 'wait')
		for (let tries = 0; tries < 100 && !existsSync(report); tries++) await Bun.sleep(20)
		child.kill('SIGTERM')
		expect(await child.exited).toBe(0)
	})

	test('a provisioning credential the runtime role cannot derive from stops the launch, naming no value', async () => {
		const child = Bun.spawn(['bun', ENTRY, join(scratch, 'never.json'), '0'], {
			env: { PATH: process.env['PATH'] ?? '', FABRIKA_APP_ID: 'notes', FABRIKA_APP_DATABASE_URL: 'postgres://db@127.0.0.1:1/db' },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		expect(await child.exited).not.toBe(0)
		expect(await new Response(child.stderr).text()).toContain('FABRIKA_APP_DATABASE_URL is not a connection URL with a password')
		expect(existsSync(join(scratch, 'never.json'))).toBe(false)
	})
})
