import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const daemonModule = new URL('../src/index.ts', import.meta.url).href

test('importing startDaemon does not initialize default paths; explicit startup creates only its selected sessions root', () => {
	const root = mkdtempSync('/tmp/opencode/builder-path-import-')
	try {
		const blocked = join(root, 'blocked-default')
		writeFileSync(blocked, 'A file deliberately prevents creation of the default data directory.')
		const home = join(root, 'home')
		mkdirSync(home)
		const temp = join(root, 'temp')
		const sessions = join(root, 'selected', 'sessions')
		const child = Bun.spawnSync([
			process.execPath,
			'--no-env-file',
			'--eval',
			`
			import assert from 'node:assert/strict'
			import { existsSync } from 'node:fs'
			const { startDaemon } = await import(${JSON.stringify(daemonModule)})
			assert.equal(existsSync(${JSON.stringify(sessions)}), false)
			assert.equal(existsSync(${JSON.stringify(join(home, '.fabrika'))}), false)
			assert.equal(existsSync(${JSON.stringify(join(temp, 'fabrika'))}), false)
			const daemon = startDaemon(${
				JSON.stringify({
					port: 0,
					sessionsDir: sessions,
					platform: { dataDir: join(root, 'selected'), stateDir: join(root, 'selected', 'projects'), credentialDir: join(root, 'credentials') },
				})
			})
			try {
				assert.equal(existsSync(${JSON.stringify(sessions)}), true)
				const health = await fetch('http://localhost:' + daemon.port + '/health')
				assert.equal(health.status, 200)
				assert.equal((await health.json()).sessionsDir, ${JSON.stringify(sessions)})
			} finally { daemon.stop() }
		`,
		], {
			cwd: root,
			env: { HOME: home, TMPDIR: temp, FABRIKA_DATA_DIR: join(blocked, 'data'), PATH: process.env['PATH'] ?? '' },
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		})
		expect(child.stderr.toString()).toBe('')
		expect(child.exitCode).toBe(0)
		expect(existsSync(sessions)).toBe(true)
		expect(existsSync(join(home, '.fabrika'))).toBe(false)
		expect(existsSync(join(temp, 'fabrika'))).toBe(false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}, 35_000)

test('default startup initializes the configured sessions root after a side-effect-free import', () => {
	const root = mkdtempSync('/tmp/opencode/builder-path-start-')
	try {
		const data = join(root, 'data')
		const child = Bun.spawnSync([
			process.execPath,
			'--no-env-file',
			'--eval',
			`
			import assert from 'node:assert/strict'
			import { existsSync } from 'node:fs'
			const { startDaemon } = await import(${JSON.stringify(daemonModule)})
			assert.equal(existsSync(${JSON.stringify(data)}), false)
			const daemon = startDaemon({ port: 0 })
			try {
				assert.equal(existsSync(${JSON.stringify(join(data, 'sessions'))}), true)
				const health = await fetch('http://localhost:' + daemon.port + '/health')
				assert.equal(health.status, 200)
				assert.equal((await health.json()).sessionsDir, ${JSON.stringify(join(data, 'sessions'))})
			} finally { daemon.stop() }
		`,
		], {
			cwd: root,
			env: { HOME: join(root, 'home'), TMPDIR: join(root, 'temp'), FABRIKA_DATA_DIR: data, PATH: process.env['PATH'] ?? '' },
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		})
		expect(child.stderr.toString()).toBe('')
		expect(child.exitCode).toBe(0)
		expect(existsSync(join(data, 'sessions'))).toBe(true)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}, 35_000)
