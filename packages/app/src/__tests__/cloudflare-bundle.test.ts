// A Worker runs on workerd, which has no `Bun` global: the code a Cloudflare application's bundle carries names none,
// except behind a `typeof Bun` guard. Lopata runs on Bun, so the runtime witness cannot see this. Nor does it use
// `AbortSignal.timeout`, whose timer nothing can clear: on workerd it keeps the Durable Object awake until it fires.

import { expect, test } from 'bun:test'
import { join } from 'node:path'

/** `Bun.env`, read only where `typeof Bun` says it exists (`implement/environment.ts`). */
const GUARDED = ['env']

/** The modules outside `@fabrika/app` whose `AbortSignal.timeout` the bundle still carries: this list only shrinks. */
const UNCLEARED = ['../auth/src/rpc-http.ts', '../email/src/http.ts']

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
