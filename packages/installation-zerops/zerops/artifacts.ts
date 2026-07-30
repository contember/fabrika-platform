// The generated artifacts, as pure values: every file `render.ts` writes, computed with no filesystem
// access at all. The test suite compares these against what is on disk, so a committed artifact that has
// drifted from the declarations fails `bun test` rather than surprising an operator who applies it.
//
// Generated-but-COMMITTED is the same call the repo already makes for `wrangler.jsonc`: the artifact is
// what an operator actually feeds to the platform, so it should be reviewable in a diff — but nobody
// should hand-edit it, because the types are upstream of it.

import { renderYaml } from '@fabrika/provider-zerops'
import { resolve } from 'node:path'
import { fabrikaZeropsYaml } from './setups'
import { compileTopology, fabrikaTopologies } from './topology'

/** Repository root, from this file's own location. */
export const REPO_ROOT = resolve(import.meta.dir, '../../..')

/** One file to write, with a path relative to the repository root. */
export interface Artifact {
	/** Repo-relative, POSIX-separated. */
	path: string
	content: string
}

const banner = (lines: string[]): string => `${lines.map((line) => (line === '' ? '#' : `# ${line}`)).join('\n')}\n#\n`

const IMPORT_HEADER = (source: string, applyTo: string): string =>
	banner([
		'GENERATED FILE — DO NOT EDIT BY HAND.',
		'',
		`Source: packages/installation-zerops/zerops/${source}`,
		'Regenerate: bun run --filter @fabrika/installation-zerops gen',
		'',
		`Apply with: ${applyTo}`,
		'',
		'`envIsolation: service` at BOTH levels and the absence of any project-level `envVariables` are',
		'written by the compiler, not by the declaration, and re-checked before serialization (ADR-0004).',
	])

/**
 * The two forms every project topology is emitted in.
 *
 *   *.provision.*  every service `startWithoutCode: true`. FIRST bring-up: the services exist, so their
 *                  secrets can be written through the env API (which is addressed BY SERVICE), and only
 *                  then does anything build. This is the cost ADR-0004 accepted, paid.
 *   (plain)        steady state. Re-applying it is how a Zerops deploy is idempotent — every service
 *                  carries `override: true`, so this reconciles drift instead of colliding with it.
 */
const topologyArtifacts = (): Artifact[] =>
	fabrikaTopologies().flatMap((topology) => {
		const compiled = compileTopology(topology, 'prod')
		return [
			{
				path: `packages/installation-zerops/zerops/generated/${topology.id}.provision.zerops-import.yaml`,
				content: IMPORT_HEADER('topology.ts', 'POST /client/{clientId}/project/import  { yaml }') + compiled.provision.yaml,
			},
			{
				path: `packages/installation-zerops/zerops/generated/${topology.id}.zerops-import.yaml`,
				content: IMPORT_HEADER('topology.ts', 'POST /project/{projectId}/service-stack/import  { yaml }') + compiled.steady.yaml,
			},
		]
	})

/**
 * The repository-root `zerops.yaml`. One file, four named setups, selected by `zeropsSetup` (which
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
		"Zerops reads `zerops.yaml` from the REPOSITORY ROOT, so fabrika's four deployable services share",
		'ONE file with four named setups. A service selects its setup by name; the name defaults to the',
		'service hostname, which is why `iam`, `operations`, `control` and `proxy` below are also hostnames in',
		'packages/installation-zerops/zerops/generated/*.zerops-import.yaml.',
		'',
		'NO SECRETS AND NO PER-INSTALLATION VALUES ARE IN HERE. `${x_y}` is a REFERENCE to another',
		"service's platform-held variable, never a value. Public origins, OIDC coordinates and every",
		'secret are service-level variables written through the env API (ADR-0004).',
	]) + renderYaml(fabrikaZeropsYaml),
})

/** Every artifact this package generates, in a stable order. */
export const generatedArtifacts = (): Artifact[] => [...topologyArtifacts(), zeropsYamlArtifact()]
