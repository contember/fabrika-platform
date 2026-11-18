// A Worker runs on workerd, which has no `Bun` global: the code a Cloudflare application's bundle carries names none,
// except behind a `typeof Bun` guard. Lopata runs on Bun, so the runtime witness cannot see this. Nor does it use
// `AbortSignal.timeout`, whose timer nothing can clear: on workerd it keeps the Durable Object awake until it fires.
// And it loads in workerd, which refuses a module whose top level does what only a handler may (a timer, randomness,
// an `AbortController`).

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `Bun.env`, read only where `typeof Bun` says it exists (`implement/environment.ts`). */
const GUARDED = ['env']

/** The modules outside `@fabrika/app` whose `AbortSignal.timeout` the bundle still carries: this list only shrinks. */
const UNCLEARED = ['../email/src/http.ts']

/** The bundle of the Cloudflare fixture application, as `bun build` prints it, its module headers relative to this package. */
function bundle(): string {
	// The CLI, not `Bun.build`: inside `bun test` the API resolves no workspace package.
	const built = Bun.spawnSync(
		[
			'bun',
			'build',
			join(import.meta.dir, 'cloudflare-fixture', 'worker.ts'),
			'--target',
			'browser',
			'--external',
			'node:*',
			'--external',
			'cloudflare:*',
		],
		{ cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe' },
	)
	expect(built.exitCode).toBe(0)
	return built.stdout.toString()
}

test('the bundle of a Cloudflare application names no Bun global but the guarded one', async () => {
	const named = new Set([...bundle().matchAll(/\bBun\.([A-Za-z0-9_$]+)/g)].map((match) => match[1]))
	expect([...named]).toEqual(GUARDED)
})

test('the bundle of a Cloudflare application sets no deadline it cannot clear', async () => {
	const uncleared = new Set<string>()
	let module = ''
	for (const line of bundle().split('\n')) {
		module = /^\/\/ (\S+)$/.exec(line)?.[1] ?? module
		if (/\bAbortSignal\.timeout\b/.test(line)) {
			uncleared.add(module)
		}
	}
	expect([...uncleared].sort()).toEqual(UNCLEARED)
})

/** The Worker settings an application gets by default (`@fabrika/provider-cloudflare`'s `defineApp`). */
const WORKER_CONFIG = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = .worker)]);
const worker :Workerd.Worker = (
	modules = [(name = "load.mjs", esModule = embed "load.mjs"), (name = "worker.mjs", esModule = embed "worker.mjs")],
	compatibilityDate = "2025-10-01",
	compatibilityFlags = ["nodejs_compat_v2"],
);
`

test('the bundle of a Cloudflare application loads in workerd', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fabrika-workerd-'))
	try {
		writeFileSync(join(dir, 'worker.mjs'), bundle())
		writeFileSync(join(dir, 'load.mjs'), "import './worker.mjs'\nexport default { test() {} }\n")
		writeFileSync(join(dir, 'config.capnp'), WORKER_CONFIG)
		const run = Bun.spawnSync([join(import.meta.dir, '..', '..', 'node_modules', '.bin', 'workerd'), 'test', 'config.capnp'], {
			cwd: dir,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const output = `${run.stdout.toString()}${run.stderr.toString()}`
		expect(output).not.toContain('Uncaught')
		expect(run.exitCode).toBe(0)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
