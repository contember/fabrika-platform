/**
 * The runner Worker's CF bindings. It is the deploy EXECUTOR — a worker SEPARATE from
 * the fabrika control plane, split out so that deploying fabrika itself never resets the Durable Object
 * that is actively running that deploy (the self-reset that orphaned fabrika's own runs). fabrika calls it
 * over a service binding (`RUNNER_SVC.startRun(job)`); this worker boots the per-run container and relays
 * its logs and terminal status → R2, where the control plane's reconcile reads them back.
 *
 * RUN_LOGS is the SAME R2 bucket the control plane owns (oblaka adopts it by name). The Worker binds
 * no database: the control plane is the only writer of its own.
 */
import type { RunnerContainer } from './RunnerContainer'

export interface Env {
	/** Per-run deploy-runner container, backed by the RunnerContainer Durable Object (this worker owns it). */
	RUNNER: DurableObjectNamespace<RunnerContainer>
	/** Run logs + terminal status, keyed by run id (the control plane's bucket, adopted by name). */
	RUN_LOGS: R2Bucket

	// ── Vars ──────────────────────────────────────────────────────────────────
	/** Deploy environment this worker runs in (e.g. `prod`) — for parity with the control plane; diagnostics only. */
	ENVIRONMENT: string

	// ── Secrets (provisioned out-of-band, never in `vars`) ─────────────────────
	/**
	 * Shared secret the control plane presents on every RPC. A service binding is not a capability —
	 * any Worker on the account can bind `<env>-vozka-runner` — so this is what actually authenticates
	 * the caller. Optional on the type only so an unset value can DENY at runtime (src/runner-key.ts).
	 */
	FABRIKA_RUNNER_KEY?: string
}
