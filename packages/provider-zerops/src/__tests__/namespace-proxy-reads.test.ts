// A deploy whose approved contract holds a row no older release's proxy reads is refused while the namespace's proxy is
// pinned to another source than this control plane's: the older proxy's strict parser would refuse the whole manifest
// at the next republish, for every member. Control's real parsers are tested in `packages/control`
// (`older-proxies.test.ts`); here each older release is a reader that refuses a set of row kinds.

import { type ContractArtifact, contractDigest, type EndpointRow } from '@fabrika/auth-core'
import type { ProviderApprovedAccess } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { FABRIKA_CHECK_VERSION } from '../execution'
import { assertNamespaceProxyReads, type OlderProxyRowReader, type OlderProxyRowReaders, rowsNeedingCurrentProxy } from '../namespace/proxy-reads'
import type { ZeropsNamespaceProxySource } from '../namespace/types'

const source = (commitSha: string): ZeropsNamespaceProxySource => ({
	repository: { owner: 'example', name: 'platform' },
	commitSha,
	descriptor: { path: 'zerops.yaml', contents: 'zerops: []', sha256: 'a'.repeat(64) },
})
const CURRENT = source('b'.repeat(40))
const OLDER = source('c'.repeat(40))

const PUBLIC: EndpointRow = {
	id: 'api.stats.cta',
	source: { kind: 'mount', name: 'api' },
	kind: 'public',
	method: 'POST',
	path: '/api/stats.cta',
	callers: [],
	requirement: null,
	admission: { contentTypes: ['application/json'], maxBytes: 1024 },
	input: { type: 'object', fields: {} },
	output: { type: 'object', fields: {} },
}
const WEBHOOK = notesArtifact.endpoints.find((row) => row.kind === 'webhook')
if (WEBHOOK === undefined) throw new Error('the notes fixture has a webhook')

const access = (contract: ContractArtifact): ProviderApprovedAccess => ({
	contract,
	contractDigest: contractDigest(contract),
	schema: schemaFromContract(contract),
	checker: FABRIKA_CHECK_VERSION,
})
const withPublic = access({ ...notesArtifact, endpoints: [...notesArtifact.endpoints, PUBLIC] })
const notes = access(notesArtifact)

const refusing = (...kinds: readonly string[]): OlderProxyRowReader => (row) => !kinds.includes(row.kind)
const WINDOW: OlderProxyRowReaders = [refusing('public', 'webhook'), refusing('public')]

describe('a namespace proxy pinned to an older source', () => {
	test('refuses a contract with a row no older release reads, naming the row and the re-pin', () => {
		expect(rowsNeedingCurrentProxy(withPublic, WINDOW)).toEqual(['api.stats.cta'])
		expect(() => assertNamespaceProxyReads('apps-prod', withPublic, OLDER, { proxySource: CURRENT, olderProxies: WINDOW })).toThrow(
			/`api\.stats\.cta`[\s\S]*fabrika control namespaces update --namespace=apps-prod --proxy-source=current/,
		)
	})

	test('deploys a row one older release reads: the pin may be that release', () => {
		expect(rowsNeedingCurrentProxy(notes, WINDOW)).toEqual([])
		expect(rowsNeedingCurrentProxy(notes, [refusing('webhook')])).toEqual([WEBHOOK.id])
		expect(() => assertNamespaceProxyReads('apps-prod', notes, OLDER, { proxySource: CURRENT, olderProxies: WINDOW })).not.toThrow()
	})

	test('deploys anything once the proxy is on this platform source, without namespaces, or with nothing approved', () => {
		const platform = { proxySource: CURRENT, olderProxies: WINDOW }
		expect(() => assertNamespaceProxyReads('apps-prod', withPublic, CURRENT, platform)).not.toThrow()
		expect(() => assertNamespaceProxyReads('apps-prod', withPublic, OLDER, undefined)).not.toThrow()
		expect(() => assertNamespaceProxyReads('apps-prod', undefined, OLDER, platform)).not.toThrow()
	})
})
