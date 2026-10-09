import type { ArtifactAccess } from '@fabrika/auth-core'
import { artifactAccessDigest } from '@fabrika/auth-core'
import { compileFabrikaManifest, defineApp, zeropsArtifactAccess } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { configArtifactAccess } from '../../../provider-cloudflare/src/artifact-access'
import { SOURCE_DESCRIPTOR } from '../../../provider-zerops/src/__tests__/fixtures/descriptor'
import { approvedProviderAccess, EMPTY_SNAPSHOT, serializeSnapshot } from '../approval/snapshot'

const GATES = {
	rules: [
		{ path: '/healthz', kind: 'public' as const },
		{ path: '/api/*', kind: 'service' as const, credential: { in: 'header' as const, name: 'x-api-key' } },
		{ path: '/mcp', kind: 'oauth' as const, resource: 'https://notes.example.test/mcp', scopes: ['notes.read'] },
		{ path: '/*', kind: 'human' as const },
	],
}
const SCHEMA = {
	scopes: [{ type: 'team' }],
	actions: [{ action: 'notes.read', description: 'Read notes' }, { action: 'notes.write' }],
	roles: { editor: { name: 'Editor', permissions: ['notes.read', 'notes.write'] } },
}

/** The digest a provider computes, and the one Control sends after storing the access in a published snapshot. */
const digests = (access: ArtifactAccess): [string, string | null | undefined] => {
	const row = {
		app_id: 'notes',
		env: 'prod',
		published_run_id: 'run-1',
		published_snapshot_json: serializeSnapshot({ ...EMPTY_SNAPSHOT, artifact: access }),
		generation: 1,
		protected: 1,
	}
	return [artifactAccessDigest(access), approvedProviderAccess(row).artifactAccess?.digest]
}

describe('artifact access survives the published snapshot', () => {
	test("a Zerops artifact's gates and schema hash the same in the provider and after Control stored them", () => {
		const manifest = compileFabrikaManifest(
			defineApp({
				id: 'notes',
				schema: SCHEMA,
				target: { platform: 'zerops', services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }], proxy: { upstream: 'notes:3000', gates: GATES } },
			}),
			'prod',
			SOURCE_DESCRIPTOR,
		)
		const [provider, control] = digests(zeropsArtifactAccess(manifest))
		expect(control).toBe(provider)
	})

	test("a Cloudflare config's gates and schema hash the same in the runner and after Control stored them", () => {
		const [runner, control] = digests(configArtifactAccess({ gates: GATES, schema: SCHEMA }))
		expect(control).toBe(runner)
	})
})
