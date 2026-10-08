// The static reader against the runtime (B1): every fixture contract of the repository, read from its text and
// compiled from the evaluated module, gives the same artifact and the same canonical bytes. The fixtures the runtime
// cannot evaluate — type errors and non-literals — the reader refuses.

import { type AnyContract, compileContract, ContractError } from '@fabrika/app/contract'
import { canonicalArtifactJson, type TablePolicyArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { contract as notesContract } from '../../../app/src/__tests__/fixtures/notes-app/fabrika.contract'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { ContractSourceError, readContractSource } from '../contract'
import { contract as cleanContract } from './fixtures/clean-app/fabrika.contract'
import { contract as readerFormsContract } from './fixtures/reader-forms/fabrika.contract'

const APP_TESTS = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__')

/** Every `.ts` file under `root`, keyed by its path relative to `root`, as Control reads them from a commit. */
const readTree = (root: string, suffix = '.ts'): ReadonlyMap<string, string> => {
	const files = new Map<string, string>()
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(suffix)) {
			const path = join(entry.parentPath, entry.name)
			files.set(relative(root, path).replace(/\.fixture$/, ''), readFileSync(path, 'utf8'))
		}
	}
	return files
}

const table = (scope: TablePolicyArtifact['scope'], read: string, write: string | null): TablePolicyArtifact => ({
	scope,
	actions: { read, insert: write, update: write, delete: write },
	insert: [],
	update: [],
	version: null,
	createdBy: null,
	columns: {},
})

const READER_FORMS_TABLES: Readonly<Record<string, TablePolicyArtifact>> = {
	projects: table({ mode: 'dimension', dimension: 'project', key: 'id', container: null }, 'tasks.read', 'tasks.admin'),
	tasks: table(
		{ mode: 'dimension', dimension: 'task', key: 'id', container: { dimension: 'project', column: 'project_id' } },
		'tasks.read',
		'tasks.write',
	),
	feedback: table({ mode: 'inbox', form: 'feedback' }, 'inbox.read', null),
}

interface Fixture {
	readonly name: string
	readonly root: string
	readonly evaluated: AnyContract
	readonly tables: Readonly<Record<string, TablePolicyArtifact>>
}

const fixtures: readonly Fixture[] = [
	{ name: '@fabrika/app notes-app', root: join(APP_TESTS, 'fixtures', 'notes-app'), evaluated: notesContract, tables: notesArtifact.tables },
	{ name: '@fabrika/check clean-app', root: join(import.meta.dir, 'fixtures', 'clean-app'), evaluated: cleanContract, tables: {} },
	{
		name: '@fabrika/check reader-forms',
		root: join(import.meta.dir, 'fixtures', 'reader-forms'),
		evaluated: readerFormsContract,
		tables: READER_FORMS_TABLES,
	},
]

describe('the static reader and the evaluated contract agree', () => {
	for (const fixture of fixtures) {
		test(`${fixture.name}: the same artifact and the same canonical serialization`, () => {
			const read = readContractSource(readTree(fixture.root), fixture.tables)
			const evaluated = compileContract(fixture.evaluated, fixture.tables)

			expect(read).toEqual(evaluated)
			expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(evaluated))
		})
	}

	test('the reader-forms fixture reaches every endpoint kind and companion', () => {
		const artifact = readContractSource(readTree(fixtures[2]?.root ?? ''), READER_FORMS_TABLES)

		expect(new Set(artifact.endpoints.map((row) => row.kind))).toEqual(
			new Set(['query', 'mutation', 'spa', 'upload', 'download', 'health', 'form', 'webhook', 'link-spa']),
		)
		expect(Object.keys(artifact.files)).toEqual(['attachments'])
		expect(Object.keys(artifact.jobs).sort()).toEqual(['cleanup', 'digest'])
		expect(Object.keys(artifact.exports)).toEqual(['tasks'])
		expect(Object.keys(artifact.imports)).toEqual(['billing'])
	})
})

/** How the reader refuses each type-level mistake of `@fabrika/app`, which the runtime cannot evaluate type-safely. */
const MISTAKES: Readonly<Record<string, string>> = {
	'01-forgot-access.ts': 'fabrika.contract.ts:33:12 access is missing',
	'02-rpc-with-public-caller.ts': "fabrika.contract.ts:30:32 'public' is not a caller of an RPC mount",
	'03-action-typo.ts': "procedure 'api.notes.list': 'notes.raed' is not an action of the contract — did you mean 'notes.read'?",
	'04-wildcard-role.ts': "role 'admin': '*' is not an action of the contract",
	'11-loose-input.ts': "fabrika.contract.ts:31:26 '.loose()' makes the schema unserializable",
	'12-from-field-not-in-input.ts':
		"procedure 'api.notes.remove': access.from 'noteId' is not a required string field of the input (allowed: a string, a string literal or an enum)",
	'13-creates-dimension-without-creator.ts': "procedure 'api.workspaces.create': creates a 'note', which declares no creator role",
	'14-link-caller-on-rpc-mount.ts': "fabrika.contract.ts:30:40 'link' is not a caller of an RPC mount",
	'15-loose-output.ts': "fabrika.contract.ts:33:13 '.passthrough()' makes the schema unserializable",
	'16-wildcard-action.ts': "action 'notes.*': an action is exact, dot-separated words (allowed: 'notes.read'; no '*')",
	'17-mutation-in-export.ts': 'fabrika.contract.ts:36:13 an export serves queries only',
	'18-link-procedure-outside-grants.ts': "procedure 'shared.remove': needs 'notes.delete', which the link does not grant (grants: notes.read)",
	'19-options-set-builder-fields.ts': "mount 'github': 'kind' is set by c.webhook itself and cannot be an option; remove it",
}

/** The first refusal, as a finding line without its rule id and allowed form, or as a compile problem. */
const firstRefusal = (files: ReadonlyMap<string, string>, tables: Readonly<Record<string, TablePolicyArtifact>>): string => {
	try {
		readContractSource(files, tables)
	} catch (error) {
		if (error instanceof ContractSourceError) {
			const [finding] = error.findings
			return finding === undefined ? 'no finding' : `${finding.file}:${finding.line}:${finding.column} ${finding.message}`
		}
		if (error instanceof ContractError) {
			return error.problems[0] ?? 'no problem'
		}
		throw error
	}
	return 'accepted'
}

describe('the reader refuses what the runtime cannot evaluate', () => {
	const mistakesDir = join(APP_TESTS, 'contract-mistakes')
	test('the mistakes table names every mistake fixture', () => {
		expect(readdirSync(mistakesDir).sort()).toEqual(Object.keys(MISTAKES).sort())
	})

	for (const [file, refusal] of Object.entries(MISTAKES)) {
		test(`contract-mistakes/${file}`, () => {
			const files = new Map([['fabrika.contract.ts', readFileSync(join(mistakesDir, file), 'utf8')]])
			expect(firstRefusal(files, notesArtifact.tables)).toBe(refusal)
		})
	}

	test('the parser spike sample contract fails with its literal findings', () => {
		const files = readTree(join(import.meta.dir, 'fixtures', 'spike-contract'), '.fixture')
		let findings: readonly string[] = []
		try {
			readContractSource(files, {})
		} catch (error) {
			if (!(error instanceof ContractSourceError)) throw error
			findings = error.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule}`)
		}
		expect(findings).toContain('fabrika.contract.ts:48:23 literal')
		expect(findings).toContain('src/schemas/notes.ts:18:24 literal')
		expect(findings.every((finding) => finding.endsWith(' literal'))).toBe(true)
	})
})
