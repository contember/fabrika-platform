// ADR-0062: this platform deploys an application on an older framework release. Each fixture holds the files an older
// release's own Control read from an application at its tag, the `bun.lock` a `bun install` of it writes from npm, and
// what that Control recorded: the stored snapshot, its digest, the contract digest, the proxy table and the IAM schema.
// Through this Control's read path, which picks the bundled reader of the application's minor and upcasts its artifact,
// the application must come out as that release's npm packages compute it, and as its own platform recorded it.

import { schemaFromContract as schemaFromContract04 } from '@fabrika/app-0.4/contract'
import { schemaFromContract as schemaFromContract05 } from '@fabrika/app-0.5/contract'
import { schemaFromContract as schemaFromContract06 } from '@fabrika/app-0.6/contract'
import { schemaFromContract as schemaFromContract07 } from '@fabrika/app-0.7/contract'
import { schemaFromContract as schemaFromContract08 } from '@fabrika/app-0.8/contract'
import { CONTRACT_FORMAT } from '@fabrika/auth-core'
import { contractDigest as contractDigest04 } from '@fabrika/auth-core-0.4'
import { contractDigest as contractDigest05 } from '@fabrika/auth-core-0.5'
import { contractDigest as contractDigest06 } from '@fabrika/auth-core-0.6'
import { contractDigest as contractDigest07 } from '@fabrika/auth-core-0.7'
import { contractDigest as contractDigest08 } from '@fabrika/auth-core-0.8'
import { readContractSource as readContractSource04 } from '@fabrika/check-0.4/contract'
import { readContractSource as readContractSource05 } from '@fabrika/check-0.5/contract'
import { readContractSource as readContractSource06 } from '@fabrika/check-0.6/contract'
import { readContractSource as readContractSource07 } from '@fabrika/check-0.7/contract'
import { readContractSource as readContractSource08 } from '@fabrika/check-0.8/contract'
import { contractProxyTable as contractProxyTable04 } from '@fabrika/proxy-core-0.4/manifest'
import { contractProxyTable as contractProxyTable05 } from '@fabrika/proxy-core-0.5/manifest'
import { contractProxyTable as contractProxyTable06 } from '@fabrika/proxy-core-0.6/manifest'
import { contractProxyTable as contractProxyTable07 } from '@fabrika/proxy-core-0.7/manifest'
import { contractProxyTable as contractProxyTable08 } from '@fabrika/proxy-core-0.8/manifest'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { classifyAccess } from '../approval/diff'
import { readAccessSnapshot } from '../approval/read'
import { approvedAccess, parseSnapshot, serializeSnapshot, snapshotDigest } from '../approval/snapshot'
import { memoryCommits } from './helpers/commits'

const fixtureSchema = z.object({
	files: z.record(z.string()),
	platform: z.object({
		stored: z.string(),
		snapshotDigest: z.string(),
		contractDigest: z.string(),
		proxyTable: z.unknown(),
		schema: z.unknown(),
	}).strict(),
}).strict()

/** What the application's own release computes from its files, run from npm. */
interface ReleaseView {
	readonly artifact: unknown
	readonly contractDigest: string
	readonly proxyTable: unknown
	readonly schema: unknown
}

const view04 = (files: ReadonlyMap<string, string>): ReleaseView => {
	const artifact = readContractSource04(files)
	return { artifact, contractDigest: contractDigest04(artifact), proxyTable: contractProxyTable04(artifact), schema: schemaFromContract04(artifact) }
}

const view05 = (files: ReadonlyMap<string, string>): ReleaseView => {
	const artifact = readContractSource05(files)
	return { artifact, contractDigest: contractDigest05(artifact), proxyTable: contractProxyTable05(artifact), schema: schemaFromContract05(artifact) }
}

const view06 = (files: ReadonlyMap<string, string>): ReleaseView => {
	const artifact = readContractSource06(files)
	return { artifact, contractDigest: contractDigest06(artifact), proxyTable: contractProxyTable06(artifact), schema: schemaFromContract06(artifact) }
}

const view07 = (files: ReadonlyMap<string, string>): ReleaseView => {
	const artifact = readContractSource07(files)
	return { artifact, contractDigest: contractDigest07(artifact), proxyTable: contractProxyTable07(artifact), schema: schemaFromContract07(artifact) }
}

