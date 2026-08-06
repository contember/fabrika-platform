// The console's authorization vocabulary, rendered into a committed artifact.
//
// `platform deploy` reconciles this schema into IAM — without it the console's return origin is never
// registered and no browser can complete a login (ADR-0023). The declaration lives in the PRIVATE
// `@fabrika/control`, and this package is PUBLISHED, so the deploy command cannot import it: the same
// constraint that shaped `./proxy-manifest.ts`, answered the same way. This file is DEV-TIME ONLY, is
// excluded from the published `files`, and `gen:check` in CI is what makes the copy a fact.

import type { AppSchema, RoleDef } from '@fabrika/auth-core'
import { controlSchema } from '@fabrika/control/schema'
import type { Artifact } from './artifacts'

/** Repo-relative path of the committed schema. */
export const PLATFORM_CONSOLE_SCHEMA_PATH = 'packages/installation-zerops/zerops/generated/platform-console-schema.ts'

const HEADER = [
	'// GENERATED FILE — DO NOT EDIT BY HAND.',
	'//',
	'// Source: packages/installation-zerops/zerops/console-schema.ts',
	'// Regenerate: bun run --filter @fabrika/installation-zerops gen',
	'//',
	"// The console's authorization vocabulary — `controlSchema` in `@fabrika/control` — as DATA. A",
	'// PUBLISHED deploy command may not import the private package that declares it, and `platform deploy`',
	'// has to send this document to IAM: the schema PUT is what REGISTERS the app, and',
	'// `apps.setReturnOrigins` 404s for an app IAM has never heard of. `gen:check` is the drift witness.',
	'',
].join('\n')

/** Single-quoted for dprint, with the two characters that could end the literal escaped. */
const quote = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

/** A bare property key where the identifier grammar allows one, a quoted key otherwise. */
const key = (value: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : quote(value))

const renderRole = (roleKey: string, role: RoleDef): string[] => [
	`\t\t${key(roleKey)}: {`,
	`\t\t\tname: ${quote(role.name)},`,
	...(role.description === undefined ? [] : [`\t\t\tdescription: ${quote(role.description)},`]),
	`\t\t\tpermissions: [${role.permissions.map(quote).join(', ')}],`,
	'\t\t},',
]

/** The committed schema, as a typed module: `typecheck` then proves the artifact still fits `AppSchema`. */
export const platformConsoleSchemaArtifact = (): Artifact => {
	const schema: AppSchema = controlSchema
	const content = [
		HEADER,
		"import type { AppSchema } from '@fabrika/auth-core'",
		'',
		'export const PLATFORM_CONSOLE_APP_SCHEMA: AppSchema = {',
		'\tscopes: [',
		...schema.scopes.map((scope) => `\t\t{ type: ${quote(scope.type)}${scope.label === undefined ? '' : `, label: ${quote(scope.label)}`} },`),
		'\t],',
		'\tactions: [',
		...schema.actions.map((action) =>
			`\t\t{ action: ${quote(action.action)}${action.description === undefined ? '' : `, description: ${quote(action.description)}`} },`
		),
		'\t],',
		'\troles: {',
		...Object.entries(schema.roles).flatMap(([roleKey, role]) => renderRole(roleKey, role)),
		'\t},',
		'}',
		'',
	].join('\n')
	return { path: PLATFORM_CONSOLE_SCHEMA_PATH, content }
}
