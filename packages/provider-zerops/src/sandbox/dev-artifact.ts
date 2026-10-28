// What a dev workspace sandbox runs, derived from the application's artifact: the refusals of what a sandbox cannot
// give an application, the launcher's environment and configuration, and the build script. PURE — no network.

import { contractRecipe } from '@fabrika/app/build'
import { DEV_LAUNCHER_CONFIG_FILE, type DevLauncherConfig, FABRIKA_CONTRACT_DIGEST } from '@fabrika/auth-core'
import type { JsonValue, ProviderManagedEnvironment } from '@fabrika/provider-contract'
import { parseZeropsDescriptor, selectZeropsDescriptorSetup } from '../descriptor'
import { lockedAuthoredBuild, ZEROPS_APPLICATION_PORT, type ZeropsContractRun } from '../execution'
import { isObjectStorageType } from '../exposure'
import { assertAuthoredManagedDocument } from '../managed-env'
import { applicationDatabaseOf, type FabrikaManifest } from '../manifest'
import { SANDBOX_APP_ROOT, SANDBOX_DATABASE_CONNECTIONS, SANDBOX_DATABASE_URL, SANDBOX_STATE_DIR } from './constants'

const SANDBOX = 'a dev environment runs in workspace sandboxes'

const isMapping = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Refuse what a sandbox cannot give an application, one line each: object storage, the ClamAV scan, runtime packages. */
export function assertSandboxArtifact(
	manifest: FabrikaManifest,
	contract: Pick<ZeropsContractRun, 'scan'> | undefined = manifest.target.contract,
): void {
	const storage = manifest.target.importDocument.services.find((service) =>
		typeof service['type'] === 'string' && isObjectStorageType(service['type'])
	)
	if (storage !== undefined) {
		throw new Error(`zerops: ${SANDBOX}, which have no object storage; remove \`${String(storage['hostname'])}\` from the dev environment's config`)
	}
	if (contract?.scan === true) {
		throw new Error(`zerops: ${SANDBOX}, which have no ClamAV scan; the contract scans uploads (scan: true)`)
	}
	const packages = manifest.target.runtimePackages ?? []
	if (packages.length > 0) {
		throw new Error(
			`zerops: ${SANDBOX}, which install no runtime package; remove runtimePackages (${packages.join(', ')}) from the dev environment's config`,
		)
	}
}

/**
 * Replaces each value of `values` long enough to be a credential in `text`, longest first: what the sandbox prints is
 * application output, which may echo one. The launcher masks its own log the same way.
 */
export function maskValues(text: string, values: readonly string[]): string {
	let masked = text
	for (const value of [...new Set(values)].filter((value) => value.length >= 8).sort((left, right) => right.length - left.length)) {
		masked = masked.replaceAll(value, '[redacted]')
	}
	return masked
}

/** Refuse a handed variable or secret whose value holds a `${…}` reference, naming it and never its value. */
export function assertNoSandboxReferences(kind: 'variable' | 'secret', values: Readonly<Record<string, string>>): void {
	for (const [name, value] of Object.entries(values)) {
		if (value.includes('${')) throw new Error(`zerops: ${SANDBOX}, which resolve no \`\${…}\` reference; the ${kind} \`${name}\` holds one`)
	}
}

export interface SandboxEnvironmentInput {
	readonly artifact: FabrikaManifest
	readonly secrets: Readonly<Record<string, string>>
	readonly managed: ProviderManagedEnvironment
	readonly contractDigest: string
}

/**
 * The launcher's environment, as a Zerops deploy composes a service's: the secrets (on Zerops, sensitive service
 * variables), the managed values Control handed, then the literals the generated run section carries. A declared variable
 * only fills the import document, which a sandbox has none of. The local superuser stands in for the database service's,
 * as the provisioning credential of the application's role family (ADR-0017).
 */