const view08 = (files: ReadonlyMap<string, string>): ReleaseView => {
	const artifact = readContractSource08(files)
	return { artifact, contractDigest: contractDigest08(artifact), proxyTable: contractProxyTable08(artifact), schema: schemaFromContract08(artifact) }
}

interface Case {
	readonly name: string
	readonly fixture: string
	readonly app: string
	/** The `@fabrika/app` release its `bun.lock` pins. */
	readonly framework: string
	/** The bundled reader of that minor. */
	readonly checker: string
	/** What the application computes at startup: `contractDigest(compileContract(contract, tables))` over its own modules. */
	readonly startupDigest: string
	readonly view: (files: ReadonlyMap<string, string>) => ReleaseView
	/**
	 * `current`: its artifact is this release's format (0.7's, which 0.8 only extended and 0.9 kept), kept and read as it is, and its
	 * platform recorded the framework release beside the checker. `older`: it carries no format and is upcast.
	 */
	readonly format: 'older' | 'current'
}

const CASES: readonly Case[] = [
	{
		name: 'the CRM at v0.4.8',
		fixture: 'crm-0.4.8.json',
		app: 'crm',
		framework: '0.4.8',
		checker: '0.4.8',
		startupDigest: 'sha256:88312782b8fe094862492595b599ab4b8e24d439de0b31afe9d6c63d9e536fb2',
		view: view04,
		format: 'older',
	},
	{
		name: 'the CRM at v0.5.4, an older patch of the bundled 0.5.5 reader',
		fixture: 'crm-0.5.4.json',
		app: 'crm',
		framework: '0.5.4',
		checker: '0.5.5',
		startupDigest: 'sha256:88312782b8fe094862492595b599ab4b8e24d439de0b31afe9d6c63d9e536fb2',
		view: view05,
		format: 'older',
	},
	{
		name: 'an application with form files at v0.5.5',
		fixture: 'form-files-0.5.5.json',
		app: 'signup',
		framework: '0.5.5',
		checker: '0.5.5',
		startupDigest: 'sha256:b52454f9becd0e2beae741bcea7644f0ff232dd5f4d8178a096228a3809e94d6',
		view: view05,
		format: 'older',
	},
	{
		name: 'a GitHub webhook with its generated binding endpoints, and a job with a timeout, at v0.5.5',
		fixture: 'webhooks-0.5.5.json',
		app: 'hooks',
		framework: '0.5.5',
		checker: '0.5.5',
		startupDigest: 'sha256:e2afd0f3d3f482ad8100f5cc92b550085932349564d2319bcf55b8a3cdaef267',
		view: view05,
		format: 'older',
	},
	{
		name: 'the CRM at v0.6.0, read by the 0.6 reader although its framework sources are those of 0.5.5',
		fixture: 'crm-0.6.0.json',
		app: 'crm',
		framework: '0.6.0',
		checker: '0.6.0',
		startupDigest: 'sha256:88312782b8fe094862492595b599ab4b8e24d439de0b31afe9d6c63d9e536fb2',
		view: view06,
		format: 'older',
	},
	{
		name: "the CRM at v0.7.0, whose artifact is this release's format",
		fixture: 'crm-0.7.0.json',
		app: 'crm',
		framework: '0.7.0',
		checker: '0.7.0',
		startupDigest: 'sha256:60cc6dd14474d3bb2c38af5861660add9316939b0a8eb5e54d05a3a93a856639',
		view: view07,
		format: 'current',
	},
	{
		name: 'the CRM at v0.8.1, an older patch of the bundled 0.8.2 reader',
		fixture: 'crm-0.8.1.json',
		app: 'crm',
		framework: '0.8.1',
		checker: '0.8.2',
		startupDigest: 'sha256:60cc6dd14474d3bb2c38af5861660add9316939b0a8eb5e54d05a3a93a856639',
		view: view08,
		format: 'current',
	},
	{
		name: "the CRM at v0.8.2, whose artifact is this release's format",
		fixture: 'crm-0.8.2.json',
		app: 'crm',
		framework: '0.8.2',
		checker: '0.8.2',
		startupDigest: 'sha256:60cc6dd14474d3bb2c38af5861660add9316939b0a8eb5e54d05a3a93a856639',
		view: view08,
		format: 'current',
	},
]

