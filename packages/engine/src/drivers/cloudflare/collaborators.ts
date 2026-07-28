// The CLOUDFLARE driver's side-effecting collaborators, behind injectable interfaces — the ONE seam
// where every effect this driver has lives. It is a construction parameter of the driver, not of
// `deploy()` (ADR-0009): a shell runner, an oblaka provisioner and a propustka reconciler are
// meaningful on Cloudflare and meaningless to a driver that is five HTTP calls, so handing them to
// every driver would be a lie in the type system. A second driver is constructed with its own bundle.
//
// This is also what makes the driver testable and what makes a true dry-run possible: the driver
// decides what to skip, the collaborators just do what they're told. Production wires the real
// implementations below; tests pass fakes via `createCloudflareDriver(fakes)`.

import { type Definition, deploy as oblakaDeploy, type DeployResult as OblakaDeployResult } from 'oblaka-iac'
import { defaultReconcileSchema, type SchemaReconciler } from '../shared/schema'

/** A single shell-out: the command + its argv, the cwd, extra env, and optional stdin. */
export interface CommandSpec {
	/** Executable to run, e.g. `wrangler` or `bun`. */
	command: string
	/** Arguments, already split (never a single shell string — no shell, no injection). */
	args: string[]
	/** Working directory to run in. */
	cwd: string
	/** Extra environment variables layered over the parent process env. */
	env?: Record<string, string>
	/** Optional stdin piped to the child (used to feed secret values to `wrangler secret put`). */
	stdin?: string
	/** Cancellation for this child: when it fires the process is killed rather than waited out. */
	signal?: AbortSignal
}

/** The outcome of a shell-out. The runner resolves (never rejects) so the driver owns failure. */
export interface CommandResult {
	/** Process exit code (`0` is success). */
	exitCode: number
	/** Captured stdout. */
	stdout: string
	/** Captured stderr. */
	stderr: string
}

/** Runs shell commands (build + every `wrangler …`). The default impl spawns via Bun. */
export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>

/** What the driver asks of oblaka: provision a resource graph and hand back the wrangler config. */
export interface ProvisionInput {
	definition: Definition
	accountId: string
	apiToken: string
	env: string
	cwd: string
	/** oblaka state KV namespace name (per-app, e.g. `poplach-state`) so apps in one account don't collide. */
	stateNamespace: string
	/** When set, oblaka runs in plan-only mode (no remote, nothing written to disk). */
	dryRun: boolean
}

/** Provisions resources via oblaka. The default impl calls oblaka's programmatic `deploy()`. */
export type OblakaProvisioner = (input: ProvisionInput) => Promise<OblakaDeployResult>

// Reconciling the authz schema is PORTABLE (ADR-0002) — it talks to propustka, not to Cloudflare — so the
// interface and its real implementation are shared with every other driver (`../shared/schema`).
export type { SchemaReconciler }

/**
 * The full bundle of collaborators the CLOUDFLARE driver depends on. Tests substitute any subset by
 * spreading `defaultCloudflareCollaborators`.
 */
export interface CloudflareCollaborators {
	runCommand: CommandRunner
	provision: OblakaProvisioner
	reconcileSchema: SchemaReconciler
}

// ── default (real) implementations ─────────────────────────────────────────────

/** Spawn a child process via Bun, capturing stdout/stderr; resolves with the exit code. */
const defaultRunCommand: CommandRunner = async (spec) => {
	const proc = Bun.spawn([spec.command, ...spec.args], {
		cwd: spec.cwd,
		env: { ...process.env, ...spec.env },
		stdin: spec.stdin === undefined ? 'inherit' : new TextEncoder().encode(spec.stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	// Cancellation kills the child rather than letting a `wrangler deploy` run to completion after the
	// run was abandoned. The signal may already be aborted (a race with the orchestrator) — kill now.
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
		// A real provision writes wrangler.jsonc + mutates Cloudflare; a dry-run does neither.
		remote: !input.dryRun,
		dryRun: input.dryRun,
	})

/** The production bundle: real Bun spawn + real oblaka + real propustka. */
export const defaultCloudflareCollaborators: CloudflareCollaborators = {
	runCommand: defaultRunCommand,
	provision: defaultProvision,
	reconcileSchema: defaultReconcileSchema,
}