export function sandboxEnvironment(input: SandboxEnvironmentInput): Record<string, string> {
	assertNoSandboxReferences('secret', input.secrets)
	const environment: Record<string, string> = { ...input.secrets }
	for (const [name, { value }] of Object.entries(input.managed)) {
		if (value !== null) environment[name] = value
	}
	environment['PORT'] = String(ZEROPS_APPLICATION_PORT)
	environment[FABRIKA_CONTRACT_DIGEST] = input.contractDigest
	if (applicationDatabaseOf(input.artifact) !== null) {
		environment['FABRIKA_APP_DATABASE_URL'] = SANDBOX_DATABASE_URL
		environment['FABRIKA_APP_DATABASE_CONNECTIONS'] = String(SANDBOX_DATABASE_CONNECTIONS)
	}
	return environment
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The env file the base image's launcher script sources with `set -a`: one single-quoted assignment per variable. */
export function renderSandboxEnvFile(environment: Readonly<Record<string, string>>): string {
	return Object.entries(environment).map(([name, value]) => {
		if (!VARIABLE_NAME.test(name)) throw new Error(`zerops: \`${name}\` is not a variable name a shell can assign`)
		if (value.includes('\u0000')) throw new Error(`zerops: the value of \`${name}\` holds a NUL byte`)
		return `${name}='${value.replaceAll("'", "'\\''")}'\n`
	}).join('')
}

/** The authored SPA commands of the artifact's selected setup: the only part of the authored build that survives. */
export function authoredSpaCommands(artifact: FabrikaManifest): string[] {
	const parsed = parseZeropsDescriptor(artifact.target.sourceDescriptor.contents)
	assertAuthoredManagedDocument(parsed.document)
	const selected = selectZeropsDescriptorSetup(parsed, artifact.target.zeropsSetup)
	const entries = parsed.document['zerops']
	const entry = Array.isArray(entries) ? entries.find((candidate) => isMapping(candidate) && candidate['setup'] === selected) : undefined
	if (!isMapping(entry)) throw new Error('zerops: descriptor requires setup entries')
	return lockedAuthoredBuild(entry, selected).commands
}

export interface SandboxRecipeInput {
	readonly appId: string
	readonly checkRelease: string
	readonly contract: ZeropsContractRun
}

/** `@fabrika/app/build`'s recipe in a sandbox: built and run in place, with no database at build, as on Zerops. */
export const sandboxRecipe = (input: SandboxRecipeInput) =>
	contractRecipe({
		appId: input.appId,
		checkRelease: input.checkRelease,
		sourceRoot: SANDBOX_APP_ROOT,
		runtimeRoot: SANDBOX_APP_ROOT,
		database: false,
		sourceMaps: false,
		jobs: input.contract.jobs,
		files: input.contract.files === true,
		scan: false,
	})

/** What the dev launcher reads (`DEV_LAUNCHER_CONFIG_FILE`), written after the build's checks passed. */
export function sandboxLauncherConfig(
	input: SandboxRecipeInput & { readonly head: string; readonly spaBuild: readonly string[] },
): DevLauncherConfig {
	if (!/^[0-9a-f]{40}$/.test(input.head)) throw new Error('zerops: a dev environment builds an exact commit')
	const recipe = sandboxRecipe(input)
	return {
		format: 1,
		appId: input.appId,
		head: input.head,
		port: ZEROPS_APPLICATION_PORT,
		healthPath: input.contract.readinessPath,
		serve: recipe.serve,
		migrate: recipe.migrate,
		spaBuild: input.spaBuild,
		checks: recipe.checks,
	}
}

export const SANDBOX_LAUNCHER_CONFIG_PATH = `${SANDBOX_APP_ROOT}/${DEV_LAUNCHER_CONFIG_FILE}`

const STEP_DIRECTORY = `${SANDBOX_STATE_DIR}/build`
const STEP_END = 'FABRIKA_BUILD_STEP_EOF'
const FILE_END = 'FABRIKA_BUILD_FILE_EOF'
const GENERATED_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/

const heredoc = (target: string, lines: readonly string[], end: string): string[] => {
	if (lines.includes(end)) throw new Error('zerops: a build step holds the line that ends its here-document')
	return [`cat > ${target} <<'${end}'`, ...lines, end]
}

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')

/** Writes `lines` to `target` through a quoted here-document, then checks the file holds exactly them. */
const verifiedHeredoc = (target: string, lines: readonly string[], end: string): string[] => [
	...heredoc(target, lines, end),
	`echo '${sha256(`${lines.join('\n')}\n`)}  ${target}' | sha256sum -c -s`,
]

/**
 * The generated part of the build, run as root: it writes each step to its own file (the authored SPA commands, then
 * the recipe's steps), checks each was written whole, and hands over to the uploaded runner, which runs them as the
 * unprivileged build user. Nothing here holds a credential.
 */
export function renderSandboxBuildScript(authoredSpa: readonly string[], recipe: ReturnType<typeof sandboxRecipe>, runner: string): string {
	const steps = [...authoredSpa.map((run) => ({ run })), ...recipe.build]
	const lines = [
		'#!/bin/sh',
		'# Generated by the dev sandbox deploy.',
		'set -eu',
		'exec 2>&1',
		'umask 022',
		`rm -rf ${STEP_DIRECTORY}`,
		`mkdir -p ${STEP_DIRECTORY}`,
	]
	for (const [index, step] of steps.entries()) {
		const file = `${STEP_DIRECTORY}/${index + 1}.sh`
		if ('run' in step) {
			lines.push(...verifiedHeredoc(file, step.run.split('\n'), STEP_END))
		} else {
			if (!GENERATED_PATH.test(step.write) || step.write.includes('..')) throw new Error('zerops: a generated file path is not a plain relative path')
			const slash = step.write.lastIndexOf('/')
			// The file's lines sit inside the step's here-document too, so neither delimiter may appear among them.
			if (step.lines.includes(STEP_END)) throw new Error('zerops: a build step holds the line that ends its here-document')
			const write = [...(slash < 0 ? [] : [`mkdir -p ${step.write.slice(0, slash)}`]), ...heredoc(step.write, step.lines, FILE_END)]
			lines.push(...verifiedHeredoc(file, write, STEP_END))
		}
	}
	lines.push(`exec /bin/sh ${runner} ${steps.length}`)
	return `${lines.join('\n')}\n`
}

/** One line per build step, as the run log lists them before the build starts. */
export function sandboxBuildStepLabels(authoredSpa: readonly string[], recipe: ReturnType<typeof sandboxRecipe>): string[] {
	const steps = [...authoredSpa.map((run) => ({ run })), ...recipe.build]
	return steps.map((step, index) => `${index + 1}: ${'run' in step ? (step.run.split('\n')[0] ?? '') : `write ${step.write}`}`)
}
