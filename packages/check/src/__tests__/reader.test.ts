// The static contract reader: every form it refuses, with its position, and the refusals it shares with the runtime.

import { compileContract, ContractError, defineContract } from '@fabrika/app/contract'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { CONTRACT_LIMITS, ContractSourceError, readContract, readContractSource, readTablesSource } from '../contract'
import { check } from './helpers'

const BASE = `import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { Note } from './src/schemas'

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
	}),
	health: c.health('/healthz'),
}))
`

const SCHEMAS = `import { z } from 'zod/v4'

export const Note = z.strictObject({ id: z.uuid(), title: z.string() })
`

const edited = (search: string, replacement: string, text = BASE): string => {
	if (!text.includes(search)) throw new Error(`the base has no '${search}'`)
	return text.replace(search, replacement)
}

const application = (contract: string, schemas = SCHEMAS): ReadonlyMap<string, string> =>
	new Map([['fabrika.contract.ts', contract], ['src/schemas.ts', schemas]])

/** The findings of a refused read, as `file:line:col rule message`. */
const refusal = (files: ReadonlyMap<string, string>): string[] => {
	try {
		readContract(files)
	} catch (error) {
		if (error instanceof ContractSourceError) {
			return error.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}`)
		}
		throw error
	}
	return []
}

describe('the reader refuses what it cannot read, with the position and the allowed form', () => {
	test('a missing contract module, a contract export of another name, and a contract that is no defineContract call', () => {
		expect(refusal(new Map([['src/schemas.ts', SCHEMAS]]))).toEqual(['fabrika.contract.ts:1:1 contract the application has no fabrika.contract.ts'])
		expect(refusal(application(edited('export const contract', 'export const surface')))).toEqual([
			"fabrika.contract.ts:1:1 contract 'fabrika.contract.ts' exports no const 'contract'",
		])
		expect(refusal(application("export const contract = { app: 'notes' }\n"))).toEqual(['fabrika.contract.ts:1:25 contract the contract is a object'])
	})

	test("an installation service's contract and an installation-only caller are no application contract (ADR-0022)", () => {
		const service = `import { defineServiceContract } from '@fabrika/app/service'

export const contract = defineServiceContract('vozka', (s) => ({ mcp: s.oauth('/mcp', { scopes: ['authoring'] }) }))
`
		expect(refusal(application(service))).toEqual([
			'fabrika.contract.ts:3:25 literal call of a function that is not c.*, z.*, define* or the kit of defineApp',
			"fabrika.contract.ts:1:10 literal value import of 'defineServiceContract' from the package '@fabrika/app/service'",
		])
		expect(refusal(application(edited("callers: ['human']", "callers: ['oauth']")))).toEqual([
			"fabrika.contract.ts:11:32 contract 'oauth' is not a caller of an RPC mount",
		])
	})

	test('a source the parser rejects, and an import of a module the caller did not supply', () => {
		expect(refusal(application(BASE, 'export const Note = {\n'))).toEqual(['src/schemas.ts:2:1 parse-error Unexpected token (2:0)'])
		expect(refusal(new Map([['fabrika.contract.ts', BASE]]))).toEqual(["fabrika.contract.ts:3:10 literal unresolved module './src/schemas'"])
	})

	test('every form the literal rule refuses is refused before anything is read', () => {
		expect(refusal(application(edited("app: 'notes'", 'app: process.env.APP')))).toEqual([
			'fabrika.contract.ts:6:7 literal MemberExpression is not a literal',
		])
	})

	test('a hand-written mount, a job among the mounts, and a mount that is a plain value', () => {
		const contract = edited(
			"health: c.health('/healthz'),",
			"health: { kind: 'health', path: '/healthz' },\n\tpurge: c.cron('0 3 * * *', { actions: ['notes.write'], scope: 'app' }),\n\tlabel: 'notes',",
		)
		expect(refusal(application(contract))).toEqual([
			'fabrika.contract.ts:14:10 contract a object where a builder call stands',
			'fabrika.contract.ts:15:9 contract a c.cron(…) where a builder call stands',
			'fabrika.contract.ts:16:9 contract a string where a builder call stands',
		])
	})

	test('a builder of the wrong kit, a procedure that is a plain value, and a builder with extra arguments', () => {
		const contract = edited(
			"health: c.health('/healthz'),",
			"health: c.health('/healthz', 'extra'),\n"
				+ "\tshared: c.link('/s', { spa: 'dist/s', dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.write', maxDays: 7, procedures: (l) => ({\n"
				+ "\t\tnested: l.rpc('/x', { callers: ['human'] }, {}),\n"
				+ "\t\tlabel: 'x',\n"
				+ '\t}) }),',
		)
		expect(refusal(application(contract))).toEqual([
			'fabrika.contract.ts:14:10 contract c.health takes 1 arguments, not 2',
			'fabrika.contract.ts:16:11 contract l.rpc(…) is not a procedure here',
		])
	})

	test('a vocabulary field the contract does not have, a value of the wrong type, and a missing field', () => {
		expect(refusal(application(edited("app: 'notes',", "app: 'notes',\n\tlimits: { maxDays: 30 },")))).toEqual([
			"fabrika.contract.ts:7:10 contract 'limits' is not a field of the vocabulary",
		])
		expect(refusal(application(edited("callers: ['human']", "callers: 'human'")))).toEqual(['fabrika.contract.ts:11:32 contract callers is a string'])
		expect(refusal(application(edited("output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } ", 'output: Note ')))).toEqual([
			'fabrika.contract.ts:12:8 contract access is missing',
		])
	})

	test('callers outside the RPC callers, an empty caller list, and an access that mixes two forms', () => {
		expect(refusal(application(edited("callers: ['human']", "callers: ['human', 'link']")))).toEqual([
			"fabrika.contract.ts:11:32 contract 'link' is not a caller of an RPC mount",
		])
		expect(refusal(application(edited("callers: ['human']", 'callers: []')))).toEqual(['fabrika.contract.ts:11:32 contract callers is empty'])
		expect(refusal(application(edited("on: 'note', from: 'id'", "on: 'note', from: 'id', over: 'workspace'")))).toEqual([
			'fabrika.contract.ts:12:81 contract access is not one access form',
		])
	})

	test('a webhook with an unknown scheme and a link without its procedures callback', () => {
		const contract = edited(
			"health: c.health('/healthz'),",
			"hook: c.webhook('/hook', { scheme: 'stripe', boundTo: 'app', actions: ['notes.write'], input: Note }),\n"
				+ "\tshared: c.link('/s', { spa: 'dist/s', dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.write', maxDays: 7 }),",
		)
		expect(refusal(application(contract))).toEqual([
			'fabrika.contract.ts:14:37 contract c.webhook needs a known scheme',
			'fabrika.contract.ts:15:10 contract c.link needs procedures as a builder callback',
		])
	})

	test('schema arguments of the wrong type or count, an option the contract does not read, and a check on the wrong schema', () => {
		const schemas = `import { z } from 'zod/v4'

export const Note = z.strictObject({
	a: z.string().min('1'),
	b: z.string().min(1, { abort: true }),
	c: z.string().positive(),
	d: z.number().min(),
	e: z.uuid({ version: 'v9' }),
	f: z.string().includes('x', 'message'),
})
`
		expect(refusal(application(BASE, schemas))).toEqual([
			'src/schemas.ts:4:5 contract .min() takes a number, not a string',
			"src/schemas.ts:5:5 contract 'abort' is not an option the contract reads for .min()",
			'src/schemas.ts:6:5 contract .positive() is not a method of a string schema in the contract subset',
			'src/schemas.ts:7:5 contract .min() takes 1 to 2 arguments, not 0',
			"src/schemas.ts:8:5 contract 'v9' is not a UUID version",
			'src/schemas.ts:9:5 contract .includes() takes its options as an object',
		])
	})

	test('a schema zod itself refuses while building it', () => {
		const schemas = "import { z } from 'zod/v4'\n\nexport const Note = z.strictObject({ id: z.uuid() }).pick({ title: true })\n"
		expect(refusal(application(BASE, schemas))).toEqual(['src/schemas.ts:3:21 contract zod refuses this schema: Unrecognized key: "title"'])
	})

	test('defineTables in the contract graph, and a __proto__ key', () => {
		const tables = "import { defineTables } from '@fabrika/db/tables'\n\nexport const contract = defineTables()({})\n"
		expect(refusal(application(tables))).toEqual(['fabrika.contract.ts:3:25 contract defineTables in the contract graph'])
		expect(refusal(application(edited("app: 'notes',", "app: 'notes',\n\t__proto__: { roles: {} },")))).toEqual([
			'fabrika.contract.ts:7:2 literal a __proto__ key sets the prototype instead of a field',
		])
	})
})

describe('a schema method on a literal schema const', () => {
	const SCHEMAS_WITH_STATUS = `${SCHEMAS}export const Status = z.enum(['open', 'done'])\n`
	const INPUT = 'z.strictObject({ id: z.uuid(), status: Status.optional(), any: Status.nullable().array() })'
	const withStatus = (input: string): string =>
		edited("import { Note } from './src/schemas'", "import { Note, Status } from './src/schemas'", edited('z.strictObject({ id: z.uuid() })', input))

	test('reads as zod applies it at runtime: .optional(), .nullable() and .array() of an imported schema', () => {
		const Status = z.enum(['open', 'done'])
		const Note = z.strictObject({ id: z.uuid(), title: z.string() })
		const runtime = defineContract({
			app: 'notes',
			dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
			actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
			roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
		}, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				get: c.query({
					input: z.strictObject({ id: z.uuid(), status: Status.optional(), any: Status.nullable().array() }),
					output: Note,
					access: { action: 'notes.read', on: 'note', from: 'id' },
				}),
			}),
			health: c.health('/healthz'),
		}))
		expect(readContractSource(application(withStatus(INPUT), SCHEMAS_WITH_STATUS), {})).toEqual(compileContract(runtime, {}))
	})

	test('a string check whose order matters is refused at the call that adds it, written out or on an imported const', () => {
		const direct = edited('z.strictObject({ id: z.uuid() })', 'z.strictObject({ id: z.uuid(), link: z.url().max(80) })')
		expect(refusal(application(direct))).toEqual([
			'fabrika.contract.ts:12:62 literal z.url() rewrites the value, so another string check depends on its order',
		])
		const schemas = `${SCHEMAS}export const Url = z.url()\n`
		const imported = edited(
			"import { Note } from './src/schemas'",
			"import { Note, Url } from './src/schemas'",
			edited('z.strictObject({ id: z.uuid() })', 'z.strictObject({ id: z.uuid(), link: Url.max(80) })'),
		)
		expect(refusal(application(imported, schemas))).toEqual([
			'fabrika.contract.ts:12:62 contract z.url() rewrites the value, so another string check depends on its order',
		])
	})

	test('a method outside the subset is refused at its call, and a method on a value that is no schema at the call', () => {
		expect(refusal(application(withStatus('z.strictObject({ id: z.uuid(), status: Status.transform((value) => value) })'), SCHEMAS_WITH_STATUS)))
			.toEqual(["fabrika.contract.ts:12:64 literal '.transform()' makes the schema unserializable"])
		const limits = `${SCHEMAS}export const Status = { max: 3 }\n`
		expect(refusal(application(withStatus('z.strictObject({ id: z.uuid(), status: Status.optional() })'), limits))).toEqual([
			"fabrika.contract.ts:12:64 contract 'Status' is not a schema, so it takes no .optional()",
		])
	})
})

describe('a contract the reader reads but that does not compile fails with the runtime problems', () => {
	test('an option a builder sets itself, a typo in an action, and an option that changes a format', () => {
		const contract = edited(
			"health: c.health('/healthz'),",
			"health: c.health('/healthz'),\n\tsite: c.spa('/', { dir: 'dist', access: { action: 'notes.raed', over: 'workspace' }, prefix: '/x' }),",
		)
		const schemas = "import { z } from 'zod/v4'\n\nexport const Note = z.strictObject({ id: z.uuid({ version: 'v4' }), title: z.string() })\n"
		const runtime = defineContract({
			app: 'notes',
			dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
			actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
			roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
		}, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				get: c.query({
					input: z.strictObject({ id: z.uuid() }),
					output: z.strictObject({ id: z.uuid({ version: 'v4' }), title: z.string() }),
					access: { action: 'notes.read', on: 'note', from: 'id' },
				}),
			}),
			health: c.health('/healthz'),
		}))
		const problems = (compile: () => unknown): readonly string[] => {
			try {
				compile()
			} catch (error) {
				if (error instanceof ContractError) return error.problems
				throw error
			}
			return []
		}

		expect(problems(() => readContractSource(application(BASE, schemas), {}))).toEqual(problems(() => compileContract(runtime, {})))
		expect(problems(() => readContractSource(application(contract), {}))).toEqual([
			"mount 'site': 'prefix' is set by c.spa itself and cannot be an option; remove it",
			"mount 'site': 'notes.raed' is not an action of the contract — did you mean 'notes.read'?",
		])
	})
})

describe('the checker reports what the reader refuses', () => {
	test('a schema the runtime refuses is a contract finding at the contract, with the allowed form', async () => {
		const schemas = "import { z } from 'zod/v4'\n\nexport const Note = z.strictObject({ id: z.uuid(), title: z.string().regex(/^[a-z]+$/i) })\n"
		const findings = await check({ 'fabrika.contract.ts': BASE, 'src/schemas.ts': schemas })
		expect(findings).toEqual([{
			file: 'fabrika.contract.ts',
			line: 5,
			column: 25,
			severity: 'refusal',
			rule: 'contract',
			message: "mount 'api' procedure 'get' output.title: the pattern /^[a-z]+$/ has flags",
			allowed: 'a pattern without flags',
		}])
	})

	test('a contract the reader reads is clean, error messages included', async () => {
		const schemas =
			"import { z } from 'zod/v4'\n\nexport const Note = z.strictObject({ id: z.uuid('bad id'), title: z.string({ error: 'text' }).min(1, { message: 'short' }) })\n"
		expect(await check({ 'fabrika.contract.ts': BASE, 'src/schemas.ts': schemas })).toEqual([])
	})
})

describe('a configuration that can redirect a trusted package is refused', () => {
	const withConfig = (path: string, text: string): ReadonlyMap<string, string> => new Map([...application(BASE), [path, text]])

	test('paths patterns that can match a trusted specifier, in any tsconfig.json, and patterns that cannot', () => {
		expect(refusal(withConfig('tsconfig.json', '{ "compilerOptions": { "paths": { "*": ["./vendor/*"] } } }'))).toEqual([
			"tsconfig.json:1:35 unchecked-import the paths entry '*' can redirect a package the platform trusts by name",
		])
		expect(refusal(withConfig('src/tsconfig.json', '{ "compilerOptions": { "paths": { "@fab*": ["./x/*"] } } }'))).toEqual([
			"src/tsconfig.json:1:35 unchecked-import the paths entry '@fab*' can redirect a package the platform trusts by name",
		])
		expect(refusal(withConfig('tsconfig.json', '{ "compilerOptions": { "paths": { "~/*": ["./src/*"], "zodiac": ["./z.ts"] } } }'))).toEqual([])
	})

	test('an extends the reader cannot follow, a tsconfig that does not parse, and an extended file with paths', () => {
		expect(refusal(withConfig('tsconfig.json', '{ "extends": "@tsconfig/bun" }'))).toEqual([
			"tsconfig.json:1:3 unchecked-import tsconfig.json extends '@tsconfig/bun', a configuration outside what the platform reads",
		])
		expect(refusal(withConfig('tsconfig.json', '{ "extends": "../base.json" }'))).toEqual([
			"tsconfig.json:1:3 unchecked-import tsconfig.json extends '../base.json', which is not a file inside the application",
		])
		expect(refusal(withConfig('tsconfig.json', '{ "compilerOptions": '))).toEqual([
			'tsconfig.json:1:1 unchecked-import tsconfig.json is not JSON with comments, so its import mappings cannot be checked',
		])
		const extended = new Map([
			...withConfig('tsconfig.json', '{\n\t// shared settings\n\t"extends": "./config/base",\n}'),
			['config/base.json', '{ "compilerOptions": { "paths": { "zod/v4": ["../fake.ts"] } } }'],
		])
		expect(refusal(extended)).toEqual([
			"config/base.json:1:35 unchecked-import the paths entry 'zod/v4' can redirect a package the platform trusts by name",
		])
	})

	test('a runtime preload in bunfig.toml; a test preload is not refused', () => {
		expect(refusal(withConfig('bunfig.toml', 'preload = ["./plugin.ts"]\n'))).toEqual([
			'bunfig.toml:1:1 unchecked-import a runtime preload can register a plugin that redirects any import, trusted packages included',
		])
		expect(refusal(withConfig('bunfig.toml', '[test]\npreload = ["./setup.ts"]\n'))).toEqual([])
	})
})

describe('initialization order', () => {
	test('a const used before its declaration is refused even when nothing reads it', () => {
		const contract = edited('export const contract', "const early = { title: late }\nconst late = 'x'\n\nexport const contract")
		expect(refusal(application(contract))).toEqual([
			"fabrika.contract.ts:5:24 literal 'late' is used before its declaration, where the module cannot read it yet",
		])
	})
})

describe('the resource budget', () => {
	/** `S0 = z.string()`, then each `Si` holds the previous one twice: 2^depth nodes once expanded. */
	const exponential = (depth: number): string => {
		const lines = ["import { z } from 'zod/v4'", '', 'export const S0 = z.string()']
		for (let level = 1; level <= depth; level++) {
			lines.push(`export const S${level} = z.strictObject({ left: S${level - 1}, right: S${level - 1} })`)
		}
		return `${lines.join('\n')}\nexport const Note = S${depth}\n`
	}

	for (const depth of [16, 30]) {
		test(`a schema that doubles at each of ${depth} levels is refused at the level that crosses the budget, quickly`, () => {
			const started = performance.now()
			const findings = refusal(application(BASE, exponential(depth)))
			const elapsed = performance.now() - started

			expect(findings).toEqual([`src/schemas.ts:17:20 contract the schema expands to 32767 nodes nested 15 deep`])
			expect(elapsed).toBeLessThan(1000)
		})
	}

	test('a schema nested deeper than the limit', () => {
		const nested = `${'z.array('.repeat(CONTRACT_LIMITS.schemaDepth)}z.string()${')'.repeat(CONTRACT_LIMITS.schemaDepth)}`
		const findings = refusal(application(BASE, `import { z } from 'zod/v4'\n\nexport const Note = ${nested}\n`))
		expect(findings).toEqual([`src/schemas.ts:3:21 contract the schema expands to 33 nodes nested 33 deep`])
	})

	test('placements that together expand past the budget, though each schema fits', () => {
		const procedures = Array.from({ length: 30 }, (_, index) => `\t\tq${index}: c.query({ output: Note, access: { member: true } }),`).join('\n')
		const contract = edited('\t\tget: c.query(', `${procedures}\n\t\tget: c.query(`)
		const findings = refusal(application(contract, exponential(9)))
		expect(findings[0]).toBe("fabrika.contract.ts:31:8 contract the contract's schemas expand to over 20000 nodes")
	})

	test('source over the byte limit, and syntax nested deeper than the limit', () => {
		const padding = `// ${'x'.repeat(CONTRACT_LIMITS.sourceBytes)}\n`
		expect(refusal(application(BASE, padding + SCHEMAS))).toEqual([
			`src/schemas.ts:1:1 contract fabrika.contract.ts and its modules are over ${CONTRACT_LIMITS.sourceBytes} bytes`,
		])
		const deep = `export const Deep = ${'['.repeat(CONTRACT_LIMITS.astDepth)}${']'.repeat(CONTRACT_LIMITS.astDepth)}\n`
		expect(refusal(application(BASE, SCHEMAS + deep))).toEqual([
			`src/schemas.ts:1:1 contract the syntax nests deeper than ${CONTRACT_LIMITS.astDepth} levels`,
		])
	})
})

