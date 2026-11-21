import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join } from 'path'

const LIFECYCLE_MODULE = new URL('../src/daemon-lifecycle.ts', import.meta.url).pathname

function unusedPort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() })
	const port = probe.port
	probe.stop(true)
	if (port === undefined) throw new Error('Bun.serve did not report a port')
	return port
}

/** The child's TMPDIR is `temp` and its XDG_RUNTIME_DIR `temp/run`, apart, so a file in the shared temp directory shows. */
async function runInCli(script: string, opts: { temp: string; env?: Record<string, string> }) {
	mkdirSync(join(opts.temp, 'run'), { recursive: true, mode: 0o700 })
	const child = Bun.spawn([process.execPath, '-e', script], {
		cwd: opts.temp,
		env: { ...process.env, TMPDIR: opts.temp, XDG_RUNTIME_DIR: join(opts.temp, 'run'), FABRIKA_PORT: String(unusedPort()), ...opts.env },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	expect(exitCode, stderr).toBe(0)
	return stdout
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

test('stop leaves a foreign live process named by the pid file untouched', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'fabrika-lifecycle-'))
	const foreign = Bun.spawn(['sleep', '30'])
	try {
		// The CLI derives its pid file from XDG_RUNTIME_DIR, so the child sees only this fixture.
		mkdirSync(join(temp, 'run', 'fabrika'), { recursive: true })
		writeFileSync(join(temp, 'run', 'fabrika', 'daemon.pid'), `${foreign.pid}\n`)

		const stdout = await runInCli(
			`const { daemon } = await import(${JSON.stringify(LIFECYCLE_MODULE)}); console.log(JSON.stringify(await daemon.stop()))`,
			{ temp },
		)

		expect(JSON.parse(stdout)).toMatchObject({ stopped: false, reason: 'stale-pid', pid: foreign.pid })
		expect(isAlive(foreign.pid)).toBe(true)
		expect(foreign.exitCode).toBeNull()
	} finally {
		foreign.kill()
		rmSync(temp, { recursive: true, force: true })
	}
})

test('the daemon is spawned outside the caller project with an absolute data root it honours', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'fabrika-lifecycle-'))
	try {
		const stdout = await runInCli(
			`const { daemon, daemonLifecycleConfig, ensureDaemon } = await import(${JSON.stringify(LIFECYCLE_MODULE)})
			const ensured = await ensureDaemon()
			const health = await daemon.health()
			await daemon.stop()
			console.log(JSON.stringify({ ensured, health, cwd: daemonLifecycleConfig.cwd, command: daemonLifecycleConfig.command }))`,
			{ temp, env: { FABRIKA_DATA_DIR: 'relative-data' } },
		)
		const result = JSON.parse(stdout)
		const dataDir = result.command[result.command.indexOf('--data-dir') + 1]
		expect(isAbsolute(dataDir)).toBe(true)
		expect(dataDir).toBe(join(realpathSync(temp), 'relative-data'))
		expect(result.cwd).not.toBe(realpathSync(temp))
		expect(result.ensured).toBe(true)
		expect(result.health.sessionsDir).toBe(join(dataDir, 'sessions'))
	} finally {
		rmSync(temp, { recursive: true, force: true })
	}
})

test('a daemon that wrote its capability where this CLI does not read it is restarted, as one of an earlier release', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-lifecycle-'))
	const earlier = join(root, 'earlier')
	const current = join(root, 'current')
	mkdirSync(earlier, { mode: 0o700 })
	mkdirSync(current, { mode: 0o700 })
	const env = { FABRIKA_PORT: String(unusedPort()), FABRIKA_DATA_DIR: join(root, 'data') }
	const ensure = `const { daemon, ensureDaemon } = await import(${JSON.stringify(LIFECYCLE_MODULE)})
		const ensured = await ensureDaemon({ quiet: true })
		console.log(JSON.stringify({ ensured, health: await daemon.health() }))`
	try {
		const first = JSON.parse(await runInCli(ensure, { temp: earlier, env }))
		expect(first.health.cliAuthFile).toBe(join(earlier, 'run', 'fabrika', 'daemon-auth-token'))

		const second = JSON.parse(await runInCli(ensure, { temp: current, env }))
		expect(second.ensured).toBe(true)
		expect(second.health.pid).not.toBe(first.health.pid)
		expect(second.health.cliAuthFile).toBe(join(current, 'run', 'fabrika', 'daemon-auth-token'))
		expect(existsSync(join(current, 'run', 'fabrika', 'daemon-auth-token'))).toBe(true)
		expect(isAlive(first.health.pid)).toBe(false)
	} finally {
		await runInCli(`const { daemon } = await import(${JSON.stringify(LIFECYCLE_MODULE)}); await daemon.stop()`, { temp: current, env })
		rmSync(root, { recursive: true, force: true })
	}
}, 30_000)

test('the dashboard cookie of an earlier daemon run is refused by the restarted daemon, and the old ui-token file is removed', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-lifecycle-'))
	const data = join(root, 'data')
	mkdirSync(data, { mode: 0o700 })
	// The UI secret a release before this one kept across restarts.
	writeFileSync(join(data, 'ui-token'), 'x'.repeat(43), { mode: 0o600 })
	const modules = {
		lifecycle: LIFECYCLE_MODULE,
		auth: new URL('../src/cli-auth.ts', import.meta.url).pathname,
		config: new URL('../src/config.ts', import.meta.url).pathname,
	}
	const env = { FABRIKA_PORT: String(unusedPort()), FABRIKA_DATA_DIR: data }
	try {
		const stdout = await runInCli(
			`const { daemon, ensureDaemon } = await import(${JSON.stringify(modules.lifecycle)})
			const { cliAuthHeaders } = await import(${JSON.stringify(modules.auth)})
			const { BASE_URL } = await import(${JSON.stringify(modules.config)})
			const sessions = (cookie) => fetch(BASE_URL + '/api/sessions', { headers: { Cookie: cookie } }).then((response) => response.status)
			await ensureDaemon({ quiet: true })
			const link = await fetch(BASE_URL + '/api/session/s1/link', { method: 'POST', headers: cliAuthHeaders() }).then((response) => response.json())
			const cookie = (await fetch(link.signInUrl, { redirect: 'manual' })).headers.get('Set-Cookie').split(';')[0]
			const before = await sessions(cookie)
			await daemon.stop()
			await ensureDaemon({ quiet: true })
			const after = await sessions(cookie)
			await daemon.stop()
			console.log(JSON.stringify({ before, after }))`,
			{ temp: root, env },
		)
		expect(JSON.parse(stdout)).toEqual({ before: 200, after: 401 })
		expect(existsSync(join(data, 'ui-token'))).toBe(false)
		// The runtime files went to the runtime directory, none to the shared temp directory.
		expect(statSync(join(root, 'run', 'fabrika')).mode & 0o777).toBe(0o700)
		expect(existsSync(join(root, 'run', 'fabrika', 'daemon.log'))).toBe(true)
		expect(existsSync(join(root, 'fabrika'))).toBe(false)
	} finally {
		await runInCli(`const { daemon } = await import(${JSON.stringify(LIFECYCLE_MODULE)}); await daemon.stop()`, { temp: root, env })
		rmSync(root, { recursive: true, force: true })
	}
}, 30_000)
