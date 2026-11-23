import { ProviderNamespaceError, type ProviderNamespaceMember } from '@fabrika/provider-contract'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { createZeropsApi } from '../api'
import { createZeropsArtifactSourceDescriptor } from '../manifest'
import { createZeropsNamespaceCapabilities } from '../namespace'
import { zeropsNamespaceTargetCodec } from '../namespace/codec'
import { ZEROPS_PROXY_SUSPENSION_UNSUPPORTED } from '../namespace/errors'
import type { ZeropsNamespaceProxySource } from '../namespace/types'
import { FABRIKA_PROXY_MANIFEST_SUSPEND, zeropsProxyAcceptsSuspension } from '../proxy-manifest-carrier'

/** A namespace pinned to a source before the marker: every 0.4–0.6 release, whose strict parser refuses `suspended`. */
const olderPin: ZeropsNamespaceProxySource = {
	repository: { owner: 'contember', name: 'fabrika-platform' },
	commitSha: 'a'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}
const currentPin: ZeropsNamespaceProxySource = {
	...olderPin,
	commitSha: 'c'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor(
		`zerops:\n  - setup: proxy\n    build:\n      envVariables:\n        ${FABRIKA_PROXY_MANIFEST_SUSPEND}: "1"\n`,
	),
}

function capabilities(calls: string[]) {
	return createZeropsNamespaceCapabilities({
		clientId: 'client',
		proxySource: currentPin,
		iamUrl: 'https://iam.example.test',
		iamKey: 'not-logged',
		api: createZeropsApi({
			token: 'unused',
			fetchImpl: async (url) => {
				calls.push(String(url))
				throw new Error('no platform call expected')
			},
		}),
	})
}

const namespaceOn = (proxySource: ZeropsNamespaceProxySource) => ({
	id: 'apps-prod',
	env: 'prod',
	target: {
		provider: 'zerops',
		version: 1,
		payload: zeropsNamespaceTargetCodec.encode({ proxySource, projectId: 'project', proxyServiceId: 'proxy', ready: true }),
	},
})

test('the generated proxy setup this release deploys declares the marker, so a namespace re-pinned to it can suspend', async () => {
	const descriptor = await Bun.file(join(import.meta.dir, '../../../../zerops.yaml')).text()
	expect(zeropsProxyAcceptsSuspension(descriptor)).toBe(true)
})

test('suspension is refused for a namespace pinned to an older proxy, naming the re-pin, and admitted on a current pin', () => {
	const calls: string[] = []
	const assertSuspendable = capabilities(calls).assertSuspendable
	if (assertSuspendable === undefined) throw new Error('assertSuspendable capability missing')
	let refusal: unknown
	try {
		assertSuspendable(namespaceOn(olderPin))
	} catch (error) {
		refusal = error
	}
	if (!(refusal instanceof ProviderNamespaceError)) throw new Error('expected a namespace refusal')
	expect(refusal.code).toBe(ZEROPS_PROXY_SUSPENSION_UNSUPPORTED)
	expect(refusal.retryable).toBe(false)
	expect(refusal.message).toContain('fabrika control namespaces update --namespace=apps-prod --proxy-source=current')
	expect(() => assertSuspendable(namespaceOn(currentPin))).not.toThrow()
	expect(calls).toEqual([])
})

test('a republish that carries a suspended member to an older pin is refused before any platform call', async () => {
	const calls: string[] = []
	const republish = capabilities(calls).republish
	if (republish === undefined) throw new Error('republish capability missing')
	const member: ProviderNamespaceMember = {
		appId: 'notes',
		env: 'prod',
		domain: 'notes.example.com',
		artifact: { provider: 'zerops', version: 1, payload: {} },
		suspended: true,
	}
	await expect(republish({
		namespace: namespaceOn(olderPin),
		members: [member],
		wait: 'started',
		signal: new AbortController().signal,
		events: { checkpoint: async () => {}, boundary: async () => {} },
	})).rejects.toThrow('cannot take an environment offline')
	expect(calls).toEqual([])
})
