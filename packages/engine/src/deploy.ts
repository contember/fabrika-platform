// The orchestrator. It EXECUTES a plan; it does not decide what the plan is — that belongs to the
// `DeployDriver` (ADR-0002), and WHICH driver belongs to the target's discriminant (ADR-0009).
// Everything left here is platform-neutral: driver lookup by discriminant, deploy-var injection,
// progress logging, cancellation, step status transitions, fail-stop, and the result shape. Nothing in
// this file knows a Cloudflare step kind or a Cloudflare credential, and nothing may start to.

import { type AnyAppConfig, appPlatform } from '@fabrika/config'
import { CANCELLED, type DeploySession, type DriverRegistry, type DriverRun } from './driver'
import { defaultDrivers } from './drivers'
import type { DeployContext, DeployResult, DeployStep, JobSpec, PlatformId, RunStatus } from './types'

/** A signal that never fires — what a caller that passed none effectively has. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal

/** Roll a list of plan specs into pending `DeployStep`s. */
const initSteps = (specs: JobSpec[]): DeployStep[] => specs.map((spec) => ({ spec, status: 'pending' as RunStatus }))

/**
 * Inject the app's NON-SECRET deploy vars (`ctx.vars`, the per-app-env registry config) into
 * `process.env`, then assert every DECLARED var resolved. This runs BEFORE the driver opens, because a
 * driver materializes the app's config there and the config reads its vars via `process.env['NAME']` —
 * the same way a migrated `oblaka.ts` does. The whole registry set is injected (so optional vars work
 * too); `pipeline.vars` is what's asserted. Required even in dry-run (the graph needs them to
 * materialize, like creds); a declared var with no value is a hard error — never ship a
 * half-configured deploy. Only the NAME is ever logged, never a value.
 *
 * `pipeline.vars` is a `@fabrika/config` surface, not a platform surface, so this stays in the engine.
 */
const injectDeployVars = (config: AnyAppConfig, ctx: DeployContext): void => {
	for (const [name, value] of Object.entries(ctx.vars ?? {})) {
		process.env[name] = value
	}
	for (const name of config.pipeline?.vars ?? []) {
		if (ctx.vars?.[name] === undefined) {
			throw new Error(`deploy: missing value for declared pipeline var \`${name}\` (not in ctx.vars)`)
		}
	}
}

/**
 * The ONE place a target selects its driver: index the registry by the run's discriminant. Generic over
 * the platform so the lookup and the run stay correlated — `drivers['cloudflare']` is the driver whose
 * `open()` takes a Cloudflare-narrowed run — which is what lets this be a map instead of a `switch`,
 * with no cast anywhere.
 */
const openSession = <K extends PlatformId>(
	drivers: DriverRegistry,
	run: DriverRun<K> & { ctx: { target: { platform: K } } },
): Promise<DeploySession> => {
	const driver = drivers[run.ctx.target.platform]
	if (driver === undefined) {
		throw new Error(`deploy: no driver registered for target platform \`${run.ctx.target.platform}\``)
	}
	// The config's arm and the target's arm are inferred independently, so pair them ONCE, here, before any
	// driver sees the run. This is not the engine branching on a platform — it never names one — it is what
	// keeps `DriverRun.config` honestly narrowed, which is what lets every driver read its own arm unguarded.
	if (appPlatform(run.config) !== run.ctx.target.platform) {
		throw new Error(
			`deploy: app \`${run.config.id}\` declares a \`${appPlatform(run.config)}\` target but the deploy targets \`${run.ctx.target.platform}\``,
		)
	}
	return driver.open(run)
}

/**
 * Abandon `promise` the moment `signal` fires. The step keeps running in the background — a driver
 * cannot be forced to stop — but the run stops WAITING for it, so one unresponsive step can never
 * wedge a cancelled deploy. Drivers honour the signal too, which is what actually kills the work.
 */
const untilCancelled = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
	if (signal.aborted) {
		return Promise.reject(new Error(CANCELLED))
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new Error(CANCELLED))
		signal.addEventListener('abort', onAbort, { once: true })
		void promise.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', onAbort)
		})
	})
}

/** Knobs `deploy()` takes beyond the app + its target. All optional; the defaults are production's. */
export interface DeployOptions {
	/**
	 * NEUTRAL run collaborator: where progress / dry-run lines go. Defaults to `console.log`. Passed
	 * through to every driver. NEVER write a secret value into it.
	 */
	log?: (line: string) => void
	/**
	 * Cancels the run. The step in flight is abandoned and reported `failed` with `deploy cancelled`;
	 * every step after it is `skipped` and the run's status is `failed`. Drivers receive the same
	 * signal and honour it in anything long-running (Cloudflare kills the `wrangler` child).
	 */
	signal?: AbortSignal
	/**
	 * Driver lookup by target discriminant. Defaults to `defaultDrivers`. Tests override the entry for
	 * the platform under test with a driver built over fake collaborators.
	 */
	drivers?: DriverRegistry
}

/**
 * Deploy one app to one environment: look the target's `DeployDriver` up by `ctx.target.platform`, open
 * a run against it, execute the plan the driver derived — in the order it gave them — and return the
 * result. Stops on the first failure (or on cancellation) and marks the rest `skipped`.
 *
 * WHAT the plan is (which steps, in what order, and what each does) is the driver's. WHAT actually
 * touches the network/filesystem is the driver's OWN collaborator bundle, supplied when the driver is
 * constructed — not a parameter here (ADR-0009). What this function owns is neutral: var injection,
 * progress, cancellation, status transitions, and `ctx.dryRun`, which every driver must honour.
 */
export const deploy = async (config: AnyAppConfig, ctx: DeployContext, options: DeployOptions = {}): Promise<DeployResult> => {
	const log = options.log ?? ((line: string) => console.log(line))
	const signal = options.signal ?? NEVER_CANCELLED
	const dryRun = ctx.dryRun ?? false
	injectDeployVars(config, ctx)

	const session = await openSession(options.drivers ?? defaultDrivers, { config, ctx, log, signal, dryRun })
	const { plan } = session
	const steps = initSteps(plan.steps)

	log(`Deploy ${plan.appId} → ${plan.env}${dryRun ? ' (dry-run)' : ''} — ${steps.length} step(s):`)
	for (const step of steps) {
		log(`  • ${step.spec.id} — ${step.spec.description}`)
	}

	// Set once a step fails OR the run is cancelled: every remaining step is reported `skipped` and the
	// run's status is `failed`. A run cancelled AFTER its last step still succeeded — nothing was lost.
	let stopped = false
	for (const step of steps) {
		if (stopped) {
			step.status = 'skipped'
			continue
		}
		if (signal.aborted) {
			// Cancelled between steps: this one never started, so it is skipped rather than failed.
			stopped = true
			step.status = 'skipped'
			log(`∅ ${step.spec.id}: ${CANCELLED}`)
			continue
		}

		step.status = 'running'
		step.startedAt = Date.now()
		log(`→ ${step.spec.id}`)
		try {
			await untilCancelled(session.execute(step.spec.id), signal)
			step.status = 'succeeded'
		} catch (error) {
			step.status = 'failed'
			step.error = error instanceof Error ? error.message : String(error)
			stopped = true
			log(`✗ ${step.spec.id}: ${step.error}`)
		}
		step.finishedAt = Date.now()
	}

	return {
		appId: plan.appId,
		env: plan.env,
		status: stopped ? 'failed' : 'succeeded',
		plan,
		steps,
	}
}
