import type { SchemaReconciler } from '@fabrika/provider-contract'
import { resolve } from 'node:path'
import { type Definition, deploy as oblakaDeploy, type DeployResult as OblakaDeployResult } from 'oblaka-iac'
import { type CloudflareAppConfig, isCloudflareAppConfig } from './authoring'
import { defaultReconcileSchema } from './schema'

export interface CommandSpec {
	readonly command: string
	readonly args: string[]
	readonly cwd: string
	readonly env?: Record<string, string>
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

export interface LoadedCloudflareConfig {
	readonly config: CloudflareAppConfig
	readonly cwd: string
}

export type CloudflareConfigLoader = (cwd: string, configPath: string) => Promise<LoadedCloudflareConfig>

export interface CloudflareCollaborators {
	readonly loadConfig: CloudflareConfigLoader
	readonly runCommand: CommandRunner
	readonly provision: OblakaProvisioner
	readonly reconcileSchema: SchemaReconciler
}

const defaultLoadConfig: CloudflareConfigLoader = async (cwd, configPath) => {
	const absolute = resolve(cwd, configPath)
	const loaded: unknown = await import(absolute)
	if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || !isCloudflareAppConfig(loaded.default)) {
		throw new Error(`Cloudflare config at ${absolute} must export a valid default defineApp(...) value`)
	}
	return { config: loaded.default, cwd: resolve(absolute, '..') }
}

const defaultRunCommand: CommandRunner = async (spec) => {
	const proc = Bun.spawn([spec.command, ...spec.args], {
		cwd: spec.cwd,
		env: { ...process.env, ...spec.env },
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

export const defaultCloudflareCollaborators: CloudflareCollaborators = {
	loadConfig: defaultLoadConfig,
	runCommand: defaultRunCommand,
	provision: defaultProvision,
	reconcileSchema: defaultReconcileSchema,
}

export type { SchemaReconciler }
