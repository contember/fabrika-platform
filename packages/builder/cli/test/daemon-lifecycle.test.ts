import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
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

async function runInCli(script: string, opts: { temp: string; env?: Record<string, string> }) {
	const child = Bun.spawn([process.execPath, '-e', script], {
		cwd: opts.temp,
		env: { ...process.env, TMPDIR: opts.temp, FABRIKA_PORT: String(unusedPort()), ...opts.env },
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
		// The CLI derives its pid file from TMPDIR, so the child sees only this fixture.
		mkdirSync(join(temp, 'fabrika'), { recursive: true })
		writeFileSync(join(temp, 'fabrika', 'daemon.pid'), `${foreign.pid}\n`)

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
