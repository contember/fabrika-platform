// A deploy whose approved contract holds a row an older namespace proxy cannot read (a public procedure, several
// capabilities) is refused while the namespace's proxy is pinned to another source than this control plane's: the
// older proxy's strict parser would refuse the whole manifest at the next republish, for every member.

import type { ContractArtifact, EndpointRow } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { assertNamespaceProxyReads, rowsNeedingCurrentProxy } from '../namespace/proxy-reads'
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
const withPublic: ContractArtifact = { ...notesArtifact, endpoints: [...notesArtifact.endpoints, PUBLIC] }

describe('a namespace proxy pinned to an older source', () => {
	test('refuses a contract with a public procedure, naming the row and the re-pin', () => {
		expect(rowsNeedingCurrentProxy(withPublic)).toEqual(['api.stats.cta'])
		expect(() => assertNamespaceProxyReads('apps-prod', withPublic, OLDER, CURRENT)).toThrow(
			/`api\.stats\.cta`[\s\S]*fabrika control namespaces update --namespace=apps-prod --proxy-source=current/,
		)
	})

	test('deploys a contract of rows every proxy reads, a 0.5 contract among them', () => {
		expect(rowsNeedingCurrentProxy(notesArtifact)).toEqual([])
		expect(() => assertNamespaceProxyReads('apps-prod', notesArtifact, OLDER, CURRENT)).not.toThrow()
	})

	test('deploys anything once the proxy is on this platform source, or with nothing approved', () => {
		expect(() => assertNamespaceProxyReads('apps-prod', withPublic, CURRENT, CURRENT)).not.toThrow()
		expect(() => assertNamespaceProxyReads('apps-prod', undefined, OLDER, CURRENT)).not.toThrow()
	})
})
