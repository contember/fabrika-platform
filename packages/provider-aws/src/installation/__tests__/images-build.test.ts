// The release's two images over a fake CodeBuild, ECR and sources bucket: an image its tag already holds is read, not
// built; the proxy's manifest is written before its build; a build an earlier run started is followed, not doubled; a
// build that ends without its image is started again once; the answer is each image's digest.

import { describe, expect, test } from 'bun:test'
import type { CodeBuildBuild, CodeBuildStart, CodeBuildStatus } from '../../aws/codebuild'
import { AwsError } from '../../aws/transport'
import { AWS_PLATFORM_PROXY_REPOSITORY, AWS_SERVICES_REPOSITORY, IMAGES_VARIABLES } from '../images'
import { awsImageBuildToken, type AwsImagesBuildRun, buildAwsPlatformImages } from '../images-build'
import { awsPlatformManifest } from '../platform-manifest'
import { platformState } from './platform-fixture'

const COMMIT = 'c'.repeat(40)
const manifest = awsPlatformManifest(platformState().plan, { mcp: false })
const SERVICES_TAG = COMMIT
const PROXY_TAG = `${COMMIT.slice(0, 12)}-${manifest.sha256.slice(0, 16)}`

interface FakeAccountState {
	/** What each started build ends as, in order of starts; `succeeded` past the list. */
	endings: CodeBuildStatus[]
	/** Whether a build that succeeds pushes its image. */
	pushes: boolean
	/** How many build reads to refuse for rate before answering. */
	throttled: number
}

/** One account's images and builds in memory: a build that succeeds pushes its image unless `pushes` says otherwise. */
function fakeAccount() {
	const images = new Map<string, string>()
	const builds = new Map<string, { build: CodeBuildBuild; start: CodeBuildStart; repository: string; tag: string }>()
	const events: string[] = []
	const state: FakeAccountState = { endings: [], pushes: true, throttled: 0 }
	const imageOf = (start: CodeBuildStart) => {
		const variable = start.variables[IMAGES_VARIABLES.image]
		const value = variable !== undefined && 'value' in variable ? variable.value : ''
		const [path = '', tag = ''] = value.split(':')
		return { repository: path.slice(path.indexOf('/') + 1), tag }
	}
	const run: Pick<AwsImagesBuildRun, 'codeBuild' | 'ecr' | 'manifestWriter'> = {
		ecr: {
			findImage: async (repository, reference) => {
				const digest = 'tag' in reference ? images.get(`${repository}:${reference.tag}`) : undefined
				return digest === undefined ? null : { digest, tags: [], pushedAt: new Date() }
			},
		},
		codeBuild: {
			startBuild: async (start) => {
				const id = `fabrika-platform-images:${String(builds.size).padStart(8, '0')}-0000-4000-8000-000000000000`
				const build: CodeBuildBuild = { id, status: 'in_progress', phase: null, log: { group: '/fabrika/platform/images', stream: id } }
				builds.set(id, { build, start, ...imageOf(start) })
				events.push(`start ${imageOf(start).repository}`)
				return build
			},
			findBuild: async (_project, token) => [...builds.values()].find((entry) => entry.start.token === token)?.build ?? null,
			getBuild: async (id) => {
				if (state.throttled > 0) {
					state.throttled -= 1
					throw new AwsError('BatchGetBuilds', 'ThrottlingException', 400, null, true)
				}
				const entry = builds.get(id)
				if (entry === undefined) return null
				const index = [...builds.keys()].indexOf(id)
				const status = state.endings[index] ?? 'succeeded'
				if (status === 'succeeded' && state.pushes) images.set(`${entry.repository}:${entry.tag}`, `sha256:${String(index).repeat(64).slice(0, 64)}`)
				const ended: CodeBuildBuild = { ...entry.build, status }
				builds.set(id, { ...entry, build: ended })
				return ended
			},
		},
		manifestWriter: (key) => ({
			complete: async (upload) => {
				events.push(`manifest ${key} ${upload.bytes}`)
			},
		}),
	}
	return { images, builds, events, state, run }
}

function input(account: ReturnType<typeof fakeAccount>, lines: string[] = []): AwsImagesBuildRun {
	return {
		state: platformState(),
		release: { repository: 'contember/fabrika-platform', commitSha: COMMIT },
		manifest,
		...account.run,
		signal: new AbortController().signal,
		sleep: async () => {},
		log: (line) => lines.push(line),
	}
}

