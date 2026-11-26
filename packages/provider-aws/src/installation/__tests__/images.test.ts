// The platform's images: the stack's repositories, build role and project under the platform's names, the buildspec
// that fetches the release commit by its full id and checks it, and one build's start per image, every value a
// variable and checked first.

import { describe, expect, test } from 'bun:test'
import { awsControlPolicies } from '../access'
import {
	AWS_IMAGES_BUILDSPEC,
	AWS_IMAGES_PROJECT,
	AWS_IMAGES_STACK,
	AWS_PLATFORM_PROXY_REPOSITORY,
	AWS_SERVICES_REPOSITORY,
	awsImagesBuildStart,
	awsImagesStack,
	type AwsPlatformImage,
	awsPlatformImageTag,
	awsPlatformManifestKey,
	IMAGES_VARIABLES,
} from '../images'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const MANIFEST = 'a'.repeat(64)
const base = {
	accountId: '123456789012',
	region: 'eu-central-1',
	repository: 'contember/fabrika-platform',
	commitSha: COMMIT,
	token: '0f1e2d3c-4b5a-4968-8776-655443322110',
}

describe("the platform's images", () => {
	const stack = awsImagesStack({ accountId: '123456789012', region: 'eu-central-1' })
	const resources = JSON.parse(JSON.stringify(stack.template)).Resources

	test("two immutable repositories, a build role and project, all under the platform's names", () => {
		expect(stack.stackName).toBe(AWS_IMAGES_STACK)
		expect(resources.ServicesRepository.Properties).toMatchObject({ RepositoryName: AWS_SERVICES_REPOSITORY, ImageTagMutability: 'IMMUTABLE' })
		expect(resources.ProxyRepository.Properties).toMatchObject({ RepositoryName: AWS_PLATFORM_PROXY_REPOSITORY, ImageTagMutability: 'IMMUTABLE' })
		expect(resources.BuildRole.Properties.Path).toBe('/fabrika/platform/')
		expect(resources.BuildProject.Properties).toMatchObject({
			Name: AWS_IMAGES_PROJECT,
			Source: { Type: 'NO_SOURCE', BuildSpec: AWS_IMAGES_BUILDSPEC },
			Environment: { Type: 'LINUX_CONTAINER', PrivilegedMode: true },
		})
		// The build role pushes the platform's two repositories and reads the platform's manifests, nothing of Control's.
		const grants = JSON.stringify(resources.BuildRole.Properties.Policies)
		expect(grants).toContain('repository/fabrika/platform/services')
		expect(grants).toContain('fabrika-sources-123456789012/platform/*')
		expect(grants).not.toContain('/sources/')
		expect(grants).not.toContain('fabrika/apps')
	})

	test("Control's role reaches none of it: not the repositories, the project, the role nor the manifests", () => {
		const control = JSON.stringify(
			awsControlPolicies({
				accountId: '123456789012',
				region: 'eu-central-1',
				appsListenerArn: 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210',
				vpcId: 'vpc-0123456789abcdef0',
				installationHosts: ['iam.example.com'],
			}).flatMap((managed) => managed.statements.filter((statement) => JSON.stringify(statement).includes('"Allow"'))),
		)
		for (const name of ['fabrika/platform', AWS_IMAGES_PROJECT, '/platform/']) expect(control).not.toContain(name)
	})

	test('the buildspec fetches the commit by its full id and checks it before building; every value is a variable', () => {
		const spec = AWS_IMAGES_BUILDSPEC
		expect(spec).toContain(`fetch --quiet --depth 1 "https://github.com/$${IMAGES_VARIABLES.repository}.git" "$${IMAGES_VARIABLES.commit}"`)
		expect(spec.indexOf('rev-parse HEAD')).toBeLessThan(spec.indexOf('docker build'))
		expect(spec).toContain('packages/provider-aws/platform.Dockerfile')
		expect(spec).toContain(`--build-arg ${IMAGES_VARIABLES.trustedProxies} --file /tmp/fabrika-source/packages/proxy/Dockerfile`)
		for (const value of [COMMIT, '123456789012', 'contember']) expect(spec).not.toContain(value)
	})

	test("the services' build: its image tagged by the commit, no manifest, no trusted ranges", () => {
		const start = awsImagesBuildStart({ ...base, image: { kind: 'services' } })
		expect(start.project).toBe(AWS_IMAGES_PROJECT)
		expect(start.variables).toEqual({
			FABRIKA_PLATFORM_REPOSITORY: { value: 'contember/fabrika-platform' },
			FABRIKA_PLATFORM_COMMIT: { value: COMMIT },
			FABRIKA_PLATFORM_IMAGE_KIND: { value: 'services' },
			FABRIKA_IMAGE: { value: `123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/platform/services:${COMMIT}` },
			FABRIKA_REGISTRY: { value: '123456789012.dkr.ecr.eu-central-1.amazonaws.com' },
			FABRIKA_REGISTRY_REGION: { value: 'eu-central-1' },
		})
	})

	test("the proxy's build: tagged by the commit and the manifest, its manifest under the platform's prefix, the balancers' ranges", () => {
		const image: AwsPlatformImage = { kind: 'proxy', manifestSha256: MANIFEST, trustedProxies: '10.80.240.0/24,10.80.241.0/24' }
		const start = awsImagesBuildStart({ ...base, image })
		expect(awsPlatformImageTag(COMMIT, image)).toBe(`${COMMIT.slice(0, 12)}-${MANIFEST.slice(0, 16)}`)
		expect(start.variables).toMatchObject({
			FABRIKA_PLATFORM_IMAGE_KIND: { value: 'proxy' },
			FABRIKA_IMAGE: { value: `123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/platform/proxy:${awsPlatformImageTag(COMMIT, image)}` },
			FABRIKA_PROXY_MANIFEST_OBJECT: { value: `fabrika-sources-123456789012/${awsPlatformManifestKey(COMMIT, MANIFEST)}` },
			FABRIKA_PROXY_TRUSTED_PROXIES: { value: '10.80.240.0/24,10.80.241.0/24' },
		})
		expect(awsPlatformManifestKey(COMMIT, MANIFEST).startsWith('platform/')).toBe(true)
	})

	test('a start of another form is refused before anything is sent', () => {
		const services: AwsPlatformImage = { kind: 'services' }
		expect(() => awsImagesBuildStart({ ...base, commitSha: 'main', image: services })).toThrow('commit')
		expect(() => awsImagesBuildStart({ ...base, repository: 'https://github.com/contember/fabrika-platform', image: services })).toThrow('repository')
		expect(() => awsImagesBuildStart({ ...base, accountId: '1', image: services })).toThrow('account')
		expect(() => awsImagesBuildStart({ ...base, image: { kind: 'proxy', manifestSha256: 'x', trustedProxies: '10.80.240.0/24' } })).toThrow('manifest')
		expect(() => awsImagesBuildStart({ ...base, image: { kind: 'proxy', manifestSha256: MANIFEST, trustedProxies: '10.80.240.0/24; id' } })).toThrow(
			'trusted ranges',
		)
	})
})
