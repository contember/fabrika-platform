// The static reader against the runtime (B1): every fixture contract of the repository, read from its text and
// compiled from the evaluated module, gives the same artifact and the same canonical bytes. The fixtures the runtime
// cannot evaluate — type errors and non-literals — the reader refuses.

import { compileContract, ContractError } from '@fabrika/app/contract'
import { canonicalArtifactJson, type ContractArtifact, type TablePolicyArtifact } from '@fabrika/auth-core'
import { defineTables, PolicyError, readTables, tablePolicies } from '@fabrika/db/tables'
import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod/v4'
import { contract as catalogContract } from '../../../app/src/__tests__/fixtures/connect-catalog/fabrika.contract'
import { contract as shopContract } from '../../../app/src/__tests__/fixtures/connect-shop/fabrika.contract'
import { contract as implementContract } from '../../../app/src/__tests__/fixtures/implement/fabrika.contract'
import { NOTE_TABLE } from '../../../app/src/__tests__/fixtures/implement/stores'
import { contract as intakeContract } from '../../../app/src/__tests__/fixtures/intake/fabrika.contract'
import { tables as intakeTables } from '../../../app/src/__tests__/fixtures/intake/src/db/tables'
import { contract as jobsContract } from '../../../app/src/__tests__/fixtures/jobs-notes/fabrika.contract'
import { contract as kitFilesContract } from '../../../app/src/__tests__/fixtures/kit-files/fabrika.contract'
import { tables as kitFilesTables } from '../../../app/src/__tests__/fixtures/kit-files/src/db/tables'
import { contract as multiTenantContract } from '../../../app/src/__tests__/fixtures/multi-tenant/fabrika.contract'
import { tables as multiTenantTables } from '../../../app/src/__tests__/fixtures/multi-tenant/src/db/tables'
import { contract as mutationKickContract } from '../../../app/src/__tests__/fixtures/mutation-kick/fabrika.contract'
import { tables as mutationKickTables } from '../../../app/src/__tests__/fixtures/mutation-kick/src/db/tables'
import { contract as notesContract } from '../../../app/src/__tests__/fixtures/notes-app/fabrika.contract'
import { contract as publicKickContract } from '../../../app/src/__tests__/fixtures/public-kick/fabrika.contract'
import { tables as publicKickTables } from '../../../app/src/__tests__/fixtures/public-kick/src/db/tables'
import { contract as scopedContract } from '../../../app/src/__tests__/fixtures/scoped-notes/fabrika.contract'
import { tables as scopedTables } from '../../../app/src/__tests__/fixtures/scoped-notes/src/db/tables'
import { contract as organizationsContract } from '../../../app/src/__tests__/fixtures/scoped-organizations/fabrika.contract'
import { tables as organizationsTables } from '../../../app/src/__tests__/fixtures/scoped-organizations/src/db/tables'
import { contract as visitorIntakeContract } from '../../../app/src/__tests__/fixtures/visitor-intake/fabrika.contract'
import { tables as visitorIntakeTables } from '../../../app/src/__tests__/fixtures/visitor-intake/src/db/tables'
import { contract as kitContract } from '../../../app/src/__tests__/kit-fixture/fabrika.contract'
import { tables as kitTables } from '../../../app/src/__tests__/kit-fixture/src/db/tables'
import { contract as publicContract } from '../../../app/src/__tests__/public-fixture/fabrika.contract'
import { tables as publicTables } from '../../../app/src/__tests__/public-fixture/src/db/tables'
import { contract as storedFilesContract } from '../../../app/src/__tests__/stored-files-fixture/fabrika.contract'
import { tables as storedFilesTables } from '../../../app/src/__tests__/stored-files-fixture/src/db/tables'
import { contract as tokenContract } from '../../../app/src/__tests__/token-fixture/fabrika.contract'
import { tables as tokenTables } from '../../../app/src/__tests__/token-fixture/src/db/tables'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { ContractSourceError, readContractSource, readTablesSource } from '../contract'
import {
	ARCHITECTURE_ROOT,
	evaluateInBun,
	fetchedByControl,
	KIT_ROOT,
	materialize as materializeFiles,
	readTree as readKitTree,
	removeMaterialized,
} from './colocated-helpers'
import { contract as cleanContract } from './fixtures/clean-app/fabrika.contract'
import { contract as derivedContract } from './fixtures/derived-tables/fabrika.contract'
import { columns as derivedColumns } from './fixtures/derived-tables/src/db/schema.generated'
import { tables as derivedTables } from './fixtures/derived-tables/src/db/tables'
import { vocabulary as derivedVocabulary } from './fixtures/derived-tables/src/vocabulary'
import { contract as readerFormsContract } from './fixtures/reader-forms/fabrika.contract'

