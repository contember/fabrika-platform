import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linuxBuildSandbox, processesOf, sandboxArgv, type SandboxExec } from '../sandbox'
import { bunSpawner } from '../spawn'

// The sandbox's argv and probes; the user switch itself runs in the image (`docker:smoke`), which runs as root.

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const DROP = [
	'/usr/bin/setpriv',
	'--reuid=10001',
	'--regid=10001',
	'--clear-groups',
	'--no-new-privs',
	'--inh-caps=-all',
	'--bounding-set=-all',
	'--',
]

describe('sandboxArgv', () => {
	test('drops to the build user with no groups, no capabilities and no new privileges', () => {
		expect(sandboxArgv(10001, 10001, { command: 'bun', args: ['install'], network: true }, true)).toEqual([...DROP, 'bun', 'install'])
	})

	test('a step without network runs in a namespace of its own with only the loopback up', () => {
		expect(sandboxArgv(10001, 10001, { command: 'fabrika-cloudflare-executor', args: ['build'], network: false }, true)).toEqual([
			'/usr/bin/unshare',
			'--net',
			'--',
			'/bin/sh',
			'-c',
			'/usr/sbin/ip link set lo up && exec "$@"',
			'fabrika-build-sandbox',
			...DROP,
			'fabrika-cloudflare-executor',
			'build',
		])
		// A container without network namespaces: the same user switch, with the container's network.
		expect(sandboxArgv(10001, 10001, { command: 'x', args: [], network: false }, false)).toEqual([...DROP, 'x'])
	})
})

/** Probes that answer as a root runner in a container that allows (or refuses) a network namespace. */
const probes = (netns: boolean, calls: string[][] = []): SandboxExec => async (argv) => {
	calls.push([...argv])
	if (argv.includes('/usr/bin/id')) return { exitCode: 0, stdout: '10001\n' }
	if (argv[0] === '/usr/bin/unshare') return { exitCode: netns ? 0 : 1, stdout: '' }
	return { exitCode: 0, stdout: '' }
}

