// The validator's own credibility check.
//
// Everything else in this directory rests on "zero errors against the published schema", which is only
// worth something if the validator actually enforces the schema rather than skipping the parts it does
// not understand. So: prove the keyword coverage is complete, and prove each interesting keyword class
// really bites on the REAL Zerops document rather than on a toy one.

import { describe, expect, test } from 'bun:test'
import { unsupportedKeywords, validateAgainstSchema } from '../json-schema'
import { loadSchema, parseYaml, unenforcedKeywords, validateYaml } from '../validate'

/** A minimal valid import document, used as the baseline every negative case perturbs. */
const VALID = {
	project: { name: 'p', envIsolation: 'service', corePackage: 'SERIOUS' },
	services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: 'service', override: true }],
}

const importErrors = (document: unknown): string[] =>
	validateAgainstSchema(loadSchema('import'), document).map((violation) => `${violation.path}: ${violation.message}`)

describe('the validator implements every keyword the vendored schemas use', () => {
	test('the import schema uses no keyword this validator ignores', () => {
		expect(unenforcedKeywords('import')).toEqual([])
	})

	test('the zerops.yaml schema uses no keyword this validator ignores', () => {
		expect(unenforcedKeywords('zerops-yaml')).toEqual([])
	})

	test('and the coverage check itself is not vacuous — an unimplemented keyword IS reported', () => {
		expect(unsupportedKeywords({ properties: { a: { pattern: '^x$', minItems: 1 } } })).toEqual(['minItems', 'pattern'])
	})
})

describe('each keyword class bites, checked against the real published schema', () => {
	test('the baseline document is valid', () => {
		expect(importErrors(VALID)).toEqual([])
	})

	test('required: a service without a hostname is rejected', () => {
		expect(importErrors({ services: [{ type: 'alpine/bun@1.3' }] })).toEqual(['services[0]: missing required property `hostname`'])
	})

	test('additionalProperties: an invented field is rejected rather than ignored', () => {
		expect(importErrors({ ...VALID, services: [{ ...VALID.services[0], enableSubdomainAcces: true }] })).toEqual([
			'services[0].enableSubdomainAcces: unknown property (additionalProperties: false)',
		])
	})

	test('enum: a service type that does not exist is rejected — 202 real values, and this is not one', () => {
		const errors = importErrors({ services: [{ hostname: 'api', type: 'alpine/bun@9.9' }] })
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain('is not one of the')
	})

	test('type: a string where a number belongs is rejected', () => {
		expect(importErrors({ services: [{ hostname: 'api', type: 'alpine/bun@1.3', priority: 'high' }] })).toEqual([
			'services[0].priority: expected type integer, got string',
		])
	})

	test('if/then + maximum: the per-service-type container bound is enforced', () => {
		// `alpine/bun@1.3` falls into the runtime branch, whose maxContainers is capped at 10.
		expect(importErrors({ services: [{ hostname: 'api', type: 'alpine/bun@1.3', maxContainers: 40 }] })).toEqual([
			'services[0].maxContainers: 40 > maximum 10',
		])
	})

	test('if/then + $ref: a PostgreSQL autoscaling profile that belongs to another engine is rejected', () => {
		// `hobby` is a valkey profile; postgresql:ha@18 resolves `$ref: #/$defs/postgresql_ha_profiles`.
		const errors = importErrors({ services: [{ hostname: 'db', type: 'postgresql:ha@18', profile: 'hobby' }] })
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain('services[0].profile')
	})

	test('not: `profileOverrides` alongside a NON-custom PostgreSQL profile is rejected', () => {
		const errors = importErrors({ services: [{ hostname: 'db', type: 'postgresql:ha@18', profile: 'oltp-production', profileOverrides: { cpu: 2 } }] })
		expect(errors.some((error) => error.includes('`not` schema'))).toBe(true)
	})
})

describe('YAML parsing is the platform-shaped path', () => {
	test('a generated banner is comment-only and does not reach the document', () => {
		expect(parseYaml('# a comment\n#\nservices:\n  - hostname: api\n    type: alpine/bun@1.3\n')).toEqual({
			services: [{ hostname: 'api', type: 'alpine/bun@1.3' }],
		})
	})

	test('validateYaml routes text through the parser and the schema together', () => {
		expect(validateYaml('import', 'services:\n  - hostname: api\n    type: nope\n')).toHaveLength(1)
	})
})