afterAll(removeMaterialized)

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
}

/** The notes artifact's policies without its form inbox, which this framework release no longer compiles against. */
const NOTES_TABLES: Readonly<Record<string, TablePolicyArtifact>> = Object.fromEntries(
	Object.entries(notesArtifact.tables).filter(([, policy]) => policy.scope.mode !== 'inbox'),
)

interface Fixture {
	readonly name: string
	readonly root: string
	/** `compileContract` over the evaluated modules. */
	readonly evaluated: () => ContractArtifact
	/** The artifact form of the policies, for a fixture without `src/db/tables.ts`; otherwise the reader reads that file. */
	readonly tables?: Readonly<Record<string, TablePolicyArtifact>>
}

const fixtures: readonly Fixture[] = [
	{
		name: '@fabrika/app notes-app',
		root: join(APP_TESTS, 'fixtures', 'notes-app'),
		evaluated: () => compileContract(notesContract, NOTES_TABLES),
		tables: NOTES_TABLES,
	},
	{
		name: '@fabrika/check clean-app',
		root: join(import.meta.dir, 'fixtures', 'clean-app'),
		evaluated: () => compileContract(cleanContract, {}),
		tables: {},
	},
	{
		name: '@fabrika/check reader-forms',
		root: join(import.meta.dir, 'fixtures', 'reader-forms'),
		evaluated: () => compileContract(readerFormsContract, READER_FORMS_TABLES),
		tables: READER_FORMS_TABLES,
	},
	{
		name: '@fabrika/check derived-tables (every containment derived from the vocabulary, read from source)',
		root: join(import.meta.dir, 'fixtures', 'derived-tables'),
		evaluated: () => compileContract(derivedContract, derivedTables),
	},
	{
		name: '@fabrika/app implement',
		root: join(APP_TESTS, 'fixtures', 'implement'),
		evaluated: () => compileContract(implementContract, { notes: NOTE_TABLE }),
		tables: { notes: NOTE_TABLE },
	},
	{
		name: '@fabrika/app scoped-notes (src/db/tables.ts read from source)',
		root: join(APP_TESTS, 'fixtures', 'scoped-notes'),
		evaluated: () => compileContract(scopedContract, scopedTables),
	},
	{
		name: '@fabrika/app scoped-organizations (src/db/tables.ts read from source)',
		root: join(APP_TESTS, 'fixtures', 'scoped-organizations'),
		evaluated: () => compileContract(organizationsContract, organizationsTables),
	},
	{
		name: '@fabrika/app kit-files (file columns of two kinds, one that scans, reached by handlers and jobs, read from source)',
		root: join(APP_TESTS, 'fixtures', 'kit-files'),
		evaluated: () => compileContract(kitFilesContract, kitFilesTables),
	},
	{
		name: '@fabrika/app jobs-notes (the scoped-notes tables)',
		root: join(APP_TESTS, 'fixtures', 'jobs-notes'),
		evaluated: () => compileContract(jobsContract, scopedTables),
		tables: tablePolicies(scopedTables),
	},
	{
		name: '@fabrika/app multi-tenant (src/db/tables.ts read from source)',
		root: join(APP_TESTS, 'fixtures', 'multi-tenant'),
		evaluated: () => compileContract(multiTenantContract, multiTenantTables),
	},
	{
		name: '@fabrika/app intake (public procedures with a rate, a honeypot and a challenge; src/db/tables.ts read from source)',
		root: join(APP_TESTS, 'fixtures', 'intake'),
		evaluated: () => compileContract(intakeContract, intakeTables),
	},
	{
		name: '@fabrika/app connect/catalog, the owner of an export',
		root: join(APP_TESTS, 'fixtures', 'connect-catalog'),
		evaluated: () => compileContract(catalogContract, {}),
		tables: {},
	},
	{
		name: '@fabrika/app visitor-intake (a job that issues links, link-holder files, public procedures and a public SPA, read from source)',
		root: join(APP_TESTS, 'fixtures', 'visitor-intake'),
		evaluated: () => compileContract(visitorIntakeContract, visitorIntakeTables),
	},
	{
		name: '@fabrika/app public-fixture (public procedures in a group without callers, admission and limits, read from source)',
		root: join(APP_TESTS, 'public-fixture'),
		evaluated: () => compileContract(publicContract, publicTables),
	},
	{
		name: '@fabrika/app token-fixture (token purposes of the kit, signedToken fields, signs, read from source)',
		root: join(APP_TESTS, 'token-fixture'),
		evaluated: () => compileContract(tokenContract, tokenTables),
	},
	{
		name: '@fabrika/app public-kick (a public procedure that kicks a job, read from source)',
		root: join(APP_TESTS, 'fixtures', 'public-kick'),
		evaluated: () => compileContract(publicKickContract, publicKickTables),
	},
	{
		name: '@fabrika/app mutation-kick (a mutation that kicks a job, read from source)',
		root: join(APP_TESTS, 'fixtures', 'mutation-kick'),
		evaluated: () => compileContract(mutationKickContract, mutationKickTables),
	},
	{
		name: '@fabrika/app stored-files (file kinds, file fields and outputs, file columns, read from source)',
		root: join(APP_TESTS, 'stored-files-fixture'),
		evaluated: () => compileContract(storedFilesContract, storedFilesTables),
	},
	{
		name: '@fabrika/app connect/shop, whose import reads its digest from the vendored snapshot',
		root: join(APP_TESTS, 'fixtures', 'connect-shop'),
		evaluated: () => compileContract(shopContract, {}),
		tables: {},
	},
]

