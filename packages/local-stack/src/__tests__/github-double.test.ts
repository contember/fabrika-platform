import { GitHubAppClient } from '@fabrika/github-app'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHubDouble, type GitHubDouble, localGitHubDoubleApps } from '../github-double'
import { LOCAL_SOURCE_APPLICATION_REPOSITORY, LOCAL_SOURCE_PLATFORM_REPOSITORY, type LocalSourceFixture } from '../local-source-contract'
import { createFixtureTransports } from '../local-source-transports'
import { ensureLocalGitHubApps, LOCAL_SOURCE_CONNECTIONS, localGitHubAppKey, type LocalGitHubApps } from '../source-connection-fixture'

const [ALPHA, BETA] = LOCAL_SOURCE_CONNECTIONS
if (ALPHA === undefined || BETA === undefined) throw new Error('the local source connection fixture needs two connections')

const FIXTURE: LocalSourceFixture = {
	commitSha: 'a'.repeat(40),
	treeSha: 'b'.repeat(40),
	tree: [],
	descriptorContents: 'zerops: []\n',
	descriptorSha256: 'c'.repeat(64),
	archiveBytes: 4,
	archiveSha256: 'd'.repeat(64),
}
const API = 'https://api.github.com'
const APPLICATION = `${API}/repos/${LOCAL_SOURCE_APPLICATION_REPOSITORY.owner}/${LOCAL_SOURCE_APPLICATION_REPOSITORY.name}`
const CODELOAD =
	`https://codeload.github.com/${LOCAL_SOURCE_APPLICATION_REPOSITORY.owner}/${LOCAL_SOURCE_APPLICATION_REPOSITORY.name}/legacy.tar.gz/${FIXTURE.commitSha}`

let directory: string
let apps: LocalGitHubApps

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'fabrika-github-double-'))
	apps = await ensureLocalGitHubApps(directory)
})

afterAll(async () => {
	await rm(directory, { recursive: true, force: true })
})

const double = (now?: () => number): Promise<GitHubDouble> =>
	createGitHubDouble({
		apps: localGitHubDoubleApps(apps),
		privateRepositories: [LOCAL_SOURCE_APPLICATION_REPOSITORY],
		...(now === undefined ? {} : { now }),
	})

/** The production client, signing with `privateKeyPem` while claiming to be `appId`. */
const client = (github: GitHubDouble, appId: string, privateKeyPem: string): Promise<GitHubAppClient> =>
	GitHubAppClient.create({ appId, privateKeyPem, fetch: github.appFetch })

const mint = async (github: GitHubDouble, repository = LOCAL_SOURCE_APPLICATION_REPOSITORY.name, installationId = ALPHA.installationId) =>
	(await client(github, ALPHA.githubAppId, localGitHubAppKey(apps, ALPHA.connectionId))).mintRepositoryToken({
		installationId,
		owner: LOCAL_SOURCE_APPLICATION_REPOSITORY.owner,
		repository,
	})

describe('the GitHub App double', () => {
	test('refuses a JWT signed by another App key, an expired JWT, a foreign installation and an unowned repository', async () => {
		const github = await double()
		const impostor = await client(github, ALPHA.githubAppId, localGitHubAppKey(apps, BETA.connectionId))
		await expect(impostor.mintRepositoryToken({
			installationId: ALPHA.installationId,
			owner: LOCAL_SOURCE_APPLICATION_REPOSITORY.owner,
			repository: LOCAL_SOURCE_APPLICATION_REPOSITORY.name,
		})).rejects.toThrow('status 401')
		const later = await double(() => Date.now() + 11 * 60 * 1000)
		await expect(mint(later)).rejects.toThrow('status 401')
		await expect(mint(github, LOCAL_SOURCE_APPLICATION_REPOSITORY.name, BETA.installationId)).rejects.toThrow('status 404')
		await expect(mint(github, LOCAL_SOURCE_PLATFORM_REPOSITORY.name)).rejects.toThrow('status 422')
		const other = await github.appFetch(`${API}/app/installations/${ALPHA.installationId}`, { method: 'GET' })
		expect(other.status).toBe(404)
	})

	test("mints a token for the App's own installation, scoped to the one repository it names", async () => {
		const github = await double()
		const { token } = await mint(github)
		expect(github.canRead(`Bearer ${token}`, LOCAL_SOURCE_APPLICATION_REPOSITORY)).toBe(true)
		expect(github.canRead(token, LOCAL_SOURCE_APPLICATION_REPOSITORY)).toBe(false)
		expect(github.canRead(`Bearer ${token}`, LOCAL_SOURCE_PLATFORM_REPOSITORY)).toBe(false)
		expect(github.canRead(`Bearer ${token}`, { owner: BETA.owner, name: LOCAL_SOURCE_APPLICATION_REPOSITORY.name })).toBe(false)
		expect(github.canRead('Bearer ghs_unminted', LOCAL_SOURCE_APPLICATION_REPOSITORY)).toBe(false)
	})
})

