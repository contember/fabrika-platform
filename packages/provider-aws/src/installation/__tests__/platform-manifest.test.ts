// The platform proxy's manifest on AWS: the platform's three apps on the installation's hosts, dialled at their Service
// Connect names, OAuth served under IAM's public origin, the bytes' digest the image's tag carries, and what the
// services derive from it.

import { platformProxyAppFor, platformServiceTableDigest, resolvePlatformProxyManifest } from '@fabrika/installation-init'
import { parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../generated/platform-proxy-manifest'
import { awsPlatformManifest } from '../platform-manifest'
import { PLAN } from './platform-fixture'

describe("the platform proxy's manifest on AWS", () => {
	test('each app on its own host, dialled at its Service Connect name, OAuth under IAM', () => {
		const manifest = awsPlatformManifest(PLAN, { mcp: false })
		const parsed = parseProxyManifestJson(manifest.json)
		if (parsed === null) throw new Error('the manifest does not parse')
		expect(parsed.apps.map((app) => [app.hosts, app.upstream])).toEqual([
			[['iam.example.com'], 'iam:3000'],
			[['control.example.com'], 'control:3000'],
			[['operations.example.com'], 'operations:3000'],
		])
		expect(manifest.sha256).toBe(createHash('sha256').update(manifest.json, 'utf8').digest('hex'))
		// The console's table as an https installation with IAM as its authorization server publishes it.
		const published = resolvePlatformProxyManifest(PLATFORM_PROXY_MANIFEST_TEMPLATE, {
			scheme: 'https',
			placement: { iam: { hosts: ['iam.example.com'] }, control: { hosts: ['control.example.com'] }, operations: { hosts: ['operations.example.com'] } },
			authorizationServer: 'https://iam.example.com',
			mcp: false,
		})
		expect(manifest.deployed.controlTableDigest).toBe(
			platformServiceTableDigest(published, platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control').id),
		)
		expect(manifest.deployed.oauthConfig?.hosts).toEqual(['iam.example.com', 'control.example.com', 'operations.example.com'])
		expect(manifest.deployed.oauthConfig?.resources.every((resource) => resource.resource.startsWith('https://control.example.com/'))).toBe(true)
	})

	test('new hosts or MCP authoring make another manifest, so another image', () => {
		const base = awsPlatformManifest(PLAN, { mcp: false })
		expect(awsPlatformManifest(PLAN, { mcp: false }).sha256).toBe(base.sha256)
		expect(awsPlatformManifest(PLAN, { mcp: true }).sha256).not.toBe(base.sha256)
		expect(awsPlatformManifest({ hosts: { ...PLAN.hosts, control: 'console.example.com' } }, { mcp: false }).sha256).not.toBe(base.sha256)
	})
})
