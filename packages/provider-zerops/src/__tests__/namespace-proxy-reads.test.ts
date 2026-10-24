// A deploy whose approved contract holds a row or a CSP no older release's proxy reads is refused while the namespace's
// proxy is pinned to another source than this control plane's: the older proxy's strict parser would refuse the whole
// manifest at the next republish, for every member. Control's real parsers are tested in `packages/control`
// (`older-proxies.test.ts`); here each older release is a reader that refuses a set of row kinds and `workerSrc`.

import { type ContractArtifact, contractDigest, type EndpointRow } from '@fabrika/auth-core'
import type { ProviderApprovedAccess } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { FABRIKA_CHECK_VERSION } from '../execution'
import { assertNamespaceProxyReads, entriesNeedingCurrentProxy, type OlderProxyReader, type OlderProxyReaders } from '../namespace/proxy-reads'
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

/** An older release that refuses rows of `kinds`, and an entry whose CSP names a directive it does not know. */
const refusing = (...kinds: readonly string[]): OlderProxyReader => ({
	row: (row) => !kinds.includes(row.kind),
	csp: (csp) => csp.workerSrc === undefined,
	signsOut: false,
})
const WINDOW: OlderProxyReaders = [refusing('public', 'webhook'), refusing('public')]
const WORKERS = { origin: 'blob:', purpose: 'the workers of the altcha challenge' }
const withWorkers = access({ ...notesArtifact, csp: { ...notesArtifact.csp, workerSrc: [WORKERS] } })

describe('a namespace proxy pinned to an older source', () => {
	test('refuses a contract with a row no older release reads, naming the row and the re-pin', () => {
		expect(entriesNeedingCurrentProxy(withPublic, WINDOW)).toEqual(['api.stats.cta'])
		expect(() => assertNamespaceProxyReads('apps-prod', withPublic, OLDER, { proxySource: CURRENT, olderProxies: WINDOW })).toThrow(
			/`api\.stats\.cta`[\s\S]*fabrika control namespaces update --namespace=apps-prod --proxy-source=current/,
		)
	})

	test('deploys a row one older release reads: the pin may be that release', () => {
		expect(entriesNeedingCurrentProxy(notes, WINDOW)).toEqual([])
		expect(entriesNeedingCurrentProxy(notes, [refusing('webhook')])).toEqual([WEBHOOK.id])
		expect(() => assertNamespaceProxyReads('apps-prod', notes, OLDER, { proxySource: CURRENT, olderProxies: WINDOW })).not.toThrow()
	})

	test('refuses a contract whose CSP no older release reads, naming it', () => {
		expect(entriesNeedingCurrentProxy(withWorkers, WINDOW)).toEqual(['csp'])
		expect(() => assertNamespaceProxyReads('apps-prod', withWorkers, OLDER, { proxySource: CURRENT, olderProxies: WINDOW })).toThrow(/`csp`/)
		expect(() => assertNamespaceProxyReads('apps-prod', withWorkers, CURRENT, { proxySource: CURRENT, olderProxies: WINDOW })).not.toThrow()
	})

	test('refuses a contract that declares a terminal: no older release serves its sign-out (ADR-0067)', () => {
		const withTerminal = access({ ...notesArtifact, terminal: { identify: '/identify' } })
		expect(entriesNeedingCurrentProxy(withTerminal, WINDOW)).toEqual(['terminal'])
		// Even where every older release reads every row and the CSP.
		expect(entriesNeedingCurrentProxy(withTerminal, [refusing()])).toEqual(['terminal'])
		expect(() => assertNamespaceProxyReads('apps-prod', withTerminal, OLDER, { proxySource: CURRENT, olderProxies: WINDOW })).toThrow(
			/`terminal`[\s\S]*--proxy-source=current/,
		)
		expect(() => assertNamespaceProxyReads('apps-prod', withTerminal, CURRENT, { proxySource: CURRENT, olderProxies: WINDOW })).not.toThrow()
	})

	test('admits a terminal behind a pin once an older release serves the sign-out', () => {
		const withTerminal = access({ ...notesArtifact, terminal: { identify: '/identify' } })
		const signingOut: OlderProxyReaders = [refusing(), { ...refusing(), signsOut: true }]
		expect(entriesNeedingCurrentProxy(withTerminal, signingOut)).toEqual([])
		expect(() => assertNamespaceProxyReads('apps-prod', withTerminal, OLDER, { proxySource: CURRENT, olderProxies: signingOut })).not.toThrow()
	})

	test('deploys anything once the proxy is on this platform source, without namespaces, or with nothing approved', () => {
		const platform = { proxySource: CURRENT, olderProxies: WINDOW }
		expect(() => assertNamespaceProxyReads('apps-prod', withPublic, CURRENT, platform)).not.toThrow()
		expect(() => assertNamespaceProxyReads('apps-prod', withPublic, OLDER, undefined)).not.toThrow()
		expect(() => assertNamespaceProxyReads('apps-prod', undefined, OLDER, platform)).not.toThrow()
	})
})
