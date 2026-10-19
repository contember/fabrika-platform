// Files as values in the approval: a file kind adds no authority of its own, so its lines are neutral; the reach of a
// file is the reach of the column that holds it ("`deals.write` writes `deal_attachments.file` (attachments)"); a file
// output names its kind; a scan removed and a larger kind widen.

import type { ContractArtifact } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { snapshotSurface } from '../approval/surface'

const FIXTURE = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'stored-files-fixture')

/** The fixture's contract as Control reads it from a commit: every `.ts` file, by its path in the application. */
const readFixture = (): ContractArtifact => {
	const files = new Map<string, string>()
	for (const entry of readdirSync(FIXTURE, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name)
		if (entry.isFile() && entry.name.endsWith('.ts')) files.set(relative(FIXTURE, path), readFileSync(path, 'utf8'))
	}
	return readContractSource(files)
}

const artifact = readFixture()

const snapshot = (contract: ContractArtifact | null): AccessSnapshot => ({ version: 1, contract, migrations: [], checker: '0.0.0' })

const linesOf = (from: ContractArtifact, to: ContractArtifact) =>
	classifyAccess(snapshot(from), snapshot(to)).changes.map((change) => `${change.effect}: ${change.line}`)

describe('files as values in the approval', () => {
	test('a first contract lists each kind, who writes each file column, and the procedures that answer a file', () => {
		const lines = classifyAccess(snapshot(null), snapshot(artifact)).changes.map((change) => `${change.effect}: ${change.line}`)
		expect(lines).toContain('neutral: New file kind `photos`: `image/png`, at most 262144 bytes, served only after a clean scan')
		expect(lines).toContain('neutral: `deals.write` writes `deal_attachments.file` (attachments)')
		expect(lines).toContain('neutral: `catalog.write` writes `products.image` (catalog)')
		expect(lines.find((line) => line.includes('New endpoint `api.attachments.download`'))).toEndWith(
			'answering a stored file of kind `attachments`',
		)
	})

	test('a larger kind, a kind without its scan and a new type widen; a column that stops holding files does not', () => {
		const photos = artifact.fileKinds?.['photos']
		if (photos === undefined) throw new Error('the fixture declares photos')
		const products = artifact.tables['products']
		if (products === undefined) throw new Error('the fixture declares products')
		const changed: ContractArtifact = {
			...artifact,
			fileKinds: { ...artifact.fileKinds, photos: { types: ['image/png', 'image/jpeg'], maxBytes: 524288 } },
			tables: { ...artifact.tables, products: { ...products, files: {} } },
		}
		expect(linesOf(artifact, changed)).toEqual([
			'widens: File kind `photos` admits `image/jpeg`',
			'widens: File kind `photos` size limit changes from 262144 to 524288',
			'widens: File kind `photos` no longer waits for a scan',
			'neutral: Column `products.image` no longer holds files',
		])
	})

	test('the surface notes a file output and the kinds a procedure takes', () => {
		const surface = snapshotSurface(snapshot(artifact))
		expect(surface.find((endpoint) => endpoint.id === 'api.shop.image')?.notes).toContain('answers a stored file of kind `catalog`')
		expect(surface.find((endpoint) => endpoint.id === 'api.attachments.uploadMany')?.notes).toContain('takes files of kind `attachments`')
	})
})
