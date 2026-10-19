// Files as values in the checker: the reader reads `file('<kind>')` and the kinds (`differential.test.ts` compares the
// artifacts), and every declared file column needs a foreign key to `fabrika_files` and an index it leads.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkFileColumnMigrations } from '../rules/migrations'
import { generatedTests, scaffoldInputs } from '../scaffold'
import { check, locations } from './helpers'

const FIXTURE = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'stored-files-fixture')
const MIGRATION = 'db/migrations/20261019100000_files.sql'

const fixtureFiles = (): Record<string, string> => {
	const files: Record<string, string> = {}
	for (const entry of readdirSync(FIXTURE, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) {
			const path = join(entry.parentPath, entry.name)
			files[relative(FIXTURE, path)] = readFileSync(path, 'utf8')
		}
	}
	return files
}

const ATTACHMENTS = [{ table: 'deal_attachments', column: 'file', kind: 'attachments' }]
const TABLE = 'create table deal_attachments (\n\tid text primary key,\n\tfile uuid not null references fabrika_files (id)\n);\n'

const refusals = (migrations: Readonly<Record<string, string>>): string[] =>
	checkFileColumnMigrations(new Map(Object.entries(migrations)), ATTACHMENTS).map((finding) => `${finding.file}:${finding.line} ${finding.message}`)

test('the scaffold sends a generated file of its kind in each file field of an endpoint access case', async () => {
	const inputs = scaffoldInputs(new Map(Object.entries(fixtureFiles())))
	const endpointTests = [...(await generatedTests(inputs.policies, inputs.artifact))].find(([path]) => path.endsWith('endpoint-access.test.ts'))?.[1]
		.text
	expect(endpointTests).toContain("kit.own('api.attachments.upload', { dealId: 'x', file: 'fabrika:file:attachments', name: 'x' })")
	expect(endpointTests).toContain("kit.own('api.attachments.uploadMany', { dealId: 'x', files: [] })")
})

describe('a declared file column in the migrations', () => {
	test('the stored-files fixture declares a foreign key and an index for each of its three file columns', async () => {
		const findings = await check(fixtureFiles())
		expect(locations(findings, 'file-column-migration')).toEqual([])
		expect(locations(findings, 'literal')).toEqual([])
		expect(locations(findings, 'contract')).toEqual([])
	})

	test('a column without its index or its foreign key is refused at the statement that creates its table', async () => {
		const files = fixtureFiles()
		const migration = files[MIGRATION] ?? ''
		const unindexed = migration.replace('create index deal_attachments_file on deal_attachments (file);\n', '')
		const findings = await check({ ...files, [MIGRATION]: unindexed })
		expect(locations(findings, 'file-column-migration')).toEqual([`${MIGRATION}:7:1`])
		expect(findings.find((finding) => finding.rule === 'file-column-migration')?.message).toBe(
			"deal_attachments.file holds files of kind 'attachments', and no migration creates an index it leads",
		)
		const loose = migration.replace('image uuid references fabrika_files (id)', 'image uuid')
		expect(locations(await check({ ...files, [MIGRATION]: loose }), 'file-column-migration')).toEqual([`${MIGRATION}:16:1`])
	})

	test('a later migration may add the column, its constraint or its index; a partial or a dropped index does not count', () => {
		const later = 'db/migrations/20261020000000_attach.sql'
		expect(refusals({ [MIGRATION]: `${TABLE}create index if not exists attached on only deal_attachments using btree (file, id);` })).toEqual([])
		expect(refusals({
			[MIGRATION]: 'create table deal_attachments (id text primary key);',
			[later]:
				'alter table deal_attachments add column if not exists file uuid, add constraint attached_file foreign key (file) references fabrika_files;\n'
				+ 'create unique index attached on deal_attachments (file);',
		})).toEqual([])
		expect(refusals({ [MIGRATION]: TABLE.replace('not null references fabrika_files (id)', 'not null unique references "fabrika_files" (id)') }))
			.toEqual([])
		expect(refusals({ [MIGRATION]: `${TABLE}create index attached on deal_attachments (file) where file is not null;` })).toEqual([
			`${MIGRATION}:1 deal_attachments.file holds files of kind 'attachments', and no migration creates an index it leads`,
		])
		expect(refusals({ [MIGRATION]: `${TABLE}create index attached on deal_attachments (file);`, [later]: 'drop index if exists attached;' })).toEqual([
			`${MIGRATION}:1 deal_attachments.file holds files of kind 'attachments', and no migration creates an index it leads`,
		])
		expect(
			refusals({ [MIGRATION]: `${TABLE.replace('fabrika_files (id)', 'other.fabrika_files (id)')}create index a on deal_attachments (id, file);` }),
		)
			.toEqual([
				`${MIGRATION}:1 deal_attachments.file holds files of kind 'attachments', and no migration makes it a foreign key to fabrika_files (id), and no migration creates an index it leads`,
			])
	})
})