describe('the static reader and the evaluated contract agree', () => {
	for (const fixture of fixtures) {
		test(`${fixture.name}: the same artifact and the same canonical serialization`, () => {
			const read = readContractSource(readTree(fixture.root), fixture.tables)
			const evaluated = fixture.evaluated()

			expect(read).toEqual(evaluated)
			expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(evaluated))
		})
	}

	test('the reader-forms fixture reaches every endpoint kind and companion', () => {
		const artifact = readContractSource(readTree(fixtures[2]?.root ?? ''), READER_FORMS_TABLES)

		expect(new Set(artifact.endpoints.map((row) => row.kind))).toEqual(
			new Set(['query', 'mutation', 'spa', 'health', 'webhook', 'link-spa']),
		)
		expect(Object.keys(artifact.fileKinds ?? {})).toEqual(['attachments'])
		expect(Object.keys(artifact.jobs).sort()).toEqual(['cleanup', 'digest'])
		expect(Object.keys(artifact.exports)).toEqual(['tasks'])
		expect(Object.keys(artifact.imports)).toEqual(['billing'])
		expect(artifact.dimensions['project']?.directory).toBe('labels')
		expect([artifact.locale, artifact.displayName]).toEqual(['cs', 'Úkoly'])
		expect(artifact.roles['contributor']?.external).toBe(true)
		expect(artifact.mail?.reset?.cs?.text).toBe('Heslo si nastavíte zde:\n{{actionUrl}}')
	})
})

