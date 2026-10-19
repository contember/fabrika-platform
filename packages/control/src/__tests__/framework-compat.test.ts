// ADR-0062: this platform deploys an application on an older framework release. The CRM of tag v0.5.4, installed from
// npm (`fixtures/crm-0.5.4.json`: the files v0.5.4's Control read, and its `bun.lock`), goes through Control's read
// path, which picks the bundled 0.5.4 reader and upcasts its artifact. What comes out must be what the 0.5.4 packages
// compute from npm, and what v0.5.4's own Control recorded in the fixture.

import { schemaFromContract as schemaFromContract05 } from '@fabrika/app-0.5/contract'
import { CONTRACT_FORMAT } from '@fabrika/auth-core'
import { contractDigest as contractDigest05 } from '@fabrika/auth-core-0.5'
import { readContractSource as readContractSource05 } from '@fabrika/check-0.5/contract'
import { contractProxyTable as contractProxyTable05 } from '@fabrika/proxy-core-0.5/manifest'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { classifyAccess } from '../approval/diff'
import { readAccessSnapshot } from '../approval/read'
import { approvedAccess, parseSnapshot, serializeSnapshot, snapshotDigest } from '../approval/snapshot'
import { memoryCommits } from './helpers/commits'

const fixture = z.object({
	files: z.record(z.string()),
	platform: z.object({
		stored: z.string(),
		snapshotDigest: z.string(),
		contractDigest: z.string(),
		proxyTable: z.unknown(),
		schema: z.unknown(),
	}).strict(),
}).strict().parse(JSON.parse(readFileSync(new URL('./fixtures/crm-0.5.4.json', import.meta.url), 'utf8')))

/** What the CRM computes at startup on 0.5.4: `contractDigest(compileContract(contract, tables))` over its own modules. */
const STARTUP_DIGEST = 'sha256:88312782b8fe094862492595b599ab4b8e24d439de0b31afe9d6c63d9e536fb2'

const files = new Map(Object.entries(fixture.files))
const read = async () =>
	readAccessSnapshot(
		await memoryCommits(fixture.files).open({ repoUrl: 'github.com/acme/crm', commitSha: 'c'.repeat(40), signal: new AbortController().signal }),
		'',
		'crm',
	)
const artifact05 = readContractSource05(files)

describe('a 0.5.4 application on this platform', () => {
	test('is read by the bundled 0.5.4 reader, which its bun.lock selects', async () => {
		const snapshot = await read()
		expect(snapshot.checker).toBe('0.5.4')
		expect(snapshot.framework).toBe('0.5.4')
		expect(snapshot.older).toEqual(artifact05)
		expect(snapshot.contract?.format).toBe(CONTRACT_FORMAT)
	})

	test('starts with the contract digest its own release computes', async () => {
		const access = approvedAccess(await read())
		expect(access?.contractDigest).toBe(STARTUP_DIGEST)
		expect(access?.contractDigest).toBe(contractDigest05(artifact05))
		expect(access?.contractDigest).toBe(fixture.platform.contractDigest)
		expect(access?.framework).toBe('0.5.4')
	})

	test('gets the proxy rows and the IAM schema the 0.5.4 platform compiles', async () => {
		const access = approvedAccess(await read())
		if (access === undefined) throw new Error('the snapshot has no contract')
		const rows = contractProxyTable(access.contract, access.contractDigest)
		expect(rows).toEqual(contractProxyTable05(artifact05))
		expect(fixture.platform.proxyTable).toEqual(rows)
		expect(access.schema).toEqual(schemaFromContract05(artifact05))
		expect(fixture.platform.schema).toEqual(access.schema)
	})

	test('keeps the snapshot digest v0.5.4 recorded, so the approvals that name it stay valid across the upgrade', async () => {
		const snapshot = await read()
		expect(snapshotDigest(snapshot)).toBe(fixture.platform.snapshotDigest)
		const stored = parseSnapshot(fixture.platform.stored)
		expect(snapshotDigest(stored)).toBe(fixture.platform.snapshotDigest)
		expect(snapshotDigest(parseSnapshot(serializeSnapshot(snapshot)))).toBe(fixture.platform.snapshotDigest)
	})

	test('a snapshot v0.5.4 stored publishes the same access, and its next unchanged deploy changes nothing', async () => {
		const snapshot = await read()
		const stored = parseSnapshot(fixture.platform.stored)
		expect(stored.framework).toBeUndefined()
		expect(approvedAccess(stored)).toEqual(approvedAccess(snapshot))
		expect(classifyAccess(stored, snapshot)).toEqual({ outcome: 'none', changes: [] })
	})

	test('stores the artifact its release read, never the upcast', async () => {
		const snapshot = await read()
		const stored = z.object({ contract: z.record(z.unknown()) }).passthrough().parse(JSON.parse(serializeSnapshot(snapshot)))
		expect(stored.contract).toEqual(JSON.parse(JSON.stringify(artifact05)))
		expect('format' in stored.contract).toBe(false)
		expect(parseSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot)
	})
})
