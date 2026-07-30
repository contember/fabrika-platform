// Validate a rendered YAML document against the PUBLISHED Zerops JSON schema for its kind.
//
// This is the strongest check available without a Zerops account, and it is worth being precise about
// what it does and does not prove. It proves the document is WELL-FORMED against the contract Zerops
// publishes: every property is one the schema knows, every enum member is real, every required field is
// present, and every conditional constraint (`postgresql:ha` profiles, per-type container and resource
// bounds) holds. It proves NOTHING about whether the platform will accept it, whether the referenced
// service variables resolve, or whether the thing boots.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Artifact } from './artifacts'
import { type SchemaViolation, unsupportedKeywords, validateAgainstSchema } from './json-schema'

/** Which contract a document is checked against. */
export type SchemaKind = 'import' | 'zerops-yaml'

const FILES: Record<SchemaKind, string> = {
	import: 'import-project-yml-json-schema.json',
	'zerops-yaml': 'zerops-yaml-json-schema.json',
}

const cache = new Map<SchemaKind, unknown>()

/** The vendored schema document. See `./schemas/refresh.ts` for where each comes from. */
export const loadSchema = (kind: SchemaKind): unknown => {
	const cached = cache.get(kind)
	if (cached !== undefined) {
		return cached
	}
	const parsed: unknown = JSON.parse(readFileSync(resolve(import.meta.dir, 'schemas', FILES[kind]), 'utf8'))
	cache.set(kind, parsed)
	return parsed
}

/**
 * Parse YAML text the way the platform would. Comments and the generated banner are stripped by the
 * parser, so a generated file is validated exactly as its payload.
 */
export const parseYaml = (text: string): unknown => Bun.YAML.parse(text)

/** Validate rendered YAML against one of the two published contracts. */
export const validateYaml = (kind: SchemaKind, text: string): SchemaViolation[] => validateAgainstSchema(loadSchema(kind), parseYaml(text))

/**
 * Which contract an artifact is checked against, from its filename. `*.zerops-import.yaml` is an import
 * document; `zerops.yaml` — at the repository root or an app's — is a build/run descriptor.
 */
export const schemaKindFor = (path: string): SchemaKind => (path.endsWith('.zerops-import.yaml') ? 'import' : 'zerops-yaml')

/** Throw with every violation listed, or return silently. Used by the generator before it writes. */
export const assertArtifactMatchesSchema = (artifact: Artifact): void => {
	const kind = schemaKindFor(artifact.path)
	const violations = validateYaml(kind, artifact.content)
	if (violations.length > 0) {
		const detail = violations.map((violation) => `  ${violation.path === '' ? '(root)' : violation.path}: ${violation.message}`).join('\n')
		throw new Error(`${artifact.path} does not match the published ${kind} schema:\n${detail}`)
	}
}

/**
 * Every keyword in a vendored schema that `./json-schema.ts` does not enforce. Must be empty for the
 * "zero errors" verdict above to be worth anything — a test asserts exactly that.
 */
export const unenforcedKeywords = (kind: SchemaKind): string[] => unsupportedKeywords(loadSchema(kind))