/** How the reader refuses each type-level mistake of `@fabrika/app`, which the runtime cannot evaluate type-safely. */
const MISTAKES: Readonly<Record<string, string>> = {
	'01-forgot-access.ts': 'fabrika.contract.ts:33:12 access is missing',
	'02-rpc-with-public-caller.ts': "fabrika.contract.ts:30:32 'public' is not a caller of an RPC mount",
	'03-action-typo.ts': "procedure 'api.notes.list': 'notes.raed' is not an action of the contract — did you mean 'notes.read'?",
	'04-wildcard-role.ts': "role 'everything': '*' is not an action of the contract",
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
	'20-creates-contained-dimension.ts':
		"procedure 'api.workspaces.create': creates a 'note', which lies in 'workspace' (allowed: a dimension without in; a contained value is a row a store inserts)",
	'21-oauth-caller-on-rpc-mount.ts': "fabrika.contract.ts:30:40 'oauth' is not a caller of an RPC mount",
	'22-app-caller-on-rpc-mount.ts': "fabrika.contract.ts:30:40 'app:billing' is not a caller of an RPC mount",
	'23-member-access-in-export.ts': 'fabrika.contract.ts:36:55 an export procedure names its action',
	'24-unsupported-locale.ts': "fabrika.contract.ts:6:10 locale is 'de'",
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
			expect(firstRefusal(files, NOTES_TABLES)).toBe(refusal)
		})
	}

	test('defineVocabulary of a schema, a string or an array is refused: the runtime returns only its four fields', () => {
		const header = "import { defineContract, defineVocabulary } from '@fabrika/app/contract'\nimport { z } from 'zod/v4'\n"
		const vocabulary = "{ app: 'crm', dimensions: {}, actions: { 'crm.read': 'Read' }, roles: { viewer: { grants: ['crm.read'] } } }"
		for (const argument of ['z.strictObject({ ok: z.boolean() })', "'crm'", "['crm']"]) {
			const source = `${header}export const contract = defineContract(${vocabulary}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, { read: c.query({ output: defineVocabulary(${argument}), access: { member: true } }) }),
}))
`
			expect(firstRefusal(new Map([['fabrika.contract.ts', source]]), {})).toBe(
				'fabrika.contract.ts:4:71 defineVocabulary used other than as one call of one object',
			)
		}
	})

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

// ── Paired cases: the reader and Bun on the same files ──────────────────────────────────────────

const PAIRED_DIR = join(import.meta.dir, 'fixtures', 'paired')
const RUNNER = join(import.meta.dir, 'fixtures', 'paired-runner.mjs')
const PACKAGE_ROOT = join(import.meta.dir, '..', '..')

/** What Bun does with a case the reader refuses: the divergence the refusal prevents, or the error evaluation throws. */
type Runtime = { readonly includes: string } | { readonly excludes: string } | { readonly error: string }

type PairedCase = { readonly kind: 'same'; readonly includes: string } | {
	readonly kind: 'refused'
	readonly reader: string
	readonly runtime: Runtime
}

const PAIRED: Readonly<Record<string, PairedCase>> = {
	'trusted-path-mapping': {
		kind: 'refused',
		reader: "tsconfig.json:3:34 unchecked-import the paths entry '@fabrika/app/contract' can redirect a package the platform trusts by name",
		runtime: { includes: '"machine"' },
	},
	'zod-path-mapping': {
		kind: 'refused',
		reader: "tsconfig.json:1:35 unchecked-import the paths entry 'zod/*' can redirect a package the platform trusts by name",
		runtime: { excludes: '"format":"uuid"' },
	},
	'base-url-shadow': {
		kind: 'refused',
		reader: 'tsconfig.json:1:24 unchecked-import baseUrl lets an application file shadow a package the platform trusts by name',
		runtime: { excludes: '"format":"uuid"' },
	},
	'extension-collision': {
		kind: 'refused',
		reader:
			"fabrika.contract.ts:3:10 literal './src/callers' resolves to each of src/callers.ts, src/callers.tsx, which the platform does not resolve as Bun does",
		runtime: { includes: '"machine"' },
	},
	'directory-package-entry': {
		kind: 'refused',
		reader:
			"fabrika.contract.ts:3:10 literal './src/callers' is a directory import (src/callers/index.ts), which the platform does not resolve as Bun does",
		runtime: { includes: '"machine"' },
	},
	'forward-reference': {
		kind: 'refused',
		reader: "fabrika.contract.ts:4:38 literal 'Title' is used before its declaration, where the module cannot read it yet",
		runtime: { error: 'ReferenceError' },
	},
	'import-cycle': {
		kind: 'refused',
		reader: "src/b.ts:1:10 literal './a' closes an import cycle",
		runtime: { error: 'ReferenceError' },
	},
	'computed-builder-member': {
		kind: 'refused',
		reader: 'fabrika.contract.ts:11:27 literal a computed builder member',
		runtime: { includes: '"format":"uuid"' },
	},
	'duplicate-keys': { kind: 'same', includes: '"machine"' },
	'renamed-builders': { kind: 'same', includes: '"maxLength":200' },
	'escaped-strings': { kind: 'same', includes: '"Read All Notes"' },
	'negative-zero': { kind: 'same', includes: '"balance"' },
}

