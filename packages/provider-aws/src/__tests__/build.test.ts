// The build of one deploy: the constant buildspec read as CodeBuild reads it, every value of a run passed as a variable
// (the presigned URL, the Dockerfile, the image of this run's tag, the registry, the source-map bearer by parameter), the
// stated timeouts, and that the CodeBuild client takes the start it renders.

import { SOURCE_MAP_UPLOAD_SECRET } from '@fabrika/app/build'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { codeBuildClient } from '../aws/codebuild'
import { CODEBUILD } from '../aws/json'
import { AWS_BUILDSPEC, type AwsBuildInput, awsBuildStart, awsImageTag, BUILD_VARIABLES, MAX_DOCKERFILE_BYTES } from '../build'
import { AWS_BUILD_QUEUED_TIMEOUT_MINUTES, AWS_BUILD_TIMEOUT_MINUTES } from '../run-attempt'
import { fakeAws } from './helpers/fake-aws'

const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const REGISTRY = '123456789012.dkr.ecr.eu-central-1.amazonaws.com'
/** The name of the SecureString that holds the presigned URL: a function of the run. */
const SOURCE_URL_PARAMETER = `/fabrika/main/builds/${TOKEN}/source-url`
const DOCKERFILE = '# Generated\nFROM oven/bun@sha256:aa AS build\nRUN echo "$HOME" && printf \'%s\' x\n'

const input: AwsBuildInput = {
	project: 'fabrika-apps-build',
	buildToken: TOKEN,
	sourceUrlParameter: SOURCE_URL_PARAMETER,
	dockerfile: DOCKERFILE,
	repositoryUri: `${REGISTRY}/fabrika/notes-prod`,
	sourceMapKeyParameter: null,
}

const buildspecSchema = z.object({
	version: z.number(),
	env: z.object({ shell: z.literal('bash') }).strict(),
	phases: z.object({ pre_build: z.object({ commands: z.array(z.string()) }).strict(), build: z.object({ commands: z.array(z.string()) }).strict() })
		.strict(),
}).strict()