describe("the release's two images", () => {
	test('a release whose images are built builds nothing and writes nothing', async () => {
		const account = fakeAccount()
		account.images.set(`${AWS_SERVICES_REPOSITORY}:${SERVICES_TAG}`, `sha256:${'1'.repeat(64)}`)
		account.images.set(`${AWS_PLATFORM_PROXY_REPOSITORY}:${PROXY_TAG}`, `sha256:${'2'.repeat(64)}`)
		expect(await buildAwsPlatformImages(input(account))).toEqual({ services: `sha256:${'1'.repeat(64)}`, proxy: `sha256:${'2'.repeat(64)}` })
		expect(account.events).toEqual([])
	})

	test("a new release writes the proxy's manifest, then builds both, each by its tag's own token", async () => {
		const account = fakeAccount()
		const images = await buildAwsPlatformImages(input(account))
		expect(account.events[0]).toBe(
			`manifest platform/${COMMIT}/${manifest.sha256}/proxy.manifest.json ${new TextEncoder().encode(manifest.json).byteLength}`,
		)
		expect(account.events.slice(1).sort()).toEqual([`start ${AWS_PLATFORM_PROXY_REPOSITORY}`, `start ${AWS_SERVICES_REPOSITORY}`])
		expect(images.services).toBe(account.images.get(`${AWS_SERVICES_REPOSITORY}:${SERVICES_TAG}`) ?? 'no services image')
		expect(images.proxy).toBe(account.images.get(`${AWS_PLATFORM_PROXY_REPOSITORY}:${PROXY_TAG}`) ?? 'no proxy image')
		const tokens = [...account.builds.values()].map((entry) => entry.start.token).sort()
		expect(tokens).toEqual([awsImageBuildToken(PROXY_TAG, 'proxy'), awsImageBuildToken(SERVICES_TAG, 'services')].sort())
		// The proxy's build trusts the platform balancer's subnets alone.
		const proxyBuild = [...account.builds.values()].find((entry) => entry.repository === AWS_PLATFORM_PROXY_REPOSITORY)
		expect(proxyBuild?.start.variables[IMAGES_VARIABLES.trustedProxies]).toEqual({ value: '10.81.240.0/24,10.81.241.0/24' })
	})

	test('a build an earlier run started is followed, not started again; a throttled read is read again', async () => {
		const account = fakeAccount()
		await account.run.codeBuild.startBuild({
			project: 'fabrika-platform-images',
			token: awsImageBuildToken(SERVICES_TAG, 'services'),
			buildspec: 'version: 0.2',
			variables: { [IMAGES_VARIABLES.image]: { value: `123456789012.dkr.ecr.eu-central-1.amazonaws.com/${AWS_SERVICES_REPOSITORY}:${SERVICES_TAG}` } },
			timeoutMinutes: 30,
			queuedTimeoutMinutes: 60,
		})
		account.events.length = 0
		account.state.throttled = 1
		const lines: string[] = []
		await buildAwsPlatformImages(input(account, lines))
		expect(account.events.filter((event) => event.startsWith('start '))).toEqual([`start ${AWS_PLATFORM_PROXY_REPOSITORY}`])
		expect(lines.some((line) => line.startsWith("aws: following the services image's build"))).toBe(true)
	})

	test('a build that ends without its image is started once more; a second failure stops the run, naming its log', async () => {
		const once = fakeAccount()
		once.state.endings = ['failed', 'succeeded', 'succeeded']
		const images = await buildAwsPlatformImages(input(once))
		expect(images.services.startsWith('sha256:')).toBe(true)
		expect(once.builds.size).toBe(3)
		const twice = fakeAccount()
		twice.state.pushes = false
		await expect(buildAwsPlatformImages(input(twice))).rejects.toThrow('ended succeeded without the image; the log /fabrika/platform/images')
	})

	test('a manifest whose bytes are not the ones its digest names is refused before anything is sent', async () => {
		const account = fakeAccount()
		await expect(buildAwsPlatformImages({ ...input(account), manifest: { json: manifest.json, sha256: 'f'.repeat(64) } })).rejects.toThrow(
			'not the one its digest names',
		)
		expect(account.events).toEqual([])
	})
})
