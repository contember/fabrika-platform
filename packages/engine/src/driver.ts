// The PLATFORM seam (ADR-0002, refined by ADR-0009). A `DeployDriver` OWNS THE PLAN: which steps a
// deploy to its target consists of, in what order, and what each one does. The engine (`deploy.ts`)
// only executes what a driver hands it — it never reads a step's `kind` and never assumes a step
// exists — so a driver is free to emit a different SET of steps in a different ORDER, not merely
// different implementations of the same six. (On Zerops, build+deploy are one platform-side step,
// migrations are a container-start hook, and secrets are written at edit time; that plan shares no
// shape with Cloudflare's.)
//
// A driver is bound to ONE target variant: `DeployDriver<'cloudflare'>` receives a run whose
// `ctx.target` is already narrowed to `CloudflareTarget`, so it reads its own credentials with no
// check and cannot be handed another platform's. The discriminant is what selects it (`DriverRegistry`).
//
// WHAT ACTUALLY TOUCHES the network/filesystem is NOT here: a driver's side-effecting collaborators
// are its OWN construction parameter (Cloudflare: `CloudflareCollaborators`), because a shell runner
// and an oblaka provisioner are meaningless to a driver that is five HTTP calls. Only the genuinely
// neutral part of a run — the progress sink and cancellation — travels with the run below.

import type { AppConfigs } from '@fabrika/config'
import type { DeployContext, DeployPlan, DeployTargets, PlatformId } from './types'

/** The message a step reports when the run's `AbortSignal` fires while it was in flight. */
export const CANCELLED = 'deploy cancelled'

/** Everything a driver is given for ONE deploy run, with the target narrowed to the driver's platform. */
export interface DriverRun<K extends PlatformId = PlatformId> {
	/**
	 * The app being deployed, with its config narrowed to THIS driver's platform arm the same way
	 * `ctx.target` is — so the Cloudflare driver reads `config.resources` with no check, and a Zerops
	 * driver reads `config.target.services` with no check.
	 */
	readonly config: AppConfigs[K]
	/**
	 * The deploy's universal coordinates + resolved secrets/vars, with `ctx.target` narrowed to THIS
	 * driver's platform variant.
	 */
	readonly ctx: DeployContext<DeployTargets[K]>
	/**
	 * NEUTRAL: the sink for human-readable progress / dry-run lines. Every driver gets this; it is
	 * the one collaborator that means the same thing on every platform. NEVER log a secret value.
	 */
	readonly log: (line: string) => void
	/**
	 * NEUTRAL: cancellation for the whole run. A driver MUST honour it in anything long-running (a
	 * spawned child, a poll loop), and may assume the orchestrator abandons the step regardless — so
	 * ignoring it leaks work, it does not wedge the run.
	 */
	readonly signal: AbortSignal
	/** Plan-only mode: skip every real mutation and log what it WOULD do. Wire it through every step. */
	readonly dryRun: boolean
}

/**
 * One driver per platform, bound to its target variant. `open()` resolves whatever the plan depends on
 * (the Cloudflare driver materializes the oblaka resource graph) and derives the plan from it.
 * Derivation ITSELF stays pure and independently testable inside the driver — `open()` is just where
 * the impure inputs are gathered.
 */
export interface DeployDriver<K extends PlatformId = PlatformId> {
	/** The target discriminant this driver serves — also its key in a `DriverRegistry`. */
	readonly id: K
	/** Begin a run: gather inputs, derive the plan, and return a session that can execute its steps. */
	open(run: DriverRun<K>): Promise<DeploySession>
}

/**
 * Driver lookup, keyed by the target discriminant — the engine's ONLY per-platform knowledge, and
 * data rather than control flow (ADR-0009). PARTIAL on purpose: a platform can be a legitimate target
 * variant before anyone has written its driver, and `deploy()` reports that as a clean error rather
 * than the type system pretending a driver exists.
 */
export type DriverRegistry = { readonly [K in PlatformId]?: DeployDriver<K> }

/**
 * A driver's per-run session: the derived plan, plus the ability to execute one of its steps.
 *
 * Steps are executed BY ID rather than by handing the spec back, because the engine's `JobSpec` is the
 * driver's step flattened for reporting — the driver keeps the richly-typed original and looks it up.
 * Ids are already a plan's primary key (`dependsOn` references them).
 */
export interface DeploySession {
	/** The ordered plan for this run. Fully derived; nothing has executed yet. */
	readonly plan: DeployPlan
	/** Execute the step with this id. Resolves on success, THROWS on failure (the engine records it). */
	execute(stepId: string): Promise<void>
}
