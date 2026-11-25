// The proxy manifest of an AWS namespace: one entry per member with approved access, routed on its domain to its
// service's discovery name, its table the approved contract's, and every member the proxy cannot route refused or left
// out, by the same rule `memberHosts` answers.

import { contractDigest } from '@fabrika/auth-core'
import type { ProviderApprovedAccess, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { contractProxyTable, parseProxyManifest } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { awsAppArtifactCodec } from '../codecs'
import { awsNamespaceMemberHosts, awsNamespaceProxyManifest, awsProxyUpstream } from '../proxy-manifest'

const ACCOUNT = '123456789012'
const contract = { ...notesArtifact, tables: {}, jobs: {}, files: {}, fileKinds: {} }
const access: ProviderApprovedAccess = { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract), checker: '0.9.1' }

const member = (change: Partial<ProviderNamespaceMember> = {}): ProviderNamespaceMember => ({
	appId: 'notes',
	env: 'prod',
	domain: 'Notes.Example.com',
	artifact: { provider: 'aws', version: 1, payload: awsAppArtifactCodec.encode({ contractDigest: contractDigest(contract), healthPath: '/healthz' }) },
	access,
	...change,
})

describe('awsNamespaceProxyManifest', () => {
	test("routes a member on its domain to its service's discovery name, with the approved contract's table", () => {
		const manifest = awsNamespaceProxyManifest('shared', [member({ operationsOrigin: 'https://ops.example.com' })], ACCOUNT)
		expect(manifest.apps).toHaveLength(1)
		const [entry] = manifest.apps
		expect(entry).toMatchObject({
			id: 'notes@prod',
			hosts: ['notes.example.com'],
			upstream: 'http://e5-notes-prod:3000',
			// The balancer terminates TLS: the browser speaks https.
			scheme: 'https',
			operationsOrigin: 'https://ops.example.com',
		})
		expect(entry).not.toHaveProperty('suspended')
		expect(entry && 'endpoints' in entry ? entry.endpoints : null).toEqual(contractProxyTable(access.contract, access.contractDigest).endpoints)
		// The proxy's own parser takes it as it is.
		expect(parseProxyManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
	})

	test('the upstream is derived from the application id and environment, never read from the member', () => {
		expect(awsProxyUpstream('notes', 'stage', ACCOUNT)).toBe('http://e5-notes-stage:3000')
		const manifest = awsNamespaceProxyManifest('shared', [member(), member({ env: 'stage', domain: 'stage.example.com' })], ACCOUNT)
		expect(manifest.apps.map((app) => app.upstream)).toEqual(['http://e5-notes-prod:3000', 'http://e5-notes-stage:3000'])
	})

	test('a member without approved access is not routed; a suspended one is routed to answer 503', () => {
		const { access: _none, ...unapproved } = member()
		expect(awsNamespaceProxyManifest('shared', [unapproved], ACCOUNT).apps).toEqual([])
		expect(awsNamespaceMemberHosts(unapproved)).toEqual([])
		expect(awsNamespaceProxyManifest('shared', [member({ suspended: true })], ACCOUNT).apps[0]).toMatchObject({ suspended: true })
	})

	test('a routed member without a domain, two on one host, a dev member or one of another provider is refused', () => {
		expect(() => awsNamespaceProxyManifest('shared', [member({ domain: '' })], ACCOUNT)).toThrow('has no domain for its proxy to route')
		expect(() => awsNamespaceProxyManifest('shared', [member(), member({ env: 'stage', domain: 'notes.example.com' })], ACCOUNT)).toThrow(
			'are routed on notes.example.com',
		)
		expect(() => awsNamespaceProxyManifest('shared', [member(), member()], ACCOUNT)).toThrow('holds notes@prod twice')
		expect(() => awsNamespaceProxyManifest('shared', [member({ devSandboxes: [] })], ACCOUNT)).toThrow('a dev environment')
		expect(() => awsNamespaceProxyManifest('shared', [member({ artifact: { provider: 'zerops', version: 1, payload: {} } })], ACCOUNT)).toThrow()
	})

	test('memberHosts answers the host the manifest routes a member on, lower-cased', () => {
		expect(awsNamespaceMemberHosts(member())).toEqual(['notes.example.com'])
		expect(() => awsNamespaceMemberHosts(member({ domain: undefined }))).toThrow('has no domain')
	})
})