for (const release of CASES) {
	const fixture = fixtureSchema.parse(JSON.parse(readFileSync(new URL(`./fixtures/${release.fixture}`, import.meta.url), 'utf8')))
	const live = release.view(new Map(Object.entries(fixture.files)))
	const read = async () =>
		readAccessSnapshot(
			await memoryCommits(fixture.files).open({ repoUrl: 'github.com/acme/app', commitSha: 'c'.repeat(40), signal: new AbortController().signal }),
			'',
			release.app,
		)

	describe(`${release.name} on this platform`, () => {
		test.skipIf(release.format === 'current')("upcasts its jobs' and webhooks' time limits to what its release ran with", async () => {
			const contract = (await read()).contract
			if (contract === null) throw new Error('the snapshot has no contract')
			const older = z.object({ jobs: z.record(z.object({ timeout: z.string().nullable() }).passthrough()) }).passthrough().parse(live.artifact)
			for (const [name, job] of Object.entries(contract.jobs)) {
				const timeout = older.jobs[name]?.timeout ?? null
				const minutes = timeout === null ? 15 : timeout.endsWith('m') ? Number(timeout.slice(0, -1)) : Number.NaN
				expect([name, job.timeoutMs]).toEqual([name, minutes * 60_000])
			}
			for (const mount of Object.values(contract.mounts)) {
				if (mount.kind === 'webhook') expect(mount.timeoutMs).toBe(10_000)
			}
		})

		test('is read by the bundled reader of its minor, which its bun.lock selects', async () => {
			const snapshot = await read()
			expect(snapshot.checker).toBe(release.checker)
			expect(snapshot.framework).toBe(release.framework)
			expect(live.artifact).toEqual(release.format === 'current' ? snapshot.contract : snapshot.older)
			if (release.format === 'current') expect(snapshot.older).toBeUndefined()
			expect(snapshot.contract?.format).toBe(CONTRACT_FORMAT)
		})

		test('starts with the contract digest its own release computes, and builds with the reader release', async () => {
			const access = approvedAccess(await read())
			expect(access?.contractDigest).toBe(release.startupDigest)
			expect(access?.contractDigest).toBe(live.contractDigest)
			expect(access?.contractDigest).toBe(fixture.platform.contractDigest)
			expect(access?.checker).toBe(release.checker)
			// The provider's release gates read the pin, which a prerelease keeps below the newer reader.
			expect(access?.framework).toBe(release.framework)
		})

		test('gets the proxy rows and the IAM schema its own platform compiles', async () => {
			const access = approvedAccess(await read())
			if (access === undefined) throw new Error('the snapshot has no contract')
			const rows = contractProxyTable(access.contract, access.contractDigest)
			expect(live.proxyTable).toEqual(rows)
			expect(fixture.platform.proxyTable).toEqual(rows)
			expect(live.schema).toEqual(access.schema)
			expect(fixture.platform.schema).toEqual(access.schema)
		})

		test('keeps the snapshot digest its platform recorded, so the approvals that name it stay valid across the upgrade', async () => {
			const snapshot = await read()
			expect(snapshotDigest(snapshot)).toBe(fixture.platform.snapshotDigest)
			expect(snapshotDigest(parseSnapshot(fixture.platform.stored))).toBe(fixture.platform.snapshotDigest)
			expect(snapshotDigest(parseSnapshot(serializeSnapshot(snapshot)))).toBe(fixture.platform.snapshotDigest)
		})

		test('a snapshot its platform stored publishes the same contract, and its next unchanged deploy changes nothing', async () => {
			const snapshot = await read()
			const stored = parseSnapshot(fixture.platform.stored)
			// A 0.7 Control records the framework release beside the checker; an older one recorded neither.
			expect(stored.framework).toBe(release.format === 'current' ? release.framework : undefined)
			expect(approvedAccess(stored)?.contract).toEqual(approvedAccess(snapshot)?.contract)
			expect(approvedAccess(stored)?.contractDigest).toBe(release.startupDigest)
			expect(approvedAccess(stored)?.framework).toBe(stored.framework)
			expect(classifyAccess(stored, snapshot)).toEqual({ outcome: 'none', changes: [] })
		})

		test('stores the artifact its release read, never the upcast', async () => {
			const snapshot = await read()
			const stored = z.object({ contract: z.record(z.unknown()) }).passthrough().parse(JSON.parse(serializeSnapshot(snapshot)))
			expect(stored.contract).toEqual(JSON.parse(JSON.stringify(live.artifact)))
			expect('format' in stored.contract).toBe(release.format === 'current')
			expect(parseSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot)
		})
	})
}
