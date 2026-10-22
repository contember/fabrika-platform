// A Worker runs on workerd, which has no `Bun` global: the code a Cloudflare application's bundle carries names none,
// except behind a `typeof Bun` guard. Lopata runs on Bun, so the runtime witness cannot see this.

import { expect, test } from 'bun:test'
import { join } from 'node:path'

/** `Bun.env`, read only where `typeof Bun` says it exists (`implement/environment.ts`). */
const GUARDED = ['env']

test('the bundle of a Cloudflare application names no Bun global but the guarded one', async () => {
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
		{ stdout: 'pipe', stderr: 'pipe' },
	)
	expect(built.exitCode).toBe(0)
	const named = new Set([...built.stdout.toString().matchAll(/\bBun\.([A-Za-z0-9_$]+)/g)].map((match) => match[1]))
	expect([...named]).toEqual(GUARDED)
})