const runtimeResult = z.union([
	z.strictObject({ ok: z.literal(true), json: z.string() }),
	z.strictObject({ ok: z.literal(false), error: z.string() }),
])

const temporary: string[] = []
afterAll(() => {
	for (const directory of temporary) rmSync(directory, { recursive: true, force: true })
})

/** The case's files written out under the package, so that Bun resolves zod and the framework from its node_modules. */
const materialize = (name: string): string => {
	const directory = mkdtempSync(join(PACKAGE_ROOT, '.paired-'))
	temporary.push(directory)
	for (const [path] of readTree(join(PAIRED_DIR, name), '.fixture')) {
		const target = join(directory, path)
		mkdirSync(dirname(target), { recursive: true })
		copyFileSync(join(PAIRED_DIR, name, `${path}.fixture`), target)
	}
	return directory
}

const evaluate = (directory: string) => {
	const run = Bun.spawnSync([process.execPath, RUNNER, join(directory, 'fabrika.contract.ts')], { cwd: directory })
	return runtimeResult.parse(JSON.parse(run.stdout.toString()))
}

/** The reader's canonical artifact, or its first refusal as `file:line:col rule message`. */
const readSide = (files: ReadonlyMap<string, string>): { readonly json: string } | { readonly refusal: string } => {
	try {
		return { json: canonicalArtifactJson(readContractSource(files, {})) }
	} catch (error) {
		if (error instanceof ContractSourceError) {
			const [finding] = error.findings
			return { refusal: finding === undefined ? 'no finding' : `${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}` }
		}
		throw error
	}
}

describe('paired cases: the reader agrees with Bun, or refuses where Bun would read something else', () => {
	test('every paired fixture directory is registered', () => {
		expect(readdirSync(PAIRED_DIR).sort()).toEqual(Object.keys(PAIRED).sort())
	})

	for (const [name, expected] of Object.entries(PAIRED)) {
		test(name, () => {
			const read = readSide(readTree(join(PAIRED_DIR, name), '.fixture'))
			const runtime = evaluate(materialize(name))
			if (expected.kind === 'same') {
				expect(runtime.ok ? runtime.json : runtime.error).toContain(expected.includes)
				expect(read).toEqual({ json: runtime.ok ? runtime.json : runtime.error })
				return
			}
			expect(read).toEqual({ refusal: expected.reader })
			const outcome = expected.runtime
			if ('error' in outcome) {
				expect(runtime.ok ? 'evaluated' : runtime.error).toStartWith(outcome.error)
			} else if ('includes' in outcome) {
				expect(runtime.ok ? runtime.json : runtime.error).toContain(outcome.includes)
			} else {
				expect(runtime.ok ? runtime.json : runtime.error).not.toContain(outcome.excludes)
				expect(runtime.ok).toBe(true)
			}
		})
	}
})

// The staged kit's cases. The table cases read `fixtures/derived-tables/`; the slice cases `@fabrika/app`'s
// `src/__tests__/kit-fixture/` and `fixtures/architecture-app/`.

