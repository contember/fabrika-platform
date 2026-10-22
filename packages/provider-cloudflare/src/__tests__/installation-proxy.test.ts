/**
 * An installation service's proxy Worker (ADR-0022 "Installation entries"): `createCloudflareProxyWorker` bakes its
 * service table into the manifest as an installation entry, which the proxy reads as one and never as an application.
 */

import type { InstallationEndpointTable } from '@fabrika/auth-core'
import { isApplicationEntry, parseProxyManifestJson, serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { Worker } from 'oblaka-iac'
import { createCloudflareProxyWorker, proxyManifestJson } from '../proxy'

const SERVICE: InstallationEndpointTable = {
	endpoints: [{
		id: 'ingest',
		kind: 'protocol',
		method: '*',
		path: '/api/:projectId/envelope/',
		callers: [],
		requirement: null,
		admission: null,
		oauth: null,
	}],
	reservedPrefixes: [],
}

const app = () =>
	new Worker({ dir: '.', name: 'service', main: './src/worker.ts', compatibility_flags: [], bindings: {}, workers_dev: false, routes: [] })

describe('an installation service behind its Cloudflare proxy Worker', () => {
	test('the manifest carries its table as an installation entry, with every digest the parser checks', () => {
		const worker = createCloudflareProxyWorker({
			name: 'service-proxy',
			app: app(),
			appId: 'operations',
			appHost: 'errors.example.com',
			installation: serviceProxyTable(SERVICE, { oauth: false }),
		})
		const encoded = proxyManifestJson(worker)
		const entry = typeof encoded === 'string' ? parseProxyManifestJson(encoded)?.apps[0] : undefined
		if (entry === undefined) throw new Error('the proxy Worker carries no table')
		expect(isApplicationEntry(entry)).toBe(false)
		expect(entry.endpoints.map((row) => row.id)).toEqual(['ingest'])
		expect(entry.hosts).toEqual(['errors.example.com'])
	})
})
