// The build sandbox (ADR-0086): every step that runs checkout code runs as a user of its own, with an environment that
// holds nothing of the runner's, and, after the install, without network when the container allows a network
// namespace. The user cannot read the runner's files (the values file, the job) or `/proc/<pid>/environ` of the runner
// and the deploy executor, which run as root. Nothing it starts outlives its step: `reap` kills every process it owns.

import { readdir, readFile } from 'node:fs/promises'
import type { SpawnSpec } from './runner'

/** One step of the sandbox: what to run, where, with which whole environment, and whether it may reach the network. */
export interface SandboxCommand {
	readonly command: string
	readonly args: readonly string[]
	readonly cwd: string
	/** The command's whole environment; nothing of the runner's is inherited. */
	readonly env: Readonly<Record<string, string>>
	/** Only the install and the fetch of the check tools reach the registry. */
	readonly network: boolean
}

export interface BuildSandbox {
	/** Why the runner cannot run a build as its own user, or null when it can. While set, every run is refused. */
	readonly unavailable: string | null
	/** Whether a step without network gets a network namespace of its own; otherwise it keeps the container's network. */
	readonly isolatesNetwork: boolean
	/** The spawn of a command as the build user, with exactly its environment. */
	command(spec: SandboxCommand): SpawnSpec
	/** Hand the build user the directories it works in: the checkout and the build directory. */
	own(paths: readonly string[]): Promise<void>
	/** Kill every process of the build user and wait until none is left. */
	reap(): Promise<void>
}

/** How the runner treats a container that refuses a network namespace: `auto` builds with network, `isolated` refuses. */
export type BuildNetworkPolicy = 'auto' | 'isolated'

const SETPRIV = '/usr/bin/setpriv'
const UNSHARE = '/usr/bin/unshare'
const CHOWN = '/usr/bin/chown'
const IP = '/usr/sbin/ip'
const SH = '/bin/sh'

/**
 * The argv that runs `spec` as `uid:gid`: no supplementary groups, no new privileges (a setuid binary cannot raise it),
 * no capabilities. Without network it runs in a fresh network namespace, with only its loopback up, so a test that
 * listens on localhost still works and nothing else is reachable, the runner's own port included.
 */
export const sandboxArgv = (uid: number, gid: number, spec: Pick<SandboxCommand, 'command' | 'args' | 'network'>, isolate: boolean): string[] => {
	const drop = [
		SETPRIV,
		`--reuid=${uid}`,
		`--regid=${gid}`,
		'--clear-groups',
		'--no-new-privs',
		'--inh-caps=-all',
		'--bounding-set=-all',
		'--',
		spec.command,
		...spec.args,
	]
	if (spec.network || !isolate) return drop
	return [UNSHARE, '--net', '--', SH, '-c', `${IP} link set lo up && exec "$@"`, 'fabrika-build-sandbox', ...drop]
}

/** The real uids of a `/proc/<pid>/status` (real, effective, saved, filesystem). */
const statusUids = (status: string): readonly number[] => {
	const line = status.split('\n').find((entry) => entry.startsWith('Uid:'))
	return line === undefined ? [] : line.slice('Uid:'.length).trim().split(/\s+/).map(Number)
}

/** A zombie has exited and runs nothing; it waits for its parent (the image's init) to collect it. */
const isZombie = (status: string): boolean => /^State:\s+Z/m.test(status)

/** Every live process any of whose uids is `uid`, read from `/proc`. */
export const processesOf = async (uid: number, proc = '/proc'): Promise<readonly number[]> => {
	const pids: number[] = []
	for (const name of await readdir(proc)) {
		if (!/^[0-9]+$/.test(name)) continue
		const status = await readFile(`${proc}/${name}/status`, 'utf8').catch(() => null)
		if (status !== null && !isZombie(status) && statusUids(status).includes(uid)) pids.push(Number(name))
	}
	return pids
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** What the Linux sandbox runs its probes and its `chown` with: a child's exit code and stdout. */
export type SandboxExec = (argv: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>

const bunExec: SandboxExec = async (argv) => {
	const child = Bun.spawn([...argv], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
	return { exitCode, stdout }
}

export interface LinuxSandboxOptions {
	readonly uid: number
	readonly gid: number
	readonly network: BuildNetworkPolicy
	/** The runner's own uid; the sandbox drops from root only. */
	readonly runnerUid?: number
	readonly exec?: SandboxExec
	readonly kill?: (pid: number) => void
	readonly processes?: (uid: number) => Promise<readonly number[]>
}

const unavailableSandbox = (reason: string): BuildSandbox => ({
	unavailable: reason,
	isolatesNetwork: false,
	command: () => {
		throw new Error(reason)
	},
	own: () => Promise.reject(new Error(reason)),
	reap: () => Promise.resolve(),
})

/**
 * The sandbox of the runner image: `setpriv` to the build user, `unshare --net` for the steps without network. Probed
 * once at start: a runner that cannot drop to the build user refuses every run; one whose container refuses a network
 * namespace builds with network under `auto` (the build holds no secret, ADR-0086) and refuses under `isolated`.
 */
export const linuxBuildSandbox = async (options: LinuxSandboxOptions): Promise<BuildSandbox> => {
	const exec = options.exec ?? bunExec
	const { uid, gid } = options
	const runnerUid = options.runnerUid ?? process.getuid?.() ?? -1
	if (runnerUid !== 0) return unavailableSandbox('the runner does not run as root, so it cannot run the build as a user of its own')
	if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) {
		return unavailableSandbox('the build user is not a uid and gid other than root')
	}
	const dropped = await exec(sandboxArgv(uid, gid, { command: '/usr/bin/id', args: ['-u'], network: true }, false)).catch(() => null)
	if (dropped === null || dropped.exitCode !== 0 || dropped.stdout.trim() !== String(uid)) {
		return unavailableSandbox(`the runner cannot switch to the build user ${uid} with setpriv`)
	}
	const netns = await exec(sandboxArgv(uid, gid, { command: '/usr/bin/true', args: [], network: false }, true)).catch(() => null)
	const isolatesNetwork = netns !== null && netns.exitCode === 0
	if (!isolatesNetwork && options.network === 'isolated') {
		return unavailableSandbox('the container refuses a network namespace, and FABRIKA_RUNNER_BUILD_NETWORK=isolated requires one')
	}
	const kill = options.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'))
	const processes = options.processes ?? ((owner: number) => processesOf(owner))
	return {
		unavailable: null,
		isolatesNetwork,
		command: (spec) => {
			const [command = '', ...args] = sandboxArgv(uid, gid, spec, isolatesNetwork)
			return { command, args, cwd: spec.cwd, env: { ...spec.env }, replaceEnv: true }
		},
		own: async (paths) => {
			// `-P`: a link the checkout commits is changed itself, never what it points at.
			const result = await exec([CHOWN, '-R', '-P', `${uid}:${gid}`, '--', ...paths])
			if (result.exitCode !== 0) throw new Error('could not hand the build directories to the build user')
		},
		reap: async () => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const pids = await processes(uid)
				if (pids.length === 0) return
				for (const pid of pids) {
					try {
						kill(pid)
					} catch {
						// Already gone.
					}
				}
				await sleep(50)
			}
			throw new Error('processes of the build user outlived its step')
		},
	}
}
