// The static reader against the runtime (B1): every fixture contract of the repository, read from its text and
// compiled from the evaluated module, gives the same artifact and the same canonical bytes. The fixtures the runtime
// cannot evaluate — type errors and non-literals — the reader refuses.

import { compileContract, ContractError } from '@fabrika/app/contract'
import { canonicalArtifactJson, type ContractArtifact, type TablePolicyArtifact } from '@fabrika/auth-core'
import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod/v4'
import { contract as implementContract } from '../../../app/src/__tests__/fixtures/implement/fabrika.contract'
import { NOTE_TABLE } from '../../../app/src/__tests__/fixtures/implement/stores'
import { contract as notesContract } from '../../../app/src/__tests__/fixtures/notes-app/fabrika.contract'
import { contract as scopedContract } from '../../../app/src/__tests__/fixtures/scoped-notes/fabrika.contract'
import { tables as scopedTables } from '../../../app/src/__tests__/fixtures/scoped-notes/src/db/tables'
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
	/** `compileContract` over the evaluated modules. */
	readonly evaluated: () => ContractArtifact
	/** The artifact form of the policies, for a fixture without `src/db/tables.ts`; otherwise the reader reads that file. */
	readonly tables?: Readonly<Record<string, TablePolicyArtifact>>
}

const fixtures: readonly Fixture[] = [
	{
		name: '@fabrika/app notes-app',
		root: join(APP_TESTS, 'fixtures', 'notes-app'),
		evaluated: () => compileContract(notesContract, notesArtifact.tables),
		tables: notesArtifact.tables,
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

describe('every fixture directory is registered', () => {
	test('in @fabrika/check and in @fabrika/app', () => {
		const registered = new Set(fixtures.map((fixture) => relative(join(import.meta.dir, '..', '..', '..'), fixture.root)))
		const directories = (root: string): string[] =>
			readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) =>
				relative(join(import.meta.dir, '..', '..', '..'), join(root, entry.name))
			)
		const refusedOnly = new Set(['check/src/__tests__/fixtures/spike-contract', 'check/src/__tests__/fixtures/paired'])
		const found = [...directories(join(import.meta.dir, 'fixtures')), ...directories(join(APP_TESTS, 'fixtures'))]
		expect(found.filter((directory) => !registered.has(directory) && !refusedOnly.has(directory))).toEqual([])
	})
})
