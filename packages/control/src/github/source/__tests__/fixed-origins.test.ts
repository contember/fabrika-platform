import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	type ZeropsAppConfig,
	zeropsArtifactCodec,
	zeropsNamespaceTargetCodec,
	zeropsStoredTargetCodec,
} from '@fabrika/provider-zerops'
import { expect, spyOn, test } from 'bun:test'
import { createRuntime } from '../../../zerops/runtime'

const COMMIT_SHA = 'a'.repeat(40)
const config: ZeropsAppConfig = { id: 'notes', target: { platform: 'zerops', services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }] } }
const proxySource = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: COMMIT_SHA,
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}

/** Names an operator might reach for to move GitHub. None of them may reach the source: only code-level seams can (ADR-0029). */
const ORIGIN_OVERRIDES = {
	GITHUB_API_URL: 'https://github.attacker.test',
	GITHUB_API_ORIGIN: 'https://github.attacker.test',
	GITHUB_CODELOAD_URL: 'https://codeload.attacker.test',
	FABRIKA_GITHUB_API_URL: 'https://github.attacker.test',
	FABRIKA_GITHUB_API_ORIGIN: 'https://github.attacker.test',
	FABRIKA_SOURCE_GITHUB_ORIGIN: 'https://github.attacker.test',
}

test("the Zerops composition's GitHub source addresses api.github.com whatever the environment names", async () => {
	const requested: string[] = []
	const notFound = async (input: RequestInfo | URL): Promise<Response> => {
		requested.push(input instanceof Request ? input.url : String(input))
		return new Response(null, { status: 404 })
	}
	const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(notFound, { preconnect: fetch.preconnect }))
	const runtime = createRuntime({
		...ORIGIN_OVERRIDES,
		FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
		FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
		FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
		FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
		FABRIKA_IAM_RPC_URL: 'http://iam:3000',
		FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
		FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
		FABRIKA_ZEROPS_CLIENT_ID: 'client-1',
		FABRIKA_ZEROPS_PROXY_SOURCE_JSON: JSON.stringify(proxySource),
		FABRIKA_ZEROPS_PROXY_IAM_URL: 'https://iam.example.test',
		FABRIKA_ZEROPS_PROXY_IAM_KEY: 'px_proxy_placeholder',
		ENVIRONMENT: 'stage',
	})
	try {
		const resolveSource = runtime.provider.resolveSource
		if (resolveSource === undefined) throw new Error('the Zerops provider resolves no source')
		await expect(resolveSource({
			runId: 'run-1',
			app: { id: 'notes', source: { repoUrl: 'https://github.com/acme/notes', ref: 'refs/heads/main' } },
			environment: {
				appId: 'notes',
				env: 'prod',
				namespace: {
					id: 'apps-prod',
					env: 'prod',
					target: {
						provider: 'zerops',
						version: zeropsNamespaceTargetCodec.version,
						payload: zeropsNamespaceTargetCodec.encode({ proxySource, projectId: 'project-1', proxyServiceId: 'proxy-1', ready: true }),
					},
				},
				target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: zeropsStoredTargetCodec.encode({ serviceId: 'notes-1' }) },
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode(
						compileFabrikaManifest(config, 'prod', await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: notes\n')),
					),
				},
			},
			signal: AbortSignal.timeout(5_000),
		})).rejects.toThrow('(ref_not_found)')
		expect(requested).toEqual([`https://api.github.com/repos/acme/notes/commits/${encodeURIComponent('refs/heads/main')}`])
	} finally {
		transport.mockRestore()
		await runtime.shutdown()
	}
})
