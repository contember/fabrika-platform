// The release's two images over a fake CodeBuild, ECR and sources bucket: an image its tag already holds is read, not
// built; the proxy's manifest is written before its build; a build an earlier run started is found by its image and
// followed; a start after a failure is a new build, never the failed one answered again; the image is read after every
// build, whatever its status; the first image to fail stops the other; the answer is each image's digest.

import { describe, expect, test } from 'bun:test'
import type { CodeBuildBuild, CodeBuildStart, CodeBuildStatus } from '../../aws/codebuild'
import { AwsError } from '../../aws/transport'
import { AWS_PLATFORM_PROXY_REPOSITORY, AWS_SERVICES_REPOSITORY, awsPlatformImageTag, IMAGES_VARIABLES } from '../images'
import { type AwsImagesBuildRun, buildAwsPlatformImages } from '../images-build'
import { awsPlatformManifest } from '../platform-manifest'
import { platformState } from './platform-fixture'

const COMMIT = 'c'.repeat(40)
const REGISTRY = '123456789012.dkr.ecr.eu-central-1.amazonaws.com'
const manifest = awsPlatformManifest(platformState().plan, { mcp: false })
const SERVICES_TAG = COMMIT
const PROXY_TAG = awsPlatformImageTag(COMMIT, { kind: 'proxy', manifestSha256: manifest.sha256, trustedProxies: '10.81.240.0/24,10.81.241.0/24' })

interface FakeAccountState {
	/** What each started build ends as, in order of starts; `succeeded` past the list. */
	endings: CodeBuildStatus[]
	/** Whether a build that succeeds pushes its image. */
	pushes: boolean
	/** The repositories whose image another build pushes while this one fails. */
	pushedMeanwhile: Set<string>
	/** The repositories whose builds never end. */
	stuck: Set<string>
	/** How many build reads to refuse for rate before answering. */
	throttled: number
	/** How many build reads were answered. */
	reads: number
}

