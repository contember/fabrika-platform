#!/usr/bin/env bun
// Generates `src/schema.generated.ts` from Zerops' PUBLISHED JSON schema for `zerops-import.yaml`.
//
// Why generated: the schema carries a 202-value service-type enum and a deeply nested inline `zerops.yaml`
// object, both of which move whenever Zerops adds a runtime version. Hand-transcribing it guarantees drift;
// regenerating is one command. The emitted file is TYPES ONLY (no runtime value), so it costs nothing.
//
//   bun packages/provider-zerops/scripts/generate-zerops-types.ts
//
// The schema is fetched live by default; pass a path to generate from a local copy instead.

import { writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEMA_URL = 'https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json'
const OUT = resolve(import.meta.dir, '../src/schema.generated.ts')

/** The subset of JSON Schema this generator understands — everything the Zerops import schema actually uses. */
interface JsonSchema {
	type?: string
	description?: string
	deprecated?: boolean
	enum?: string[]
	default?: unknown
	required?: string[]
	properties?: Record<string, JsonSchema>
	items?: JsonSchema
	additionalProperties?: boolean | JsonSchema
}

/**
 * Stable names for the object schemas we care about, keyed by their path in the document. Anything not
 * listed gets a name derived from its path, which keeps the generator total without inventing a name for
 * `project` or `services[]` that would churn.
 */
const NAMES: Record<string, string> = {
	project: 'ZeropsImportProject',
	'services[]': 'ZeropsImportService',
	'services[].verticalAutoscaling': 'ZeropsVerticalAutoscaling',
	'services[].zeropsYaml': 'ZeropsYaml',
	'services[].zeropsYaml.zerops[]': 'ZeropsYamlSetup',
	'services[].zeropsYaml.zerops[].build': 'ZeropsYamlBuild',
	'services[].zeropsYaml.zerops[].deploy': 'ZeropsYamlDeploy',
	'services[].zeropsYaml.zerops[].deploy.readinessCheck': 'ZeropsReadinessCheck',
	'services[].zeropsYaml.zerops[].run': 'ZeropsYamlRun',
	'services[].zeropsYaml.zerops[].run.healthCheck': 'ZeropsHealthCheck',
	'services[].zeropsYaml.zerops[].run.envReplace': 'ZeropsEnvReplace',
	'services[].zeropsYaml.zerops[].run.routing': 'ZeropsRouting',
	'services[].zeropsYaml.zerops[].run.routing.redirects[]': 'ZeropsRoutingRedirect',
	'services[].zeropsYaml.zerops[].run.routing.headers[]': 'ZeropsRoutingHeader',
	'services[].zeropsYaml.zerops[].run.ports[]': 'ZeropsPort',
	'services[].zeropsYaml.zerops[].run.startCommands[]': 'ZeropsStartCommand',
	'services[].zeropsYaml.zerops[].run.crontab[]': 'ZeropsCrontabEntry',
	'services[].zeropsYaml.zerops[].deploy.readinessCheck.httpGet': 'ZeropsHttpGetProbe',
	'services[].zeropsYaml.zerops[].deploy.readinessCheck.exec': 'ZeropsExecProbe',
	// The readiness and health probes are structurally identical in the schema; one name for both.
	'services[].zeropsYaml.zerops[].run.healthCheck.httpGet': 'ZeropsHttpGetProbe',
	'services[].zeropsYaml.zerops[].run.healthCheck.exec': 'ZeropsExecProbe',
	'services[].type': 'ZeropsServiceType',
}

/** Enums longer than this are hoisted into their own named alias — the service-type enum has 202 members. */
const HOIST_ENUM_AT = 8

const pascal = (path: string): string =>
	'Zerops'
	+ path
		.replace(/\[\]/g, '')
		.split('.')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('')

const nameFor = (path: string): string => NAMES[path] ?? pascal(path)

/** Collected interface bodies, keyed by name, in emission order. */
const emitted = new Map<string, string>()

const jsdoc = (schema: JsonSchema, indent: string): string => {
	const lines: string[] = []
	if (schema.description !== undefined && schema.description.trim() !== '') {
		// Descriptions are free text and occasionally contain `*/`-hostile characters; normalise whitespace.
		lines.push(...schema.description.replace(/\s+/g, ' ').trim().match(/.{1,120}(\s|$)/g)?.map((s) => s.trim()) ?? [])
	}
	if (schema.deprecated === true) {
		lines.push('@deprecated')
	}
	if (schema.default !== undefined) {
		lines.push(`Zerops default: \`${JSON.stringify(schema.default)}\`.`)
	}
	if (lines.length === 0) {
		return ''
	}
	if (lines.length === 1) {
		return `${indent}/** ${lines[0]} */\n`
	}
	return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`).join('\n')}\n${indent} */\n`
}

/** Render one schema as a TypeScript type expression, registering any object types it contains. */
const typeExpr = (schema: JsonSchema, path: string): string => {
	if (schema.enum !== undefined) {
		const members = schema.enum.map((value) => `'${value}'`)
		if (members.length < HOIST_ENUM_AT) {
			return members.join(' | ')
		}
		const name = nameFor(path)
		if (!emitted.has(name)) {
			emitted.set(name, `${jsdoc(schema, '')}export type ${name} =\n${members.map((member) => `\t| ${member}`).join('\n')}\n`)
		}
		return name
	}
	if (schema.type === 'array') {
		return `${typeExpr(schema.items ?? {}, `${path}[]`)}[]`
	}
	if (schema.type === 'object' || schema.properties !== undefined) {
		const properties = schema.properties ?? {}
		if (Object.keys(properties).length === 0) {
			// `build.cache` is declared as an object with no properties, which is a bug in the published
			// schema (the real field is a bool / string / string[]). Stay honest rather than wrong.
			if (typeof schema.additionalProperties === 'object') {
				return `Record<string, ${typeExpr(schema.additionalProperties, `${path}[k]`)}>`
			}
			return 'unknown'
		}
		return register(schema, path)
	}
	if (schema.type === 'string') {
		return 'string'
	}
	if (schema.type === 'integer' || schema.type === 'number') {
		return 'number'
	}
	if (schema.type === 'boolean') {
		return 'boolean'
	}
	// No `type` at all (e.g. `profileOverrides`): the schema genuinely says "anything".
	return 'unknown'
}

/** Register an object schema as a named interface and return that name. */
const register = (schema: JsonSchema, path: string): string => {
	const name = nameFor(path)
	if (emitted.has(name)) {
		return name
	}
	emitted.set(name, '') // reserve the name first so a recursive schema terminates
	const required = new Set(schema.required ?? [])
	const fields: string[] = []
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		const optional = required.has(key) ? '' : '?'
		// `for` / `from` are reserved-ish but legal as property names; quote only what needs quoting.
		const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key}'`
		fields.push(`${jsdoc(property, '\t')}\t${safeKey}${optional}: ${typeExpr(property, `${path}.${key}`)}`)
	}
	emitted.set(name, `${jsdoc(schema, '')}export interface ${name} {\n${fields.join('\n')}\n}\n`)
	return name
}