describe('the staged kit: read from source and evaluated agree', () => {
	describe('tables derived from the vocabulary (WU2)', () => {
		const derivedFiles = readTree(join(import.meta.dir, 'fixtures', 'derived-tables'))
		const read = readTablesSource(derivedFiles)
		const evaluated = tablePolicies(derivedTables)

		test('a container column on the <container>_id convention reads the same as the evaluated defineTables', () => {
			expect(read['projects']).toEqual(evaluated['projects'])
			expect(read['projects']?.scope).toEqual({ mode: 'dimension', dimension: 'project', key: 'id', container: { dimension: 'org', column: 'org_id' } })
		})

		test('a child table whose chain comes from the vocabulary reads the same', () => {
			expect(read['task_comments']).toEqual(evaluated['task_comments'])
			expect(read['task_comments']?.scope).toEqual({
				mode: 'child',
				parent: 'tasks',
				key: 'id',
				column: 'task_id',
				inherit: ['parent_project', 'org_id'],
			})
		})

		test('a column write action reads the same, in the artifact the approval diff compares', () => {
			expect(read['tasks']?.columns).toEqual({ assignee: { write: 'tasks.assign' } })
			expect(read['tasks']?.update).toEqual(['title', 'due_on'])
			expect(read['tasks']).toEqual(evaluated['tasks'])
		})

		test('in: { column } off the convention reads the same', () => {
			expect(read['tasks']).toEqual(evaluated['tasks'])
			expect(read['tasks']?.scope).toEqual({
				mode: 'dimension',
				dimension: 'task',
				key: 'id',
				container: { dimension: 'project', column: 'parent_project' },
			})
			expect(read).toEqual(evaluated)
		})

		test("the architecture fixture's tables read from source; its whole contract needs the slice reader (WU4)", () => {
			const architecture = readTablesSource(readTree(join(import.meta.dir, 'fixtures', 'architecture-app'), '.fixture'))
			expect(architecture['deals']?.scope).toEqual({
				mode: 'dimension',
				dimension: 'deal',
				key: 'id',
				container: { dimension: 'company', column: 'company_id' },
			})
			expect(architecture['companies']?.scope).toEqual({
				mode: 'dimension',
				dimension: 'company',
				key: 'id',
				container: { dimension: 'org', column: 'org_id' },
			})
		})

		/** The reader's first finding on a tables module, and what the runtime parse throws on the same values. */
		const refusals = (source: string, policies: unknown, columns: unknown = derivedColumns, schema?: string) => {
			const files = new Map([
				...derivedFiles,
				['src/db/tables.ts', source],
				...(schema === undefined ? [] : [['src/db/schema.generated.ts', schema] as const]),
			])
			let reader = 'accepted'
			try {
				readTablesSource(files)
			} catch (error) {
				if (!(error instanceof ContractSourceError)) throw error
				reader = error.findings[0]?.message ?? 'no finding'
			}
			let runtime = 'accepted'
			try {
				readTables(JSON.parse(JSON.stringify(columns)), JSON.parse(JSON.stringify(policies)), JSON.parse(JSON.stringify(derivedVocabulary)))
			} catch (error) {
				if (!(error instanceof PolicyError)) throw error
				runtime = error.message
			}
			return { reader, runtime }
		}
		const fixtureTables = derivedFiles.get('src/db/tables.ts') ?? ''
		const policiesOf = (replace: (policies: Record<string, Record<string, unknown>>) => void) => {
			const policies: Record<string, Record<string, unknown>> = {
				orgs: { scope: { dimension: 'org' }, actions: { read: 'tasks.read' } },
				projects: {
					scope: { dimension: 'project' },
					actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
					insert: ['name'],
					update: ['name'],
					version: 'version',
				},
				tasks: {
					scope: { dimension: 'task', in: { column: 'parent_project' } },
					actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
					insert: ['title'],
					update: ['title', 'due_on'],
					columns: { assignee: { write: 'tasks.assign' } },
				},
				task_comments: { scope: { child: 'tasks' }, actions: { read: 'tasks.read', insert: 'tasks.write' }, insert: ['body'] },
			}
			replace(policies)
			return policies
		}

		test('a container column that is not the foreign key to its container is refused from source, as at runtime', () => {
			const source = fixtureTables.replace("in: { column: 'parent_project' }", "in: { column: 'org_id' }")
			const policies = policiesOf((all) => {
				all['tasks'] = { ...all['tasks'], scope: { dimension: 'task', in: { column: 'org_id' } } }
			})
			const message = "tasks: org_id is not a foreign key to projects.id, which owns project; state scope.in: { column: 'parent_project' }"
			expect(refusals(source, policies)).toEqual({ reader: message, runtime: message })
		})

		test('an action and a column read outside the vocabulary are refused from source, as at runtime', () => {
			const action = refusals(
				fixtureTables.replace(
					"orgs: { scope: { dimension: 'org' }, actions: { read: 'tasks.read' } }",
					"orgs: { scope: { dimension: 'org' }, actions: { read: 'tasks.raed' } }",
				),
				policiesOf((all) => {
					all['orgs'] = { scope: { dimension: 'org' }, actions: { read: 'tasks.raed' } }
				}),
			)
			expect(action).toEqual({
				reader: 'orgs: actions.read names tasks.raed, which is not an action of the vocabulary (actions: tasks.read, tasks.write, tasks.assign)',
				runtime: 'orgs: actions.read names tasks.raed, which is not an action of the vocabulary (actions: tasks.read, tasks.write, tasks.assign)',
			})
			const column = refusals(
				fixtureTables.replace(
					"orgs: { scope: { dimension: 'org' }, actions: { read: 'tasks.read' } }",
					"orgs: { scope: { dimension: 'org' }, actions: { read: 'tasks.read' }, columns: { name: { read: 'tasks.raed' } } }",
				),
				policiesOf((all) => {
					all['orgs'] = { scope: { dimension: 'org' }, actions: { read: 'tasks.read' }, columns: { name: { read: 'tasks.raed' } } }
				}),
			)
			expect(column.reader).toStartWith('orgs: columns.name.read names tasks.raed, which is not an action of the vocabulary')
			expect(column.runtime).toBe(column.reader)
		})

		test('a column write action outside the vocabulary, or on a column the update action writes, is refused from source too', () => {
			const tasksPolicy = (columns: string) => fixtureTables.replace("columns: { assignee: { write: 'tasks.assign' } }", `columns: { ${columns} }`)
			const tasksWith = (columns: Readonly<Record<string, unknown>>) =>
				policiesOf((all) => {
					all['tasks'] = { ...all['tasks'], columns }
				})
			const action = refusals(tasksPolicy("assignee: { write: 'tasks.asign' }"), tasksWith({ assignee: { write: 'tasks.asign' } }))
			expect(action.reader).toStartWith('tasks: columns.assignee.write names tasks.asign, which is not an action of the vocabulary')
			expect(action.runtime).toBe(action.reader)
			const listed = refusals(tasksPolicy("title: { write: 'tasks.assign' }"), tasksWith({ title: { write: 'tasks.assign' } }))
			expect(listed.reader).toBe(
				"tasks: title is in update, which the table's update action writes, and declares its own write action tasks.assign; remove it from update",
			)
			expect(listed.runtime).toBe(listed.reader)
		})

		test('a dimension no table owns keeps the vocabulary ancestry from source, as at runtime', () => {
			const schema = `import type { TypedColumnList } from '@fabrika/db'

export interface DB {
	tasks: { id: string; parent_project: string; org_id: string; title: string }
}

export const columns: TypedColumnList<DB> = { tasks: { columns: ['id', 'parent_project', 'org_id', 'title'], foreignKeys: [] } }
`
			const source = `import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	tasks: { scope: { dimension: 'task', in: { column: 'parent_project' } }, actions: { read: 'tasks.read', update: 'tasks.write' }, update: ['org_id'] },
})
`
			const policies = {
				tasks: {
					scope: { dimension: 'task', in: { column: 'parent_project' } },
					actions: { read: 'tasks.read', update: 'tasks.write' },
					update: ['org_id'],
				},
			}
			const columns = { tasks: { columns: ['id', 'parent_project', 'org_id', 'title'], foreignKeys: [] } }
			const message = 'tasks: org_id is stamped by the layer; remove it from insert and update'
			expect(refusals(source, policies, columns, schema)).toEqual({ reader: message, runtime: message })
		})

		test('the reader refuses the form that names the action union by hand, as the runtime does', () => {
			const handWritten = `import { defineTables } from '@fabrika/db/tables'
import { columns, type DB } from './schema.generated'

export const tables = defineTables<DB, 'tasks.read' | 'tasks.write'>(columns)({})
`
			const files = new Map([...derivedFiles, ['src/db/tables.ts', handWritten]])
			let findings: readonly string[] = []
			try {
				readTablesSource(files)
			} catch (error) {
				if (!(error instanceof ContractSourceError)) throw error
				findings = error.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.message}`)
			}
			expect(findings).toEqual([
				"src/db/tables.ts:4:23 'tables' is not one call of defineTables with the vocabulary and the column list, then the policies",
			])
			expect(() => Reflect.apply(defineTables, undefined, [derivedColumns])).toThrow(PolicyError)
		})
	})
	describe("the reader's slice of shell modules (WU4)", () => {
		const read = (): ContractArtifact => readContractSource(fetchedByControl(readKitTree(KIT_ROOT)))
		const evaluated = (): ContractArtifact => compileContract(kitContract, kitTables)

		test('a contract of groups in other modules, each endpoint with .handle beside it, reads the same artifact as the evaluated modules', () => {
			expect(read()).toEqual(evaluated())
			expect(canonicalArtifactJson(read())).toBe(canonicalArtifactJson(evaluated()))
		})

		test('a module only handlers import is never requested from the commit and never evaluated', () => {
			const commit = readKitTree(KIT_ROOT)
			expect(commit.has('src/deals/logic.ts')).toBe(true)
			expect(fetchedByControl(commit).has('src/deals/logic.ts')).toBe(false)
			const broken = new Map([...commit, ['src/deals/logic.ts', 'throw new Error(((']])
			expect(canonicalArtifactJson(readContractSource(broken))).toBe(canonicalArtifactJson(evaluated()))
		})

		test('the declared sql, unscoped, connect and issues reach the artifact the same from source and evaluated', () => {
			expect(read().declared).toEqual(evaluated().declared)
			expect(Object.keys(read().declared ?? {}).sort()).toEqual([
				'api.companies.audit',
				'api.deals.pipeline',
				'api.deals.product',
				'api.deals.share',
				'api.ledgers.connect',
				'job:close',
			])
			expect(read().imports['catalog']?.usedBy).toEqual(['api.deals.product'])
		})

		test('a link mount, the webhooks, a cron job and an export of the kit read the same', () => {
			const [source, runtime] = [read(), evaluated()]
			expect(source.mounts['shared']).toEqual(runtime.mounts['shared'])
			expect(source.mounts['github']).toEqual(runtime.mounts['github'])
			expect(source.mounts['ledger']).toEqual(runtime.mounts['ledger'])
			expect(source.mounts['ledger']).toMatchObject({ boundTo: { kind: 'app' }, scheme: { hmac: { header: 'X-Ledger-Signature' } } })
			expect(source.declared?.['api.ledgers.connect']).toEqual(runtime.declared?.['api.ledgers.connect'])
			expect(source.declared?.['api.ledgers.connect']?.binds).toBe('ledger')
			expect(source.jobs['close']).toEqual(runtime.jobs['close'])
			expect(source.exports['pipeline']).toEqual(runtime.exports['pipeline'])
			const kinds = (artifact: ContractArtifact) => artifact.endpoints.filter((row) => ['shared.deal', 'pipeline.v1.deal', 'github'].includes(row.id))
			expect(kinds(source)).toEqual(kinds(runtime))
			expect(kinds(source).map((row) => row.id).sort()).toEqual(['github', 'pipeline.v1.deal', 'shared.deal'])
		})

		test('the architecture fixture reads the same from source as Bun evaluates it', () => {
			const files = readKitTree(ARCHITECTURE_ROOT, ['.fixture'])
			const directory = materializeFiles(files)
			expect(evaluateInBun(join(directory, 'fabrika.contract.ts'), join(directory, 'src/db/tables.ts'))).toEqual({
				ok: true,
				json: canonicalArtifactJson(readContractSource(files)),
			})
		})
	})
})

describe('every fixture directory is registered', () => {
	test('in @fabrika/check and in @fabrika/app', () => {
		const registered = new Set(
			[...fixtures.map((fixture) => fixture.root), ARCHITECTURE_ROOT].map((root) => relative(join(import.meta.dir, '..', '..', '..'), root)),
		)
		const directories = (root: string): string[] =>
			readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) =>
				relative(join(import.meta.dir, '..', '..', '..'), join(root, entry.name))
			)
		const refusedOnly = new Set([
			'check/src/__tests__/fixtures/spike-contract',
			'check/src/__tests__/fixtures/paired',
		])
		const found = [...directories(join(import.meta.dir, 'fixtures')), ...directories(join(APP_TESTS, 'fixtures'))]
		expect(found.filter((directory) => !registered.has(directory) && !refusedOnly.has(directory))).toEqual([])
	})
})
