// `fabrika app dev` on an application on Cloudflare: its data layer is SQLite (ADR-0065), so it serves on an in-memory
// database of the SQLite kit and needs no FABRIKA_TEST_POSTGRES_URL.

import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

setDefaultTimeout(60_000)

const CLI = join(import.meta.dir, '..', 'index.ts')
const DEV_APP = join(import.meta.dir, 'fixtures', 'dev-app')
const root = mkdtempSync(join(tmpdir(), 'fabrika-app-dev-cloudflare-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('serves the application and its seed without a database URL', async () => {
	cpSync(DEV_APP, root, { recursive: true })
	symlinkSync(join(import.meta.dir, '..', '..', 'node_modules'), join(root, 'node_modules'))
	writeFileSync(
		join(root, 'fabrika.config.ts'),
		"import { defineApp } from '@fabrika/provider-cloudflare'\n\nexport default defineApp({ id: 'cards', resources: () => [] })\n",
	)
	const child = Bun.spawn(['bun', CLI, 'app', 'dev', '--port=0'], {
		cwd: root,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { PATH: process.env['PATH'] ?? '' },
	})
	try {
		let stdout = ''
		const reader = child.stdout.getReader()
		while (!stdout.includes('\n')) {
			const { value, done } = await reader.read()
			if (done) throw new Error(`app dev exited: ${await new Response(child.stderr).text()}`)
			stdout += new TextDecoder().decode(value)
		}
		const picker = await fetch(new URL('__fabrika/dev', stdout.trim()))
		expect(picker.status).toBe(200)
		expect(await picker.text()).toContain('<form')
	} finally {
		child.kill('SIGTERM')
		await child.exited
	}
})