describe('the reader reads src/db/tables.ts into the policies @fabrika/db parses', () => {
	const SCHEMA_GENERATED = `import type { TypedColumnList } from '@fabrika/db'

export interface DB {
	notes: { id: string; workspace_id: string; title: string }
}

export const columns: TypedColumnList<DB> = { 'notes': { columns: ['id', 'workspace_id', 'title'], foreignKeys: [] } }
`
	const VOCABULARY = `import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
})
`
	const TABLES = `import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note', in: { column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write' },
		insert: ['title'],
	},
})
`
	const withTables = (tables: string, schema = SCHEMA_GENERATED): ReadonlyMap<string, string> =>
		new Map([...application(BASE), ['src/vocabulary.ts', VOCABULARY], ['src/db/tables.ts', tables], ['src/db/schema.generated.ts', schema]])

	const tableRefusal = (files: ReadonlyMap<string, string>): string[] => {
		try {
			readTablesSource(files)
		} catch (error) {
			if (error instanceof ContractSourceError) {
				return error.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}`)
			}
			throw error
		}
		return []
	}

	test('the policies of the module land in the artifact, and no tables.ts means no policies', () => {
		const artifact = readContractSource(withTables(TABLES))
		expect(artifact.tables).toEqual({
			notes: {
				scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
				actions: { read: 'notes.read', insert: 'notes.write', update: null, delete: null },
				insert: ['title'],
				update: [],
				version: null,
				createdBy: null,
				columns: {},
			},
		})
		expect(readTablesSource(application(BASE))).toEqual({})
	})

	test('defineTables from the browser-safe @fabrika/db/tables reads the same policies', () => {
		const subpath = TABLES.replace("from '@fabrika/db'", "from '@fabrika/db/tables'")
		expect(readTablesSource(withTables(subpath))).toEqual(readTablesSource(withTables(TABLES)))
	})

	test('a policy the runtime refuses is refused from source, at the defineTables call', () => {
		expect(tableRefusal(withTables(TABLES.replace("insert: ['title'],", "insrt: ['title'],")))).toEqual([
			'src/db/tables.ts:5:23 contract notes: the policy: insrt is not a field here (allowed: scope, actions, insert, update, version, createdBy, columns)',
		])
		expect(tableRefusal(withTables(TABLES.replace("column: 'workspace_id'", "column: 'workspace'")))).toEqual([
			'src/db/tables.ts:5:23 contract notes: scope.in.column names workspace, which is not a column (columns: id, workspace_id, title)',
		])
		expect(
			tableRefusal(
				withTables(TABLES, SCHEMA_GENERATED.replace('foreignKeys: [] }', "foreignKeys: [] }, 'audit': { columns: ['id'], foreignKeys: [] }")),
			),
		).toEqual([
			'src/db/tables.ts:5:23 contract audit: every table needs a policy in tables.ts',
		])
	})

	test('a tables module of another shape, a non-literal and a schema in a policy', () => {
		expect(tableRefusal(withTables(TABLES.replace('export const tables', 'export const policies')))).toEqual([
			"src/db/tables.ts:1:1 contract src/db/tables.ts exports no const 'tables'",
		])
		const allowed = (files: ReadonlyMap<string, string>): unknown[] => {
			try {
				readTablesSource(files)
			} catch (error) {
				if (error instanceof ContractSourceError) return error.findings.map((finding) => finding.allowed)
				throw error
			}
			return []
		}
		expect(allowed(withTables(TABLES.replace('export const tables', 'export const policies')))).toEqual([
			'export const tables = defineTables(vocabulary, columns)({ … })',
		])
		expect(tableRefusal(withTables(TABLES.replace('(vocabulary, columns)({', '(vocabulary, columns, columns)({')))).toEqual([
			"src/db/tables.ts:5:23 contract 'tables' is not one call of defineTables with the vocabulary and the column list, then the policies",
		])
		expect(tableRefusal(withTables(TABLES.replace('(vocabulary, columns)({', '(columns, columns)({')))).toEqual([
			'src/db/tables.ts:5:36 contract the first argument of defineTables is not the vocabulary',
		])
		expect(tableRefusal(withTables(TABLES.replace("insert: ['title'],", 'insert: [`${"title"}`],'))).map((line) => line.split(' ')[1])).toEqual([
			'literal',
		])
		const schema = TABLES.replace(
			"import { columns } from './schema.generated'",
			"import { columns } from './schema.generated'\nimport { z } from 'zod/v4'",
		)
			.replace("insert: ['title'],", 'insert: [z.string()],')
		expect(tableRefusal(withTables(schema))).toEqual(['src/db/tables.ts:10:12 contract a schema in a table policy'])
	})
})
