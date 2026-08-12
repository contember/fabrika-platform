// The generated artifacts, as pure values: every file `render.ts` writes, computed with no filesystem
// access at all. The test suite compares these against what is on disk, so a committed artifact that has
// drifted from the declarations fails `bun test` rather than surprising an operator who applies it.
//
// Generated-but-COMMITTED is the same call the repo already makes for `wrangler.jsonc`: the artifact is
// what an operator actually feeds to the platform, so it should be reviewable in a diff — but nobody
// should hand-edit it, because the types are upstream of it.

import { renderYaml, type ZeropsImportDocument } from '@fabrika/provider-zerops'
import { resolve } from 'node:path'
import { fabrikaZeropsYaml } from './setups'
import { type CompiledDocument, compileTopology, fabrikaTopologies } from './topology'

/** Repository root, from this file's own location. */
export const REPO_ROOT = resolve(import.meta.dir, '../../..')

/** One file to write, with a path relative to the repository root. */
export interface Artifact {
	/** Repo-relative, POSIX-separated. */
	path: string
	content: string
}

const banner = (lines: string[]): string => `${lines.map((line) => (line === '' ? '#' : `# ${line}`)).join('\n')}\n#\n`

/**
 * Which endpoint takes THIS document, read off the document rather than off the form it was compiled in.
 *
 * A `project:` block is only valid at the endpoint that CREATES a project; the service-stack endpoint
 * imports into one that already exists. Both forms of a project-bearing topology therefore name the
 * project-import endpoint — the steady form used to claim the other one, which was wrong in the file's
 * own first instruction.
 */
const applyTo = (document: ZeropsImportDocument): string =>
	document.project === undefined
		? 'POST /project/{projectId}/service-stack/import  { yaml }'
		: 'POST /client/{clientId}/project/import  { yaml }'

/**
 * ADR-0004's line, told truthfully for each shape.
 *
 * A services-only document sets no project-level isolation and cannot: `envIsolation` is settable at
 * project CREATION only. The per-service value the compiler writes overrides the project's, which is
 * what makes dropping the block safe — but the project it lands in still has to have been created right,
 * and nothing in this document can check that.
 */
const isolationNote = (document: ZeropsImportDocument): string[] =>
	document.project === undefined
		? [
			'`envIsolation: service` on EVERY service is written by the compiler, not by the declaration, and',
			"re-checked before serialization; a service-level value overrides the project's (ADR-0004). This",
			'document sets NO project-level isolation and cannot — the field is settable at project CREATION',
			'only, so the project this is imported into must already carry `envIsolation: service`.',
		]
		: [
			'`envIsolation: service` at BOTH levels and the absence of any project-level `envVariables` are',
			'written by the compiler, not by the declaration, and re-checked before serialization (ADR-0004).',
		]

const IMPORT_HEADER = (source: string, document: ZeropsImportDocument, notes: string[]): string =>
	banner([
		'GENERATED FILE — DO NOT EDIT BY HAND.',
		'',
		`Source: packages/installation-zerops/zerops/${source}`,
		'Regenerate: bun run --filter @fabrika/installation-zerops gen',
		'',
		`Apply with: ${applyTo(document)}`,
		'',
		...isolationNote(document),
		...notes,
	])

/**
 * The step applying this file does NOT perform, stated in the file itself.
 *
 * `enableSubdomainAccess: true` is accepted by the import and then silently dropped — live-verified, on a
 * service the document creates as well as on one it overrides. An operator who applies a subdomain
 * topology and stops there gets a project with no public entry point and no error, which is the one
 * outcome worth spending header lines on. (The namespace lifecycle makes this call itself; the platform
 * installation has no such driver, so here it is a hand step.)
 */
const publicAccessNote = (publicService: string): string[] => [
	'',
	`APPLYING THIS FILE PUBLISHES NOTHING. \`enableSubdomainAccess: true\` on \`${publicService}\` is a`,
	'declaration of intent that the platform accepts and drops; the service reads back',
	`\`subdomainAccess: false\`. Once \`${publicService}\` has deployed an HTTP port, publish it with`,
	'`PUT /service-stack/{id}/enable-subdomain-access` and confirm `subdomainAccess: true` on the service.',
]

/**
 * The forms every project topology is emitted in.
 *
 *   *.provision.*  every service `startWithoutCode: true`. FIRST bring-up: the services exist, so their
 *                  secrets can be written through the env API (which is addressed BY SERVICE), and only
 *                  then does anything build. This is the cost ADR-0004 accepted, paid.
 *   (plain)        steady state. Re-applying it is how a Zerops deploy is idempotent — every service
 *                  carries `override: true`, so an existing hostname is tolerated rather than a
 *                  collision. It does NOT reconcile: a changed field in this document is ignored.
 *   *.services.*   the same two, with no `project:` block, for a project the OPERATOR created. Emitted
 *                  only for a topology that declares a `servicesTarget`.
 */
const topologyArtifacts = (): Artifact[] =>
	fabrikaTopologies().flatMap((topology) => {
		const compiled = compileTopology(topology, 'prod')
		const subdomain = compiled.steady.document.services.find((service) => service.enableSubdomainAccess === true)
		const notes = subdomain === undefined ? [] : publicAccessNote(subdomain.hostname)
		const forms: Array<{ suffix: string; form: CompiledDocument }> = [
			{ suffix: '.provision', form: compiled.provision },
			{ suffix: '', form: compiled.steady },
			...(compiled.servicesProvision === undefined ? [] : [{ suffix: '.services.provision', form: compiled.servicesProvision }]),
			...(compiled.servicesSteady === undefined ? [] : [{ suffix: '.services', form: compiled.servicesSteady }]),
		]
		return forms.map(({ suffix, form }) => ({
			path: `packages/installation-zerops/zerops/generated/${topology.id}${suffix}.zerops-import.yaml`,
			content: IMPORT_HEADER('topology.ts', form.document, notes) + form.yaml,
		}))
	})

/**
 * The repository-root `zerops.yaml`. One file, five named setups, selected by `zeropsSetup` (which
 * defaults to the service hostname) — see `./setups.ts` for why this rather than inline `zeropsYaml`.
 */
const zeropsYamlArtifact = (): Artifact => ({
	path: 'zerops.yaml',
	content: banner([
		'GENERATED FILE — DO NOT EDIT BY HAND.',
		'',
		'Source: packages/installation-zerops/zerops/setups.ts  (which is where the per-field commentary lives)',
		'Regenerate: bun run --filter @fabrika/installation-zerops gen',
		'',
		"Zerops reads `zerops.yaml` from the REPOSITORY ROOT, so fabrika's five deployable services share",
		'ONE file with five named setups. A service selects its setup by name; the name defaults to the',
		'service hostname, which is why `iam`, `operations`, `source`, `proxy` and `control` below are also hostnames in',
		'packages/installation-zerops/zerops/generated/*.zerops-import.yaml.',
		'',
		'NO SECRETS AND NO PER-INSTALLATION VALUES ARE IN HERE — including no `${x_y}` reference to a',
		'DATA service, because which data services exist differs between the standard and light tiers.',
		'Database and object-storage coordinates, public origins, auth/email coordinates, ENVIRONMENT and every',
		'secret are service-level variables written through the env API (ADR-0004).',
	]) + renderYaml(fabrikaZeropsYaml),
})

/** Every artifact this package generates, in a stable order. */
export const generatedArtifacts = (): Artifact[] => [...topologyArtifacts(), zeropsYamlArtifact()]