describe('linuxBuildSandbox', () => {
	test('a runner that is not root, or a build user that is root, refuses every run', async () => {
		expect((await linuxBuildSandbox({ uid: 10001, gid: 10001, network: 'auto', runnerUid: 1000, exec: probes(true) })).unavailable).toBe(
			'the runner does not run as root, so it cannot run the build as a user of its own',
		)
		expect((await linuxBuildSandbox({ uid: 0, gid: 0, network: 'auto', runnerUid: 0, exec: probes(true) })).unavailable).toBe(
			'the build user is not a uid and gid other than root',
		)
		const unswitched = await linuxBuildSandbox({
			uid: 10001,
			gid: 10001,
			network: 'auto',
			runnerUid: 0,
			exec: async () => ({ exitCode: 0, stdout: '0\n' }),
		})
		expect(unswitched.unavailable).toBe('the runner cannot switch to the build user 10001 with setpriv')
		expect(() => unswitched.command({ command: 'bun', args: [], cwd: '/', env: {}, network: true })).toThrow('cannot switch')
	})

	test('without a network namespace, `auto` builds with network and `isolated` refuses every run', async () => {
		const auto = await linuxBuildSandbox({ uid: 10001, gid: 10001, network: 'auto', runnerUid: 0, exec: probes(false) })
		expect(auto.unavailable).toBeNull()
		expect(auto.isolatesNetwork).toBe(false)
		const isolated = await linuxBuildSandbox({ uid: 10001, gid: 10001, network: 'isolated', runnerUid: 0, exec: probes(false) })
		expect(isolated.unavailable).toBe('the container refuses a network namespace, and FABRIKA_RUNNER_BUILD_NETWORK=isolated requires one')
	})

	test('a command gets exactly its own environment, and the directories are handed over without following a link', async () => {
		const calls: string[][] = []
		const sandbox = await linuxBuildSandbox({ uid: 10001, gid: 10001, network: 'auto', runnerUid: 0, exec: probes(true, calls) })
		expect(sandbox.isolatesNetwork).toBe(true)
		const spec = sandbox.command({
			command: 'bun',
			args: ['install'],
			cwd: '/w/run',
			env: { PATH: '/opt/bun/bin', HOME: '/w/run.build/home' },
			network: true,
		})
		expect(spec).toEqual({
			command: DROP[0] ?? '',
			args: [...DROP.slice(1), 'bun', 'install'],
			cwd: '/w/run',
			env: { PATH: '/opt/bun/bin', HOME: '/w/run.build/home' },
			replaceEnv: true,
		})
		await sandbox.own(['/w/run', '/w/run.build'])
		expect(calls.at(-1)).toEqual(['/usr/bin/chown', '-R', '-P', '10001:10001', '--', '/w/run', '/w/run.build'])
	})

	test('reap kills every process of the build user until none is left, and fails when one survives', async () => {
		let alive = [11, 12]
		const killed: number[] = []
		const killAll: string[][] = []
		const sandbox = await linuxBuildSandbox({
			uid: 10001,
			gid: 10001,
			network: 'auto',
			runnerUid: 0,
			exec: probes(true),
			// As the build user, one `kill(-1)` first: a process that keeps forking outruns a walk of /proc, not this.
			killAll: async (argv) => {
				killAll.push([...argv])
				return { exitCode: 0, stdout: '' }
			},
			processes: async () => alive,
			kill: (pid) => {
				killed.push(pid)
				alive = alive.filter((other) => other !== pid)
			},
		})
		await sandbox.reap()
		expect(killed).toEqual([11, 12])
		expect(killAll[0]).toEqual([...DROP, '/usr/bin/kill', '-KILL', '--', '-1'])
		const stubborn = await linuxBuildSandbox({
			uid: 10001,
			gid: 10001,
			network: 'auto',
			runnerUid: 0,
			exec: probes(true),
			killAll: async () => ({ exitCode: 1, stdout: '' }),
			processes: async () => [13],
			kill: () => {},
		})
		await expect(stubborn.reap()).rejects.toThrow('processes of the build user outlived its step')
	}, 10_000)

	test('processesOf reads every uid of /proc/<pid>/status', async () => {
		const proc = await mkdtemp(join(tmpdir(), 'fabrika-proc-'))
		roots.push(proc)
		const status = (pid: string, uids: string, state = 'S (sleeping)'): void => {
			mkdirSync(join(proc, pid))
			writeFileSync(join(proc, pid, 'status'), `Name:\tbun\nState:\t${state}\nUid:\t${uids}\nGid:\t0\t0\t0\t0\n`)
		}
		status('1', '0\t0\t0\t0')
		status('20', '10001\t10001\t10001\t10001')
		status('21', '0\t10001\t0\t0')
		// Killed, and not yet collected by the image's init: it runs nothing.
		status('22', '10001\t10001\t10001\t10001', 'Z (zombie)')
		mkdirSync(join(proc, 'self'))
		expect([...(await processesOf(10001, proc))].sort()).toEqual([20, 21])
	})
})

describe('a sandboxed step inherits nothing of the runner', () => {
	test("a real child spawned with `replaceEnv` sees only the step's environment, not the runner's credential", async () => {
		const previous = process.env['CLOUDFLARE_API_TOKEN']
		process.env['CLOUDFLARE_API_TOKEN'] = 'runner-held-token'
		let stdout = ''
		try {
			const result = await bunSpawner(
				{ command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.env))'], cwd: tmpdir(), env: { HOME: tmpdir() }, replaceEnv: true },
				{ onStdout: (chunk) => (stdout += chunk), onStderr: () => {} },
			)
			expect(result.exitCode).toBe(0)
		} finally {
			if (previous === undefined) delete process.env['CLOUDFLARE_API_TOKEN']
			else process.env['CLOUDFLARE_API_TOKEN'] = previous
		}
		const env: unknown = JSON.parse(stdout)
		expect(stdout).not.toContain('runner-held-token')
		expect(typeof env === 'object' && env !== null ? Reflect.get(env, 'HOME') : undefined).toBe(tmpdir())
	})
})