describe('the build', () => {
	test('the buildspec reads as CodeBuild reads it: one shell, the archive into a clean context, the image pushed', () => {
		const spec = buildspecSchema.parse(Bun.YAML.parse(AWS_BUILDSPEC))
		expect(spec.version).toBe(0.2)
		expect(spec.phases.pre_build.commands).toEqual([
			'set -euo pipefail',
			'aws ecr get-login-password --region "$FABRIKA_REGISTRY_REGION" | docker login --username AWS --password-stdin "$FABRIKA_REGISTRY"',
			'mkdir /tmp/fabrika-source',
			'curl --fail --silent --show-error --proto =https --output /tmp/fabrika-source.tar.gz "$FABRIKA_SOURCE_URL"',
			'unset FABRIKA_SOURCE_URL',
			'tar --extract --gzip --file /tmp/fabrika-source.tar.gz --directory /tmp/fabrika-source --strip-components=1 --no-same-owner',
			`printf '%s' "$FABRIKA_DOCKERFILE" | base64 --decode > /tmp/fabrika-Dockerfile`,
			// The Dockerfile's own ignore file, which ignores nothing: the application's `.dockerignore` filters nothing.
			"printf '%s\\n' '# The platform builds the whole archive, so nothing is ignored.' > /tmp/fabrika-Dockerfile.dockerignore",
		])
		expect(spec.phases.build.commands).toEqual([
			'set -euo pipefail',
			`DOCKER_BUILDKIT=1 docker build --platform linux/arm64 --file /tmp/fabrika-Dockerfile \${FABRIKA_SOURCE_MAP_UPLOAD_KEY:+--secret id=${SOURCE_MAP_UPLOAD_SECRET},env=FABRIKA_SOURCE_MAP_UPLOAD_KEY} --tag "$FABRIKA_IMAGE" /tmp/fabrika-source`,
			'docker push "$FABRIKA_IMAGE"',
		])
	})

	test('every value of a run is a variable, the image under the tag of the run, with the stated timeouts', () => {
		const start = awsBuildStart(input)
		expect(start).toEqual({
			project: 'fabrika-apps-build',
			token: TOKEN,
			buildspec: AWS_BUILDSPEC,
			variables: {
				// The presigned URL by its parameter's name: the start records no credential.
				[BUILD_VARIABLES.sourceUrl]: { parameter: SOURCE_URL_PARAMETER },
				[BUILD_VARIABLES.dockerfile]: { value: new TextEncoder().encode(DOCKERFILE).toBase64() },
				[BUILD_VARIABLES.image]: { value: `${REGISTRY}/fabrika/notes-prod:run-${TOKEN}` },
				[BUILD_VARIABLES.registry]: { value: REGISTRY },
				[BUILD_VARIABLES.registryRegion]: { value: 'eu-central-1' },
			},
			timeoutMinutes: AWS_BUILD_TIMEOUT_MINUTES,
			queuedTimeoutMinutes: AWS_BUILD_QUEUED_TIMEOUT_MINUTES,
		})
		expect(awsImageTag(TOKEN)).toBe(`run-${TOKEN}`)
		// Nothing of a run is in the buildspec.
		for (const value of [SOURCE_URL_PARAMETER, REGISTRY, TOKEN, 'notes-prod']) expect(AWS_BUILDSPEC).not.toContain(value)
	})

	test('the source-map bearer travels by its parameter, and the CodeBuild client takes the start', async () => {
		const start = awsBuildStart({ ...input, sourceMapKeyParameter: '/fabrika/main/apps/notes/prod/FABRIKA_SOURCE_MAP_UPLOAD_KEY' })
		expect(start.variables[BUILD_VARIABLES.sourceMapKey]).toEqual({ parameter: '/fabrika/main/apps/notes/prod/FABRIKA_SOURCE_MAP_UPLOAD_KEY' })
		const { options, calls } = fakeAws(CODEBUILD, {
			StartBuild: () => ({ build: { id: `fabrika-apps-build:${TOKEN}`, buildStatus: 'IN_PROGRESS', currentPhase: 'QUEUED' } }),
		})
		expect(await codeBuildClient(options).startBuild(start)).toMatchObject({ status: 'in_progress' })
		expect(calls[0]?.body).toMatchObject({
			projectName: 'fabrika-apps-build',
			idempotencyToken: TOKEN,
			sourceTypeOverride: 'NO_SOURCE',
			timeoutInMinutesOverride: AWS_BUILD_TIMEOUT_MINUTES,
			queuedTimeoutInMinutesOverride: AWS_BUILD_QUEUED_TIMEOUT_MINUTES,
		})
		expect(JSON.stringify(calls[0]?.body)).toContain(
			'"name":"FABRIKA_SOURCE_MAP_UPLOAD_KEY","value":"/fabrika/main/apps/notes/prod/FABRIKA_SOURCE_MAP_UPLOAD_KEY","type":"PARAMETER_STORE"',
		)
	})

	test('refuses a repository, source URL, Dockerfile or parameter of another form', () => {
		const refusals: readonly [Partial<AwsBuildInput>, string][] = [
			[{ repositoryUri: 'docker.io/library/bun' }, 'the repository'],
			[{ repositoryUri: `${REGISTRY}/Notes` }, 'the repository'],
			// Names ECR refuses are refused at the start, not at the build.
			[{ repositoryUri: `${REGISTRY}/a//b` }, 'the repository'],
			[{ repositoryUri: `${REGISTRY}/a.-b` }, 'the repository'],
			[{ repositoryUri: `${REGISTRY}/a/-b` }, 'the repository'],
			[{ repositoryUri: `${REGISTRY}/a` }, 'the repository'],
			[{ sourceUrlParameter: 'https://bucket.example/source.tar.gz' }, 'the source URL parameter'],
			[{ sourceUrlParameter: 'no-slash' }, 'the source URL parameter'],
			[{ dockerfile: '' }, 'the Dockerfile'],
			[{ dockerfile: 'x'.repeat(MAX_DOCKERFILE_BYTES + 1) }, 'the Dockerfile'],
			[{ sourceMapKeyParameter: 'no-slash' }, 'the source-map key parameter'],
		]
		for (const [change, message] of refusals) expect(() => awsBuildStart({ ...input, ...change })).toThrow(message)
	})
})
