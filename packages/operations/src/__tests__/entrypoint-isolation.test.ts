import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sharedFiles = [
	'index.ts',
	'repositories.ts',
	'pipeline.ts',
	'consumer.ts',
	'maintenance.ts',
	'ingest.ts',
	'direct-ingest.ts',
	'credentials.ts',
	'issues.ts',
	'alerts.ts',
	'event-detail.ts',
	'source-maps.ts',
]

test('the shared Operations graph has no runtime-specific imports', () => {
	for (const file of sharedFiles) {
		const source = readFileSync(join(import.meta.dir, '..', file), 'utf8')
		expect(source).not.toContain("from '@fabrika/platform-node'")
		expect(source).not.toContain("from 'cloudflare:workers'")
		expect(source).not.toMatch(/from ['"](?:bun|node):/)
	}
})
