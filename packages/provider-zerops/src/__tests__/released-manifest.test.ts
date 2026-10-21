// ADR-0062: an application on an older framework release registers the manifest its own CLI wrote. Each fixture is what
// `fabrika app build --env=prod` of examples/crm wrote with the CLI from npm at its tag: 0.4.8 (0.5.5 and 0.6.0 write the
// same bytes) and 0.7.0.
// This release must parse it and render its build with the checker release Control read the application with.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderLockedExecutionDescriptor } from '../execution'
import { lockedExecutionOf, parseFabrikaManifest, zeropsArtifactCodec } from '../manifest'

/** Each manifest by the CLI release that wrote it, with what the CRM computes at startup on that release. */
const RELEASES = [
	{
		// 0.5.5 and 0.6.0 write the same bytes.
		name: '0.4.8, 0.5.5 or 0.6.0',
		fixture: 'crm-manifest-0.4.8.json',
		checkRelease: '0.4.8',
		startupDigest: 'sha256:88312782b8fe094862492595b599ab4b8e24d439de0b31afe9d6c63d9e536fb2',
	},
	{
		name: '0.7.0',
		fixture: 'crm-manifest-0.7.0.json',
		checkRelease: '0.7.0',
		startupDigest: 'sha256:60cc6dd14474d3bb2c38af5861660add9316939b0a8eb5e54d05a3a93a856639',
	},
] as const

describe.each(RELEASES)('the manifest a $name CLI wrote', (release) => {
	const released: unknown = JSON.parse(readFileSync(new URL(`./fixtures/${release.fixture}`, import.meta.url), 'utf8'))

	test('parses on this release and survives the artifact codec', () => {
		const manifest = parseFabrikaManifest(released, { appId: 'crm', env: 'prod' })
		expect(manifest.target.contract?.digest).toBe(release.startupDigest)
		expect(zeropsArtifactCodec.decode(zeropsArtifactCodec.encode(manifest))).toEqual(manifest)
	})

	test("renders a build that checks with its minor's reader release and starts with its own digest", () => {
		const manifest = parseFabrikaManifest(released, { appId: 'crm', env: 'prod' })
		const execution = lockedExecutionOf(manifest)
		if (execution === null) throw new Error('expected a contract application')
		const { contents } = renderLockedExecutionDescriptor(manifest.target.sourceDescriptor.contents, manifest.target.zeropsSetup, 'r1', {
			...execution,
			checkRelease: release.checkRelease,
		})
		expect(contents).toContain(`bun x --bun -p @fabrika/check@${release.checkRelease} fabrika-check /build/source`)
		expect(contents).toContain(`FABRIKA_CONTRACT_DIGEST: "${release.startupDigest}"`)
	})
})
