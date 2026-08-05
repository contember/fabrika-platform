// Validate a rendered YAML document against the PUBLISHED Zerops JSON schema for its kind.
//
// This is the strongest check available without a Zerops account, and it is worth being precise about
// what it does and does not prove. It proves the document is WELL-FORMED against the contract Zerops
// publishes: every property is one the schema knows, every enum member is real, every required field is
// present, and every conditional constraint (`postgresql:ha` profiles, per-type container and resource
// bounds) holds. It proves NOTHING about whether the platform will accept it, whether the referenced
// service variables resolve, or whether the thing boots.
//
// And the two are not the same thing: the published `zerops.yaml` schema is provably WRONG about the six
// probe durations, so this file corrects them before validating. See `DURATION_POINTERS`.

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

/**
 * The one place the published schema is knowingly wrong, and the platform proves it.
 *
 * All six probe durations are published as `integer`. Send an integer and the platform's own validator
 * (`POST /service-stack/zerops-yaml-validation`) answers `yamlValidationInvalidYaml` with
 * `cannot unmarshal !!int into time.Duration`; send `"30s"` and it accepts. So a document that satisfies
 * the published contract is undeployable, and the contract loses — this repository's rule is that the
 * account is the authority and the documentation is a hypothesis.
 *
 * Kept as an explicit pointer list, and applied by `correct()` below, which THROWS if a pointer no
 * longer holds the value it is correcting. That is the same bargain `unsupportedKeywords()` makes: the
 * day Zerops publishes `string` here, the generator fails loudly instead of quietly masking the change.
 */
const DURATION_POINTERS: Record<SchemaKind, string[]> = {
	import: [],
	'zerops-yaml': [
		'/properties/zerops/items/properties/deploy/properties/readinessCheck/properties/failureTimeout',
		'/properties/zerops/items/properties/deploy/properties/readinessCheck/properties/retryPeriod',
		'/properties/zerops/items/properties/run/properties/healthCheck/properties/failureTimeout',
		'/properties/zerops/items/properties/run/properties/healthCheck/properties/disconnectTimeout',
		'/properties/zerops/items/properties/run/properties/healthCheck/properties/recoveryTimeout',
		'/properties/zerops/items/properties/run/properties/healthCheck/properties/execPeriod',
	],
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Retype one published `integer` property as `string`, refusing if it is no longer an `integer`. */
const correct = (schema: unknown, pointer: string): void => {
	let node: unknown = schema
	for (const segment of pointer.slice(1).split('/')) {
		if (!isRecord(node)) {
			throw new Error(`zerops schema correction: \`${pointer}\` does not resolve — the published schema has moved`)
		}
		node = node[segment]
	}
	if (!isRecord(node) || node['type'] !== 'integer') {
		throw new Error(
			`zerops schema correction: \`${pointer}\` is no longer \`type: integer\` — re-check whether the platform still wants a duration string`,
		)
	}
	node['type'] = 'string'
}

/** The vendored schema document, with the corrections above applied. See `./schemas/refresh.ts` for its source. */
export const loadSchema = (kind: SchemaKind): unknown => {
	const cached = cache.get(kind)
	if (cached !== undefined) {
		return cached
	}
	const parsed: unknown = JSON.parse(readFileSync(resolve(import.meta.dir, 'schemas', FILES[kind]), 'utf8'))
	for (const pointer of DURATION_POINTERS[kind]) {
		correct(parsed, pointer)
	}
	cache.set(kind, parsed)
	return parsed
}

/** The pointers `loadSchema` retypes, so a test can assert the correction is still needed and still narrow. */
export const correctedSchemaPointers = (kind: SchemaKind): string[] => [...DURATION_POINTERS[kind]]

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
