// `compileContract`: the evaluated contract → its declaration with every zod schema read as a `SchemaShape` →
// `buildArtifact`. A reader of source produces the same declaration and calls `buildArtifact` itself.

import type { ContractArtifact, SchemaShape, TablePolicyArtifact } from '@fabrika/auth-core'
import { buildArtifact } from './build'
import {
	type ContractDeclaration,
	type ExportDeclaration,
	isProcedure,
	type MountDeclaration,
	type ProcedureDeclaration,
	type ProcedureTreeDeclaration,
	SURFACE_SECTIONS,
	type SurfaceSection,
} from './declaration'
import type { AnyContract, AnyMount, Schema, Surface } from './define'
import { Problems } from './problems'
import { describeSchema } from './schema-shape'

/**
 * The normalized artifact of a contract and its table policies. Until `@fabrika/db` exposes its policies as data
 * (A8b), `tables` is the artifact form of each table policy.
 */
export function compileContract(contract: AnyContract, tables: Readonly<Record<string, TablePolicyArtifact>>): ContractArtifact {
	return buildArtifact(describeContract(contract), tables)
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
			problems.add(`mount '${name}'`, 'is not a mount (allowed: c.rpc, c.link, c.spa, c.health, c.form or c.webhook)')
		}
	}
	const exports: Record<string, ExportDeclaration<SchemaShape>> = {}
	for (const [name, declaration] of Object.entries(surface.exports ?? {})) {
		exports[name] = { ...declaration, procedures: reader.tree(`export '${name}'`, declaration.procedures) }
	}
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
	}
}

const SECTIONS: ReadonlySet<string> = new Set(SURFACE_SECTIONS)

function isSection(name: string): name is SurfaceSection {
	return SECTIONS.has(name)
}

const MOUNT_KINDS: ReadonlySet<string> = new Set(['rpc', 'link', 'spa', 'health', 'form', 'webhook'])

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
			case 'form':
				return { ...mount, input: this.schema(`${where} input`, mount.input) }
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
					output: this.schema(`${at} output`, node.output),
				}
			} else {
				described[name] = this.tree(where, node, path)
			}
		}
		return described
	}

	/** A failed schema leaves a placeholder; `describeContract` throws before anything reads it. */
	schema(where: string, schema: Schema): SchemaShape {
		return describeSchema(schema, where, this.#problems) ?? { type: 'null' }
	}
}