describe('a private fixture repository behind the double', () => {
	const transports = async () => {
		const github = await double()
		return {
			github,
			...createFixtureTransports([{
				repository: LOCAL_SOURCE_APPLICATION_REPOSITORY,
				fixture: FIXTURE,
				archive: new Blob([new Uint8Array([1, 2, 3, 4])]),
				visibility: 'private',
			}], { access: github }),
		}
	}
	const withToken = (token: string | undefined): RequestInit => token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }

	test('is invisible without a token scoped to it, as GitHub answers 404 rather than 403', async () => {
		const { metadataFetch, downloadFetch } = await transports()
		expect((await metadataFetch(`${APPLICATION}/commits/${FIXTURE.commitSha}`, withToken(undefined))).status).toBe(404)
		expect((await metadataFetch(`${APPLICATION}/commits/${FIXTURE.commitSha}`, withToken('ghs_unminted'))).status).toBe(404)
		expect((await downloadFetch(`${APPLICATION}/tarball/${FIXTURE.commitSha}`, { redirect: 'manual' })).status).toBe(404)
		expect((await downloadFetch(CODELOAD, { redirect: 'manual' })).status).toBe(404)
		expect(() =>
			createFixtureTransports([{ repository: LOCAL_SOURCE_APPLICATION_REPOSITORY, fixture: FIXTURE, archive: new Blob(), visibility: 'private' }])
		)
			.toThrow('needs an access check')
	})

	test("refuses one repository's codeload grant for another repository or commit", async () => {
		const second = { owner: LOCAL_SOURCE_APPLICATION_REPOSITORY.owner, name: 'second-fixture' }
		const secondFixture = { ...FIXTURE, commitSha: 'e'.repeat(40) }
		const github = await createGitHubDouble({ apps: localGitHubDoubleApps(apps), privateRepositories: [LOCAL_SOURCE_APPLICATION_REPOSITORY, second] })
		const { downloadFetch } = createFixtureTransports([
			{ repository: LOCAL_SOURCE_APPLICATION_REPOSITORY, fixture: FIXTURE, archive: new Blob([new Uint8Array([1])]), visibility: 'private' },
			{ repository: second, fixture: secondFixture, archive: new Blob([new Uint8Array([2])]), visibility: 'private' },
		], { access: github })
		const { token } = await mint(github)
		const redirect = await downloadFetch(`${APPLICATION}/tarball/${FIXTURE.commitSha}`, { redirect: 'manual', ...withToken(token) })
		const grant = new URL(redirect.headers.get('location') ?? '').searchParams.get('token')
		const secondCodeload = `https://codeload.github.com/${second.owner}/${second.name}/legacy.tar.gz/${secondFixture.commitSha}`
		expect((await downloadFetch(`${secondCodeload}?token=${grant}`, { redirect: 'manual' })).status).toBe(404)
		const otherCommit =
			`https://codeload.github.com/${second.owner}/${LOCAL_SOURCE_APPLICATION_REPOSITORY.name}/legacy.tar.gz/${secondFixture.commitSha}`
		expect((await downloadFetch(`${otherCommit}?token=${grant}`, { redirect: 'manual' })).status).toBe(404)
		const own = await downloadFetch(`${CODELOAD}?token=${grant}`, { redirect: 'manual' })
		expect(new Uint8Array(await own.arrayBuffer())).toEqual(new Uint8Array([1]))
	})

	test('serves the branch, the commit and a one-time codeload grant to a scoped installation token', async () => {
		const { github, metadataFetch, downloadFetch } = await transports()
		const { token } = await mint(github)
		const branch = await metadataFetch(`${APPLICATION}/commits/${encodeURIComponent('refs/heads/main')}`, withToken(token))
		expect(await branch.json()).toMatchObject({ sha: FIXTURE.commitSha })
		const redirect = await downloadFetch(`${APPLICATION}/tarball/${FIXTURE.commitSha}`, { redirect: 'manual', ...withToken(token) })
		expect(redirect.status).toBe(302)
		const location = redirect.headers.get('location') ?? ''
		expect(location.startsWith(`${CODELOAD}?token=`)).toBe(true)
		// Codeload never takes the installation token, and its grant is spent by one download.
		expect((await downloadFetch(location, { redirect: 'manual', ...withToken(token) })).status).toBe(404)
		const archive = await downloadFetch(location, { redirect: 'manual' })
		expect(new Uint8Array(await archive.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
		expect((await downloadFetch(location, { redirect: 'manual' })).status).toBe(404)
	})

	test('answers the branch with the commit a push moved it to, and every pinned commit by its sha', async () => {
		const github = await double()
		const next: LocalSourceFixture = { ...FIXTURE, commitSha: 'e'.repeat(40), treeSha: 'f'.repeat(40) }
		let head: string | undefined
		const { metadataFetch } = createFixtureTransports(
			[FIXTURE, next].map((fixture) => ({
				repository: LOCAL_SOURCE_APPLICATION_REPOSITORY,
				fixture,
				archive: new Blob([new Uint8Array([1])]),
				visibility: 'private' as const,
			})),
			{ access: github, branchHead: () => head },
		)
		const { token } = await mint(github)
		const branch = async () => (await metadataFetch(`${APPLICATION}/commits/${encodeURIComponent('refs/heads/main')}`, withToken(token))).json()
		expect(await branch()).toMatchObject({ sha: FIXTURE.commitSha })
		head = next.commitSha
		expect(await branch()).toMatchObject({ sha: next.commitSha })
		expect(await (await metadataFetch(`${APPLICATION}/commits/${FIXTURE.commitSha}`, withToken(token))).json()).toMatchObject({
			sha: FIXTURE.commitSha,
		})
		head = 'a0'.repeat(20)
		expect((await metadataFetch(`${APPLICATION}/commits/main`, withToken(token))).status).toBe(404)
	})
})