const main = async (): Promise<void> => {
	const source = process.argv[2]
	const raw: string = source === undefined ? await (await fetch(SCHEMA_URL)).text() : readFileSync(resolve(source), 'utf8')
	const schema: JsonSchema = JSON.parse(raw)

	const project = schema.properties?.['project']
	const service = schema.properties?.['services']?.items
	if (project === undefined || service === undefined) {
		throw new Error('generate-zerops-types: schema has no `project` / `services` properties')
	}
	register(project, 'project')
	register(service, 'services[]')

	const header = [
		'// GENERATED FILE — DO NOT EDIT BY HAND.',
		'//',
		"// Source: Zerops' published JSON schema for `zerops-import.yaml`",
		`// ${SCHEMA_URL}`,
		'//',
		'// Regenerate with `bun packages/provider-zerops/scripts/generate-zerops-types.ts`. This is a FAITHFUL',
		'// transcription of the platform contract — it is deliberately NOT the app-authoring surface.',
		'// What an app may actually declare is `./types.ts`, which subtracts the fields fabrika owns',
		'// (see ADR-0004: `envIsolation` and project-level env are compiler-owned, never authorable).',
		'',
	].join('\n')

	writeFileSync(OUT, `${header}\n${[...emitted.values()].join('\n')}`)
	console.log(`wrote ${OUT} — ${emitted.size} interfaces`)
}

await main()