/** One account's images and builds in memory. A repeated token answers the build it started, as CodeBuild does. */
function fakeAccount() {
	const images = new Map<string, string>()
	const builds = new Map<string, { build: CodeBuildBuild; start: CodeBuildStart; repository: string; tag: string }>()
	const events: string[] = []
	const state: FakeAccountState = { endings: [], pushes: true, pushedMeanwhile: new Set(), stuck: new Set(), throttled: 0, reads: 0 }
	const imageOf = (start: CodeBuildStart) => {
		const variable = start.variables[IMAGES_VARIABLES.image]
		const value = variable !== undefined && 'value' in variable ? variable.value : ''
		const [path = '', tag = ''] = value.split(':')
		return { repository: path.slice(path.indexOf('/') + 1), tag, value }
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
				const repeated = [...builds.values()].find((entry) => entry.start.token === start.token)
				if (repeated !== undefined) return repeated.build
				const id = `fabrika-platform-images:${String(builds.size).padStart(8, '0')}-0000-4000-8000-000000000000`
				const build: CodeBuildBuild = { id, status: 'in_progress', phase: null, log: { group: '/fabrika/platform/images', stream: id } }
				const { repository, tag } = imageOf(start)
				builds.set(id, { build, start, repository, tag })
				events.push(`start ${repository}`)
				return build
			},
			findBuildsWith: async (_project, name, value) =>
				[...builds.values()].reverse().filter((entry) => {
					const variable = entry.start.variables[name]
					return variable !== undefined && 'value' in variable && variable.value === value
				}).map((entry) => entry.build),
			getBuild: async (id) => {
				if (state.throttled > 0) {
					state.throttled -= 1
					throw new AwsError('BatchGetBuilds', 'ThrottlingException', 400, null, true)
				}
				state.reads += 1
				const entry = builds.get(id)
				if (entry === undefined) return null
				if (state.stuck.has(entry.repository)) return entry.build
				const index = [...builds.keys()].indexOf(id)
				const status = state.endings[index] ?? 'succeeded'
				const digest = `sha256:${String(index).repeat(64).slice(0, 64)}`
				if ((status === 'succeeded' && state.pushes) || state.pushedMeanwhile.has(entry.repository)) {
					images.set(`${entry.repository}:${entry.tag}`, digest)
				}
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

const startsOf = (account: ReturnType<typeof fakeAccount>) => account.events.filter((event) => event.startsWith('start '))

describe("the release's two images", () => {
	test('a release whose images are built builds nothing and writes nothing', async () => {
		const account = fakeAccount()
		account.images.set(`${AWS_SERVICES_REPOSITORY}:${SERVICES_TAG}`, `sha256:${'1'.repeat(64)}`)
		account.images.set(`${AWS_PLATFORM_PROXY_REPOSITORY}:${PROXY_TAG}`, `sha256:${'2'.repeat(64)}`)
		expect(await buildAwsPlatformImages(input(account))).toEqual({ services: `sha256:${'1'.repeat(64)}`, proxy: `sha256:${'2'.repeat(64)}` })
		expect(account.events).toEqual([])
	})

	test("a new release writes the proxy's manifest, then builds both, each start a token of its own", async () => {
		const account = fakeAccount()
		const images = await buildAwsPlatformImages(input(account))
		expect(account.events[0]).toBe(
			`manifest platform/${COMMIT}/${manifest.sha256}/proxy.manifest.json ${new TextEncoder().encode(manifest.json).byteLength}`,
		)
		expect(startsOf(account).sort()).toEqual([`start ${AWS_PLATFORM_PROXY_REPOSITORY}`, `start ${AWS_SERVICES_REPOSITORY}`])
		expect(images.services).toBe(account.images.get(`${AWS_SERVICES_REPOSITORY}:${SERVICES_TAG}`) ?? 'no services image')
		expect(images.proxy).toBe(account.images.get(`${AWS_PLATFORM_PROXY_REPOSITORY}:${PROXY_TAG}`) ?? 'no proxy image')
		const tokens = [...account.builds.values()].map((entry) => entry.start.token)
		expect(new Set(tokens).size).toBe(tokens.length)
		// The proxy's build trusts the platform balancer's subnets alone, which its tag carries too.
		const proxyBuild = [...account.builds.values()].find((entry) => entry.repository === AWS_PLATFORM_PROXY_REPOSITORY)
		expect(proxyBuild?.start.variables[IMAGES_VARIABLES.trustedProxies]).toEqual({ value: '10.81.240.0/24,10.81.241.0/24' })
		expect(proxyBuild?.tag).toBe(PROXY_TAG)
	})

	test('a build an earlier run started is found by its image and followed; a throttled read is read again', async () => {
		const account = fakeAccount()
		await account.run.codeBuild.startBuild({
			project: 'fabrika-platform-images',
			token: '00000000-0000-4000-8000-000000000001',
			buildspec: 'version: 0.2',
			variables: { [IMAGES_VARIABLES.image]: { value: `${REGISTRY}/${AWS_SERVICES_REPOSITORY}:${SERVICES_TAG}` } },
			timeoutMinutes: 30,
			queuedTimeoutMinutes: 60,
		})
		account.events.length = 0
		account.state.throttled = 1
		const lines: string[] = []
		await buildAwsPlatformImages(input(account, lines))
		expect(startsOf(account)).toEqual([`start ${AWS_PLATFORM_PROXY_REPOSITORY}`])
		expect(lines.some((line) => line.startsWith("aws: following the services image's build"))).toBe(true)
	})

	test('a start after a fast failure is a new build, never the failed one answered again', async () => {
		const account = fakeAccount()
		account.state.endings = ['failed']
		const images = await buildAwsPlatformImages(input(account))
		expect(images.services.startsWith('sha256:')).toBe(true)
		expect(account.builds.size).toBe(3)
		const failed = [...account.builds.values()][0]
		const again = [...account.builds.values()].filter((entry) => entry.repository === failed?.repository)
		expect(again.map((entry) => entry.build.status)).toEqual(['failed', 'succeeded'])
		expect(again[0]?.start.token).not.toBe(again[1]?.start.token)
	})

	test('a build that failed because another pushed the tag first still answers the image', async () => {
		const account = fakeAccount()
		account.state.endings = ['failed', 'failed']
		account.state.pushedMeanwhile = new Set([AWS_SERVICES_REPOSITORY, AWS_PLATFORM_PROXY_REPOSITORY])
		const images = await buildAwsPlatformImages(input(account))
		expect(images.services.startsWith('sha256:')).toBe(true)
		expect(images.proxy.startsWith('sha256:')).toBe(true)
		expect(account.builds.size).toBe(2)
	})

	test('two builds without the image stop the run, naming the log; the other image stops waiting', async () => {
		const account = fakeAccount()
		account.state.pushes = false
		account.state.stuck = new Set([AWS_PLATFORM_PROXY_REPOSITORY])
		await expect(buildAwsPlatformImages(input(account))).rejects.toThrow('ended succeeded without the image; the log /fabrika/platform/images')
		// Two starts of the services' image, and nothing more of the proxy's once the run failed.
		expect(startsOf(account).filter((event) => event === `start ${AWS_SERVICES_REPOSITORY}`)).toHaveLength(2)
		const after = account.state.reads
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(account.state.reads).toBe(after)
	})

	test('a manifest whose bytes are not the ones its digest names is refused before anything is sent', async () => {
		const account = fakeAccount()
		await expect(buildAwsPlatformImages({ ...input(account), manifest: { json: manifest.json, sha256: 'f'.repeat(64) } })).rejects.toThrow(
			'not the one its digest names',
		)
		expect(account.events).toEqual([])
	})
})
