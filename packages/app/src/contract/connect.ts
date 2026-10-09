// Connectors between applications, as data: an export's description (what the owner serves and a consumer vendors),
// the vendored snapshot a consumer imports, and the one way each is read back into shapes and a digest.
// Browser-safe: the snapshot is imported by the contract, which the SPA imports.

import {
	canonicalJson,
	canonicalShape,
	type ContractArtifact,
	type ExportDescription,
	exportDigest,
	type ExportProcedureDescription,
	type SchemaShape,
} from '@fabrika/auth-core'
import { z } from 'zod/v4'
import { schemaShapeSchema } from './artifact-schema'
import { exportBase } from './defaults'
import type { InputSchema, Schema } from './define'
import { ContractError, Problems } from './problems'
import { describeSchema } from './schema-shape'

/** One vendored procedure: the zod schemas `fabrika connect add` generated from the owner's description. */
export interface SnapshotProcedure {
	readonly input: InputSchema | null
	readonly output: Schema
}

/**
 * The vendored description of another application's export, as `fabrika connect add` writes it to
 * `fabrika/connect/<app>.<export>.v<version>.ts`. The consumer passes it to `implement({ connect })` and imports its
 * digest into the contract.
 */
export interface ConnectSnapshot {
	readonly app: string
	readonly export: string
	readonly version: number
	readonly audience: string
	readonly digest: string
	/** By the procedure's dotted path in the export. */
	readonly procedures: { readonly [path: string]: SnapshotProcedure }
}

/** The description the owner serves for `name`, or `null` when the artifact declares no such export. */
export function exportDescription(artifact: ContractArtifact, name: string): ExportDescription | null {
	const declaration = Object.hasOwn(artifact.exports, name) ? artifact.exports[name] : undefined
	if (declaration === undefined) {
		return null
	}
	const prefix = `${exportBase(name, declaration.version)}.`
	const procedures: Record<string, ExportProcedureDescription> = {}
	for (const row of artifact.endpoints) {
		if (row.source.kind === 'export' && row.source.name === name && row.id.startsWith(prefix) && row.output !== null) {
			procedures[row.id.slice(prefix.length)] = { input: row.input, output: row.output }
		}
	}
	const described = { app: artifact.app, export: name, version: declaration.version, audience: declaration.audience, procedures }
	return { ...described, digest: exportDigest(described) }
}

/**
 * The description a snapshot's schemas describe now, with the digest of that. A snapshot whose recomputed digest is
 * not its own `digest` was edited after `fabrika connect add` wrote it. Throws `ContractError` for a schema outside
 * the contract subset.
 */
export function describeSnapshot(snapshot: ConnectSnapshot): ExportDescription {
	const problems = new Problems()
	const procedures: Record<string, ExportProcedureDescription> = {}
	for (const [path, procedure] of Object.entries(snapshot.procedures)) {
		const where = `snapshot ${snapshot.app}/${snapshot.export}@${snapshot.version} procedure '${path}'`
		const input = procedure.input === null ? null : describeSchema(procedure.input, `${where} input`, problems)
		const output = describeSchema(procedure.output, `${where} output`, problems)
		procedures[path] = { input, output: output ?? { type: 'null' } }
	}
	problems.throwIfAny()
	const described = { app: snapshot.app, export: snapshot.export, version: snapshot.version, audience: snapshot.audience, procedures }
	return { ...described, digest: exportDigest(described) }
}

const procedureDescription: z.ZodType<ExportProcedureDescription> = z.strictObject({
	input: schemaShapeSchema.nullable(),
	output: schemaShapeSchema,
})

/** The parser of a description another application served; the digest is checked by `parseExportDescription`. */
export const exportDescriptionSchema: z.ZodType<ExportDescription> = z.strictObject({
	app: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	export: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
	version: z.int().positive(),
	audience: z.string().min(1),
	procedures: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/), procedureDescription),
	digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
})

const DESCRIPTION_FIELDS: readonly string[] = ['app', 'export', 'version', 'audience', 'procedures', 'digest']

/** A served description, parsed, whose digest is the digest of what it describes; throws `ContractError` otherwise. */
export function parseExportDescription(value: unknown): ExportDescription {
	const parsed = exportDescriptionSchema.safeParse(value)
	if (!parsed.success) {
		// Another application wrote the value: name only the fields this parser declares and zod's fixed codes.
		const problems = parsed.error.issues.map((issue) => {
			const [top] = issue.path
			const field = typeof top === 'string' && DESCRIPTION_FIELDS.includes(top) ? top : '(root)'
			return `description: invalid at ${field} (${issue.code})`
		})
		throw new ContractError([...new Set(problems)])
	}
	const { digest, ...described } = parsed.data
	if (exportDigest(described) !== digest) {
		throw new ContractError([`description ${described.app}/${described.export}@${described.version}: its digest does not match what it describes`])
	}
	return parsed.data
}

/**
 * What an owner's change of one export version breaks for a consumer that imports `procedures` of it: a removed
 * procedure, an input that accepts less, a changed output, or a changed audience. An output may not even gain a field,
 * because the consumer parses every answer against its vendored schema, whose objects are strict; an input object may
 * gain optional fields. Every other change is a new version. Empty when the change is compatible.
 */
export function incompatibleChanges(before: ExportDescription, after: ExportDescription, procedures: readonly string[]): string[] {
	const problems: string[] = []
	if (before.audience !== after.audience) {
		problems.push('changes its audience')
	}
	for (const path of procedures) {
		const old = Object.hasOwn(before.procedures, path) ? before.procedures[path] : undefined
		const now = Object.hasOwn(after.procedures, path) ? after.procedures[path] : undefined
		// A procedure the export never had is the consumer's mistake, which its own deploy is refused for.
		if (old === undefined) {
			continue
		}
		if (now === undefined) {
			problems.push(`removes '${path}'`)
			continue
		}
		if (!acceptsEveryInput(old.input, now.input)) {
			problems.push(`'${path}' accepts less input than before`)
		}
		if (canonicalJson(canonicalShape(old.output)) !== canonicalJson(canonicalShape(now.output))) {
			problems.push(`'${path}' answers another output than before`)
		}
	}
	return problems
}

function acceptsEveryInput(before: SchemaShape | null, after: SchemaShape | null): boolean {
	if (before === null || after === null) {
		return before === after
	}
	return widens(canonicalShape(before), canonicalShape(after))
}

/** Whether `after` accepts every value `before` does, by the one widening allowed: an object field that is new and optional. */
function widens(before: SchemaShape, after: SchemaShape): boolean {
	if (before.type === 'object' && after.type === 'object') {
		const kept = Object.entries(before.fields).every(([name, field]) => {
			const next = Object.hasOwn(after.fields, name) ? after.fields[name] : undefined
			return next !== undefined && widens(field, next)
		})
		return kept && Object.entries(after.fields).every(([name, field]) => Object.hasOwn(before.fields, name) || field.type === 'optional')
	}
	if ((before.type === 'optional' && after.type === 'optional') || (before.type === 'nullable' && after.type === 'nullable')) {
		return widens(before.inner, after.inner)
	}
	return canonicalJson(before) === canonicalJson(after)
}
