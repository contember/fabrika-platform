// What the environment's approved plans cover of a deploy: the coverage a publication consumes, and the same coverage
// read for a parked run, so the person approving it reads only the lines no plan lets through (ADR-0050 §5).

import { type ApprovalPlanCoverageDto, gate } from '@fabrika/control-contract'
import type { AppEnvRow, ControlRepositories, RunRow } from '../../db'
import { appEnvPolicy, appEnvSettings } from '../categories'
import type { StoredClassification } from '../publish'
import { type AccessSnapshot, approvedSnapshot, snapshotDigest } from '../snapshot'
import { coveringEntry, fragmentSource, type PlanCoverage, planCoverage } from './coverage'

/** The environment's active plan entries as coverage of one deploy (baseline → candidate), and the plan of each entry. */
export async function activeCoverage(
	repositories: Pick<ControlRepositories, 'approvalPlans'>,
	appEnv: AppEnvRow,
	baseline: AccessSnapshot,
	candidate: AccessSnapshot,
): Promise<{ readonly coverage: PlanCoverage; readonly planOf: ReadonlyMap<string, string> } | null> {
	const entries = await repositories.approvalPlans.activeEntries(appEnv.app_id, appEnv.env)
	if (entries.length === 0) return null
	return {
		coverage: planCoverage(entries.map(coveringEntry), fragmentSource(baseline), fragmentSource(candidate), appEnvSettings(appEnv).planBinding),
		planOf: new Map(entries.map((entry) => [entry.id, entry.plan_id])),
	}
}

/**
 * The lines of a parked run that the environment's active entries cover now: each line the gate lets through with them
 * and not without. Only while the run waits on its lines (a deploy request waits for a person whatever they are) and
 * the environment still publishes the snapshot the run was compared with, since a deploy of the same change would be
 * compared with that one; otherwise, or when nothing is covered, undefined.
 */
export async function parkedRunCoverage(
	repositories: Pick<ControlRepositories, 'approvalPlans' | 'registry'>,
	run: RunRow,
	classification: StoredClassification,
	candidate: AccessSnapshot,
): Promise<ApprovalPlanCoverageDto | undefined> {
	if (run.status !== 'awaiting_approval' || run.park_reason === 'requested' || !classification.protected) return undefined
	const appEnv = await repositories.registry.getAppEnv(run.app_id, run.env)
	if (appEnv === null || appEnv.protected !== 1) return undefined
	const baseline = approvedSnapshot(appEnv).snapshot
	if (snapshotDigest(baseline) !== classification.baselineDigest) return undefined
	const found = await activeCoverage(repositories, appEnv, baseline, candidate)
	if (found === null) return undefined
	const policy = appEnvPolicy(appEnv)
	const lines = classification.changes.flatMap((change, index) =>
		gate({ lines: [change] }, policy).kind !== 'pass' && gate({ lines: [change] }, policy, found.coverage).kind === 'pass' ? [index] : []
	)
	if (lines.length === 0) return undefined
	const plans = new Set(found.coverage.used().flatMap((entry) => found.planOf.get(entry) ?? []))
	return { lines, plans: [...plans].sort().reverse() }
}
