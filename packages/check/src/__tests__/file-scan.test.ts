// `scan: true` in the static reader and the checker: the reader reads the literal into the artifact the runtime
// compiles, and an existing collection that turns scanning on is told the migration its table needs.

import { compileContract } from '@fabrika/app/contract'
import { fileScanSql, fileTableSql } from '@fabrika/db'
import { describe, expect, test } from 'bun:test'
import { readContract, readContractSource } from '../contract'
import { check, CLEAN_APPLICATION, CLEAN_CONTRACT, locations } from './helpers'

const collection = (options: string): string =>
	`\tfiles: { attachments: c.files({ owner: 'notes', read: 'notes.read', write: 'notes.write', delete: 'notes.write', maxBytes: 1024, types: ['text/plain']${options} }) },\n`

const withFiles = (options: string): string => {
	const anchor = "\thealth: c.health('/healthz'),\n"
	if (!CLEAN_CONTRACT.includes(anchor)) throw new Error('the clean contract has no health mount')
	return CLEAN_CONTRACT.replace(anchor, `${collection(options)}${anchor}`)
}

const OWNER = { table: 'notes', key: { column: 'id', type: 'text' }, chain: [{ column: 'workspace_id', type: 'text' }] } as const
/** The DDL an earlier `fileTableSql` wrote: an unnamed check of two states. */
const EARLIER_DDL = fileTableSql('attachments', OWNER)
	.replace(/CONSTRAINT \S+ CHECK \(status IN \([^)]*\)\)/, "CHECK (status IN ('pending', 'live'))")
	.replace(/^CREATE INDEX \S+_scan .*$/m, '')

const application = (options: string, migrations: Readonly<Record<string, string>>): Record<string, string> => ({
	...CLEAN_APPLICATION,
	'fabrika.contract.ts': withFiles(options),
	...migrations,
})

describe('the reader', () => {
	test('reads scan: true into the artifact the runtime compiles, and refuses a scan that is not a boolean', () => {
		const files = new Map(Object.entries({ ...CLEAN_APPLICATION, 'fabrika.contract.ts': withFiles(', scan: true') }))
		const artifact = readContractSource(files)
		expect(artifact.files['attachments']?.scan).toBe(true)
		expect(artifact).toEqual(compileContract(readContract(files), artifact.tables))
		expect(() => readContractSource(new Map(Object.entries({ ...CLEAN_APPLICATION, 'fabrika.contract.ts': withFiles(", scan: 'yes'") })))).toThrow(
			'scan',
		)
	})
})

describe('a collection that turns scanning on', () => {
	const created = { 'db/migrations/20261001000000_attachments.sql': `CREATE TABLE notes (id text PRIMARY KEY);\n${EARLIER_DDL}` }

	test('over a table of the earlier DDL is told the migration fileScanSql writes, at the statement that created it', async () => {
		const findings = await check(application(', scan: true', created))
		expect(locations(findings, 'file-scan-migration')).toEqual(['db/migrations/20261001000000_attachments.sql:2:1'])
		expect(findings.find((finding) => finding.rule === 'file-scan-migration')?.allowed).toContain("fileScanSql('attachments')")
	})

	test('passes once a migration widens the check, when the table was created by the current DDL, and when it does not scan', async () => {
		const widened = { ...created, 'db/migrations/20261012000000_scan_attachments.sql': fileScanSql('attachments') }
		expect(locations(await check(application(', scan: true', widened)), 'file-scan-migration')).toEqual([])
		const current = { 'db/migrations/20261001000000_attachments.sql': fileTableSql('attachments', OWNER) }
		expect(locations(await check(application(', scan: true', current)), 'file-scan-migration')).toEqual([])
		expect(locations(await check(application('', created)), 'file-scan-migration')).toEqual([])
	})
})
