// The build of a namespace proxy's image: the constant buildspec read as CodeBuild reads it (the archive fetched as an
// application's is, the manifest required, the commit's own recipe built for linux/amd64), every value of an attempt a
// variable, and that the CodeBuild client takes the start it renders.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { codeBuildClient } from '../aws/codebuild'
import { CODEBUILD } from '../aws/json'
import { AWS_BUILDSPEC, BUILD_VARIABLES } from '../build'
import { AWS_PROXY_BUILDSPEC, AWS_PROXY_DOCKERFILE, AWS_PROXY_MANIFEST_PATH, type AwsProxyBuildInput, awsProxyBuildStart } from '../proxy-build'
import { AWS_BUILD_QUEUED_TIMEOUT_MINUTES, AWS_BUILD_TIMEOUT_MINUTES } from '../run-attempt'
import { fakeAws } from './helpers/fake-aws'

const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const REGISTRY = '123456789012.dkr.ecr.eu-central-1.amazonaws.com'
const SOURCE_URL_PARAMETER = `/fabrika/namespaces/shared/prod/builds/${TOKEN}/source-url`

const input: AwsProxyBuildInput = {
	project: 'fabrika_ns_shared_prod',
	buildToken: TOKEN,
	sourceUrlParameter: SOURCE_URL_PARAMETER,
	repositoryUri: `${REGISTRY}/fabrika/namespaces/shared/prod/proxy`,
}

const buildspecSchema = z.object({
	version: z.number(),
	env: z.object({ shell: z.literal('bash') }).strict(),
	phases: z.object({ pre_build: z.object({ commands: z.array(z.string()) }).strict(), build: z.object({ commands: z.array(z.string()) }).strict() })
		.strict(),
}).strict()

describe('the proxy build', () => {
	test("the buildspec fetches the archive as an application's does, requires the manifest and builds the commit's recipe on x86", () => {
		const spec = buildspecSchema.parse(Bun.YAML.parse(AWS_PROXY_BUILDSPEC))
		const application = buildspecSchema.parse(Bun.YAML.parse(AWS_BUILDSPEC))
		expect(spec.version).toBe(0.2)
		// The same fetch, line for line; then the manifest the proxy is built with, never a rendered Dockerfile.
		expect(spec.phases.pre_build.commands).toEqual([
			...application.phases.pre_build.commands.slice(0, 6),
			'test -f /tmp/fabrika-source/proxy.manifest.json',
		])
		expect(AWS_PROXY_MANIFEST_PATH).toBe('proxy.manifest.json')
		expect(spec.phases.build.commands).toEqual([
			'set -euo pipefail',
			`DOCKER_BUILDKIT=1 docker build --platform linux/amd64 --file /tmp/fabrika-source/${AWS_PROXY_DOCKERFILE} --tag "$FABRIKA_IMAGE" /tmp/fabrika-source`,
			'docker push "$FABRIKA_IMAGE"',
		])
		expect(AWS_PROXY_DOCKERFILE).toBe('packages/proxy/Dockerfile')
		expect(AWS_PROXY_BUILDSPEC).not.toContain(BUILD_VARIABLES.dockerfile)
	})

	test('every value of an attempt is a variable, the presigned URL by its parameter, with the stated timeouts', async () => {
		const start = awsProxyBuildStart(input)
		expect(start).toEqual({
			project: 'fabrika_ns_shared_prod',
			token: TOKEN,
			buildspec: AWS_PROXY_BUILDSPEC,
			variables: {
				[BUILD_VARIABLES.sourceUrl]: { parameter: SOURCE_URL_PARAMETER },
				[BUILD_VARIABLES.image]: { value: `${REGISTRY}/fabrika/namespaces/shared/prod/proxy:run-${TOKEN}` },
				[BUILD_VARIABLES.registry]: { value: REGISTRY },
				[BUILD_VARIABLES.registryRegion]: { value: 'eu-central-1' },
			},
			timeoutMinutes: AWS_BUILD_TIMEOUT_MINUTES,
			queuedTimeoutMinutes: AWS_BUILD_QUEUED_TIMEOUT_MINUTES,
		})
		for (const value of [SOURCE_URL_PARAMETER, REGISTRY, TOKEN, 'shared']) expect(AWS_PROXY_BUILDSPEC).not.toContain(value)

		const { options, calls } = fakeAws(CODEBUILD, {
			StartBuild: () => ({ build: { id: `fabrika_ns_shared_prod:${TOKEN}`, buildStatus: 'IN_PROGRESS', currentPhase: 'QUEUED' } }),
		})
		expect(await codeBuildClient(options).startBuild(start)).toMatchObject({ status: 'in_progress' })
		expect(calls[0]?.body).toMatchObject({ projectName: 'fabrika_ns_shared_prod', idempotencyToken: TOKEN, sourceTypeOverride: 'NO_SOURCE' })
	})

	test('refuses a repository or source URL parameter of another form', () => {
		const refusals: readonly [Partial<AwsProxyBuildInput>, string][] = [
			[{ repositoryUri: 'docker.io/library/caddy' }, 'the repository'],
			[{ repositoryUri: `${REGISTRY}/a//b` }, 'the repository'],
			[{ sourceUrlParameter: 'https://bucket.example/source.tar.gz' }, 'the source URL parameter'],
		]
		for (const [change, message] of refusals) expect(() => awsProxyBuildStart({ ...input, ...change })).toThrow(message)
	})
})
