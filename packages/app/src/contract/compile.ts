// `compileContract`: the evaluated contract → its declaration with every zod schema read as a `SchemaShape` →
// `buildArtifact`. A reader of source produces the same declaration and calls `buildArtifact` itself.

import type { ContractArtifact, SchemaShape, TablePolicyArtifact } from '@fabrika/auth-core'
import { isTables, tablePolicies, type Tables } from '@fabrika/db/tables'
import { z } from 'zod/v4'
import { attachmentOf } from './attachment'
import { buildArtifact } from './build'
import {
	type AttachmentDeclaration,
	type ContractDeclaration,
	type ExportDeclaration,
	isProcedure,
	type MountDeclaration,
	type ProcedureDeclaration,
	type ProcedureTreeDeclaration,
	type RedirectDeclaration,
	SURFACE_SECTIONS,
	type SurfaceSection,
} from './declaration'
import type { AnyContract, AnyMount, Schema, Surface } from './define'
import { Problems } from './problems'
import { redirectOf } from './redirect'
import { describeSchema } from './schema-shape'

/**
 * The normalized artifact of a contract and its table policies: what `defineTables` returned (`src/db/tables.ts`),
 * or the artifact form of each policy.
 */
export function compileContract<DB, P>(
	contract: AnyContract,
	tables: Tables<DB, P> | Readonly<Record<string, TablePolicyArtifact>>,
): ContractArtifact {
	const described = describeContract(contract)
	return buildArtifact(described, isTables(tables) ? tablePolicies(tables) : tables)
}

/** The contract with its schemas read as shapes; throws `ContractError` for a schema outside the subset. */
export function describeContract(contract: AnyContract): ContractDeclaration<SchemaShape> {
	const problems = new Problems()
	const reader = new SchemaReader(problems)
	const { surface, vocabulary } = contract
	const mounts: Record<string, MountDeclaration<SchemaShape>> = {}
	for (const [name, entry] of Object.entries(surface)) {
		if (isSection(name)) {
			continue
		}
		if (isMount(entry)) {
			mounts[name] = reader.mount(name, entry)
		} else {
			problems.add(`mount '${name}'`, 'is not a mount (allowed: c.rpc, c.link, c.spa, c.health or app.webhook)')
		}
	}
	const exports: Record<string, ExportDeclaration<SchemaShape>> = {}
	for (const [name, declaration] of Object.entries(surface.exports ?? {})) {
		exports[name] = { ...declaration, procedures: reader.tree(`export '${name}'`, declaration.procedures) }
	}
	const tokens = surface.tokens === undefined
		? undefined
		: Object.fromEntries(
			Object.entries(surface.tokens).map(([purpose, declared]) => [purpose, {
				claims: reader.schema(`token '${purpose}' claims`, declared.claims),
				maxDays: declared.maxDays,
			}]),
		)
	problems.throwIfAny()
	return {
		app: vocabulary.app,
		dimensions: vocabulary.dimensions,
		actions: vocabulary.actions,
		roles: vocabulary.roles,
		mounts,
		files: surface.files ?? {},
		jobs: surface.jobs ?? {},
		exports,
		imports: surface.imports ?? {},
		csp: surface.csp ?? {},
		...(tokens === undefined ? {} : { tokens }),
		...(vocabulary.locale === undefined ? {} : { locale: vocabulary.locale }),
		...(vocabulary.displayName === undefined ? {} : { displayName: vocabulary.displayName }),
		...(vocabulary.mail === undefined ? {} : { mail: vocabulary.mail }),
		...(vocabulary.members === undefined ? {} : { members: vocabulary.members }),
		...(vocabulary.directory === undefined ? {} : { directory: vocabulary.directory }),
		...(vocabulary.terminal === undefined ? {} : { terminal: { identify: vocabulary.terminal.identify } }),
	}
}

const SECTIONS: ReadonlySet<string> = new Set(SURFACE_SECTIONS)

function isSection(name: string): name is SurfaceSection {
	return SECTIONS.has(name)
}

const MOUNT_KINDS: ReadonlySet<string> = new Set(['rpc', 'link', 'spa', 'health', 'webhook'])

function isMount(entry: Surface[string]): entry is AnyMount {
	return typeof entry === 'object' && 'kind' in entry && typeof entry.kind === 'string' && MOUNT_KINDS.has(entry.kind)
}

class SchemaReader {
	readonly #problems: Problems

	constructor(problems: Problems) {
		this.#problems = problems
	}

	mount(name: string, mount: AnyMount): MountDeclaration<SchemaShape> {
		const where = `mount '${name}'`
		switch (mount.kind) {
			case 'rpc':
				return { ...mount, procedures: this.tree(where, mount.procedures) }
			case 'link':
				return { ...mount, procedures: this.tree(where, mount.procedures) }
			case 'webhook':
				return { ...mount, input: this.schema(`${where} input`, mount.input) }
			default:
				return mount
		}
	}

	tree<Access>(where: string, tree: ProcedureTreeDeclaration<Schema, Access>, prefix = ''): ProcedureTreeDeclaration<SchemaShape, Access> {
		const described: Record<string, ProcedureDeclaration<SchemaShape, Access> | ProcedureTreeDeclaration<SchemaShape, Access>> = {}
		for (const [name, node] of Object.entries(tree)) {
			const path = prefix === '' ? name : `${prefix}.${name}`
			if (isProcedure(node)) {
				const at = `${where} procedure '${path}'`
				described[name] = {
					...node,
					input: node.input === null ? null : this.schema(`${at} input`, node.input),
					...this.output(`${at} output`, node.output),
					...(node.http === undefined ? {} : { http: this.http(`${at} http.query`, node.http) }),
				}
			} else {
				described[name] = this.tree(where, node, path)
			}
		}
		return described
	}

	/** `http` as written, its `query` schema described; `buildArtifact` checks the rest. */
	http(where: string, http: unknown): unknown {
		if (typeof http !== 'object' || http === null) {
			return http
		}
		const query: unknown = Reflect.get(http, 'query')
		return isSchema(query) ? { ...http, query: this.schema(where, query) } : http
	}

	/**
	 * An `attachment()` output is described as the rows' array, its declaration carried beside it; a `redirect()` as its
	 * `{ to }` schema, its origins beside it.
	 */
	output(
		where: string,
		schema: Schema,
	): { readonly output: SchemaShape; readonly attachment?: AttachmentDeclaration; readonly redirect?: RedirectDeclaration } {
		const target = redirectOf(schema)
		if (target !== null) {
			return { output: this.schema(where, schema), redirect: { origins: [...target.origins] } }
		}
		const mark = attachmentOf(schema)
		if (mark === null) {
			return { output: this.schema(where, schema) }
		}
		const row = this.schema(`${where} row`, mark.row)
		return { output: { type: 'array', items: row, minItems: null, maxItems: null }, attachment: mark.declaration }
	}

	/** A failed schema leaves a placeholder; `describeContract` throws before anything reads it. */
	schema(where: string, schema: Schema): SchemaShape {
		return describeSchema(schema, where, this.#problems) ?? { type: 'null' }
	}
}

/** Whether `value` is a zod schema: what a contract writes where a schema stands. */
function isSchema(value: unknown): value is Schema {
	return value instanceof z.ZodType
}
