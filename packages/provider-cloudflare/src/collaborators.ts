import type { SchemaReconciler } from '@fabrika/provider-contract'
import { RUNNER_OUTCOME_FILE_ENV, type RunnerOutcomeFile } from '@fabrika/runner-contract'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Definition, deploy as oblakaDeploy, type DeployResult as OblakaDeployResult } from 'oblaka-iac'
import { type CloudflareAppConfig, isCloudflareAppConfig } from './authoring'

export interface CommandSpec {
	readonly command: string
	readonly args: string[]
	readonly cwd: string
	readonly env?: Record<string, string>
	/** Names dropped from the INHERITED environment: a child that runs checkout code gets no platform credential. */
	readonly omitEnv?: readonly string[]
	readonly stdin?: string
	readonly signal?: AbortSignal
}

export interface CommandResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>

export interface ProvisionInput {
	readonly definition: Definition
	readonly accountId: string
	readonly apiToken: string
	readonly env: string
	readonly cwd: string
	readonly stateNamespace: string
	readonly dryRun: boolean
}

export type OblakaProvisioner = (input: ProvisionInput) => Promise<OblakaDeployResult>

/** Hand the run's outcome back to the runner, which folds it into the terminal status the control plane reads. */
export type OutcomeWriter = (outcome: RunnerOutcomeFile) => Promise<void>

export interface LoadedCloudflareConfig {
	readonly config: CloudflareAppConfig
	readonly cwd: string
}

export type CloudflareConfigLoader = (cwd: string, configPath: string) => Promise<LoadedCloudflareConfig>

export interface CloudflareCollaborators {
	readonly loadConfig: CloudflareConfigLoader
	readonly runCommand: CommandRunner
	readonly provision: OblakaProvisioner
	readonly writeOutcome: OutcomeWriter
}

export const loadCloudflareConfig = async (cwd: string, configPath: string): Promise<LoadedCloudflareConfig & { readonly absolutePath: string }> => {
	const absolutePath = resolve(cwd, configPath)
	const loaded: unknown = await import(absolutePath)
	if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || !isCloudflareAppConfig(loaded.default)) {
		throw new Error(`Cloudflare config at ${absolutePath} must export a valid default defineApp(...) value`)
	}
	return { config: loaded.default, absolutePath, cwd: resolve(absolutePath, '..') }
}

const defaultLoadConfig: CloudflareConfigLoader = async (cwd, configPath) => {
	const loaded = await loadCloudflareConfig(cwd, configPath)
	return { config: loaded.config, cwd: loaded.cwd }
}

const childEnvironment = (spec: CommandSpec): Record<string, string | undefined> => {
	const inherited: Record<string, string | undefined> = { ...process.env }
	for (const name of spec.omitEnv ?? []) {
		delete inherited[name]
	}
	return { ...inherited, ...spec.env }
}

const defaultRunCommand: CommandRunner = async (spec) => {
	const proc = Bun.spawn([spec.command, ...spec.args], {
		cwd: spec.cwd,
		env: childEnvironment(spec),
		stdin: spec.stdin === undefined ? 'inherit' : new TextEncoder().encode(spec.stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const kill = (): void => {
		proc.kill()
	}
	if (spec.signal?.aborted === true) {
		kill()
	}
	spec.signal?.addEventListener('abort', kill, { once: true })
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		return { exitCode, stdout, stderr }
	} finally {
		spec.signal?.removeEventListener('abort', kill)
	}
}

const defaultProvision: OblakaProvisioner = (input) =>
	oblakaDeploy(input.definition, {
		accountId: input.accountId,
		apiToken: input.apiToken,
		env: input.env,
		cwd: input.cwd,
		stateNamespace: input.stateNamespace,
		remote: !input.dryRun,
		dryRun: input.dryRun,
	})

const defaultWriteOutcome: OutcomeWriter = async (outcome) => {
	const path = process.env[RUNNER_OUTCOME_FILE_ENV]
	if (path === undefined || path === '') {
		throw new Error(`${RUNNER_OUTCOME_FILE_ENV} is not set: this run has nowhere to report its outcome`)
	}
	await writeFile(path, JSON.stringify(outcome), 'utf8')
}

export const defaultCloudflareCollaborators: CloudflareCollaborators = {
	loadConfig: defaultLoadConfig,
	runCommand: defaultRunCommand,
	provision: defaultProvision,
	writeOutcome: defaultWriteOutcome,
}

export type { SchemaReconciler }
