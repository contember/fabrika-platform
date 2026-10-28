// A Worker runs on workerd, which has no `Bun` global: the code a Cloudflare application's bundle carries names none,
// except behind a `typeof Bun` guard. Lopata runs on Bun, so the runtime witness cannot see this. Nor does it use
// `AbortSignal.timeout`, whose timer nothing can clear: on workerd it keeps the Durable Object awake until it fires.
// Both entries are checked: the Durable Object's SQLite and Postgres through Hyperdrive, whose postgres.js resolves its
// `workerd` build as wrangler bundles it.

import { expect, test } from 'bun:test'
import { join } from 'node:path'

/** The modules outside `@fabrika/app` whose `AbortSignal.timeout` the bundle still carries: this list only shrinks. */
const UNCLEARED = ['../auth/src/rpc-http.ts', '../email/src/http.ts']

interface BundledFixture {
	readonly name: string
	readonly directory: string
	readonly conditions: readonly string[]
	/**
	 * The `Bun.*` names the bundle may carry: `Bun.env`, read only where `typeof Bun` says it exists
	 * (`implement/environment.ts`), and on Postgres `Bun.SQL` in the text of an error kysely-postgres-js throws.
	 */
	readonly guarded: readonly string[]
}

const FIXTURES: readonly BundledFixture[] = [
	{ name: 'a Cloudflare application', directory: 'cloudflare-fixture', conditions: [], guarded: ['env'] },
	{ name: 'a Cloudflare application on Postgres', directory: 'cloudflare-postgres-fixture', conditions: ['workerd'], guarded: ['env', 'SQL'] },
]

/** The bundle of a fixture application, as `bun build` prints it, its module headers relative to this package. */
function bundle(fixture: BundledFixture): string {
	// The CLI, not `Bun.build`: inside `bun test` the API resolves no workspace package.
	const built = Bun.spawnSync(
		[
			'bun',
			'build',
			join(import.meta.dir, fixture.directory, 'worker.ts'),
			'--target',
			'browser',
			'--external',
			'node:*',
			'--external',
			'cloudflare:*',
			...fixture.conditions.flatMap((condition) => ['--conditions', condition]),
		],
		{ cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe' },
	)
	expect(built.exitCode).toBe(0)
	return built.stdout.toString()
}

for (const fixture of FIXTURES) {
	test(`the bundle of ${fixture.name} names no Bun global but the guarded ones`, async () => {
		const named = new Set([...bundle(fixture).matchAll(/\bBun\.([A-Za-z0-9_$]+)/g)].map((match) => match[1]))
		expect([...named].sort()).toEqual([...fixture.guarded].sort())
	})

	test(`the bundle of ${fixture.name} sets no deadline it cannot clear`, async () => {
		const uncleared = new Set<string>()
		let module = ''
		for (const line of bundle(fixture).split('\n')) {
			module = /^\/\/ (\S+)$/.exec(line)?.[1] ?? module
			if (/\bAbortSignal\.timeout\b/.test(line)) {
				uncleared.add(module)
			}
		}
		expect([...uncleared].sort()).toEqual(UNCLEARED)
	})
}
