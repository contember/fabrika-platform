// ADR-0062: an application on an older framework release registers the manifest its own CLI wrote. The fixture is what
// `fabrika app build --env=prod` of examples/crm wrote with the CLI from npm at 0.4.8; 0.5.5 writes the same bytes.
// This release must parse it and render its build with the checker release Control read the application with.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderLockedExecutionDescriptor } from '../execution'
import { lockedExecutionOf, parseFabrikaManifest, zeropsArtifactCodec } from '../manifest'

const RELEASED = JSON.parse(readFileSync(new URL('./fixtures/crm-manifest-0.4.8.json', import.meta.url), 'utf8'))

/** What the CRM computes at startup on 0.4.8 and 0.5.5. */
const STARTUP_DIGEST = 'sha256:88312782b8fe094862492595b599ab4b8e24d439de0b31afe9d6c63d9e536fb2'

describe('the manifest a 0.4.8 or 0.5.5 CLI wrote', () => {
	test('parses on this release and survives the artifact codec', () => {
		const manifest = parseFabrikaManifest(RELEASED, { appId: 'crm', env: 'prod' })
		expect(manifest.target.contract?.digest).toBe(STARTUP_DIGEST)
		expect(zeropsArtifactCodec.decode(zeropsArtifactCodec.encode(manifest))).toEqual(manifest)
	})

	test("renders a build that checks with its minor's reader release and starts with its own digest", () => {
		const manifest = parseFabrikaManifest(RELEASED, { appId: 'crm', env: 'prod' })
		const execution = lockedExecutionOf(manifest)
		if (execution === null) throw new Error('expected a contract application')
		const { contents } = renderLockedExecutionDescriptor(manifest.target.sourceDescriptor.contents, manifest.target.zeropsSetup, 'r1', {
			...execution,
			checkRelease: '0.4.8',
		})
		expect(contents).toContain('bun x --bun -p @fabrika/check@0.4.8 fabrika-check /build/source')
		expect(contents).toContain(`FABRIKA_CONTRACT_DIGEST: "${STARTUP_DIGEST}"`)
	})
})
