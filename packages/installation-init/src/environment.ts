/**
 * Write the collected configuration into the base repo's GitHub **Environment** (not repo-level), so the
 * platform pipeline reads it per-environment. Secret VALUES go to `gh secret set --env` over STDIN (gh does
 * the libsodium encryption; the value never hits argv or a log line); non-secret values go to
 * `gh variable set --env --body`. The environment itself is created (idempotent PUT) first, carrying the
 * deployment-branch policy that is the only thing an Environment buys over a repository secret — a policy
 * that restricts nothing until `main` itself carries a branch-protection rule.
 */

import { z } from 'zod'
import { detail, ok, step, warn } from './log'
import {
	DEPLOYMENT_BRANCH_POLICY,
	environmentPolicyCommand,
	environmentReviewerCommand,
	type GhAttempt,
	ghHttpStatus,
	isPlanLimited,
	type ProtectionOutcome,
	unavailableReason,
} from './protection'
import { attempt, run, type ShellAttempt, type ShellStep } from './shell'

/** A harmless cwd anchor — `gh` ignores cwd when `--repo` is given. */
const ANCHOR = process.cwd()

export interface EnvironmentConfig {
	repo: string
	environment: string
	/** Secret name → value (written via `gh secret set`). */
	secrets: Record<string, string>
	/** Variable name → value (written via `gh variable set`). */
	vars: Record<string, string>
	/**
	 * Told once whether only a protected branch may use this Environment's secrets, so a provider's
	 * closing summary can restate it. A callback rather than a return value: both providers already
	 * bind this function through a `Promise<void>` collaborator.
	 */
	onProtection?(outcome: ProtectionOutcome): void
}

/** The child processes `configureEnvironment` drives. Replaced wholesale in tests. */
export interface EnvironmentEffects {
	attempt: GhAttempt
	run(step: ShellStep): Promise<void>
}

const defaultEnvironmentEffects: EnvironmentEffects = { attempt, run }

/** Create the GitHub Environment and populate its secrets + variables. */
export async function configureEnvironment(
	config: EnvironmentConfig,
	effects: EnvironmentEffects = defaultEnvironmentEffects,
): Promise<void> {
	const { repo, environment, secrets, vars } = config
	step(`Configure the ${environment} GitHub Environment on ${repo}`)

	// Never `onProtection?.(await …)`: optional-call short-circuiting would skip creating the environment.
	const protection = await createEnvironment(repo, environment, effects.attempt)
	config.onProtection?.(protection)

	for (const [name, value] of Object.entries(secrets)) {
		if (value === '') {
			warn(`Skipping secret ${name} — no value (the workflow will fail without it; set it manually).`)
			continue
		}
		await effects.run({ command: 'gh', args: ['secret', 'set', name, '--repo', repo, '--env', environment], cwd: ANCHOR, stdin: value })
		ok(`secret ${name} set`)
	}
	for (const [name, value] of Object.entries(vars)) {
		await effects.run({ command: 'gh', args: ['variable', 'set', name, '--repo', repo, '--env', environment, '--body', value], cwd: ANCHOR })
		ok(`variable ${name} set`)
	}
	detail(`Recommended hardening — require your own approval before a deploy: ${environmentReviewerCommand(repo, environment)}`)
}

/**
 * Idempotent create, carrying the deployment-branch policy MERGED over whatever protection rules the
 * environment already has — a PUT replaces the whole object, so a reviewer or wait timer the operator
 * added by hand would otherwise be dropped by the next `init`. A plan that does not offer protection
 * rules refuses the body, so the environment is then created WITHOUT it rather than not at all; any
 * other failure is a real error and is rethrown. Stdout is captured and discarded, never logged.
 */
async function createEnvironment(repo: string, environment: string, gh: GhAttempt): Promise<ProtectionOutcome> {
	const command = environmentPolicyCommand(repo, environment)
	const path = `repos/${repo}/environments/${environment}`
	const existing = await gh({ command: 'gh', args: ['api', path], cwd: ANCHOR })
	if (existing.exitCode !== 0 && ghHttpStatus(existing) !== 404) {
		warn(`Could not read ${environment}'s existing protection rules — a reviewer or wait timer set by hand may be reset by this write.`)
	}
	const body = JSON.stringify({ ...existingEnvironmentProtection(existing), deployment_branch_policy: DEPLOYMENT_BRANCH_POLICY })
	const withPolicy = await gh({ command: 'gh', args: ['api', '-X', 'PUT', path, '--input', '-'], cwd: ANCHOR, stdin: body })
	if (withPolicy.exitCode === 0) {
		ok(`Environment ${environment} ready — deployment-branch policy set (it restricts nothing until main carries a protection rule).`)
		return { applied: true, command }
	}
	if (!isPlanLimited(withPolicy)) {
		throw new Error(`\`gh api -X PUT ${path}\` failed (${unavailableReason(withPolicy)}).`)
	}
	const reason = unavailableReason(withPolicy)
	const plain = await gh({ command: 'gh', args: ['api', '-X', 'PUT', path], cwd: ANCHOR })
	if (plain.exitCode !== 0) {
		throw new Error(`\`gh api -X PUT ${path}\` failed (${unavailableReason(plain)}).`)
	}
	warn(`Environment ${environment} has NO deployment-branch policy (${reason}) — any branch that can run the workflow can read its secrets.`)
	detail(`Apply it later: ${command}`)
	return { applied: false, reason, command }
}

/** One reviewer in a PUT body: GitHub's GET nests the id under `reviewer`, its PUT wants it flat. */
interface EnvironmentReviewer {
	readonly type: string
	readonly id: number
}

/** The protection rules a PUT must carry forward, read off `gh api repos/…/environments/<name>`. */
export interface ExistingEnvironmentProtection {
	readonly reviewers?: readonly EnvironmentReviewer[]
	readonly wait_timer?: number
}

const protectionSchema = z.object({ protection_rules: z.array(z.unknown()) })
const waitTimerSchema = z.object({ type: z.literal('wait_timer'), wait_timer: z.number() })
const reviewersSchema = z.object({ type: z.literal('required_reviewers'), reviewers: z.array(z.unknown()) })
const reviewerSchema = z.object({ type: z.string(), reviewer: z.object({ id: z.number() }) })
	.transform(({ type, reviewer }) => ({ type, id: reviewer.id }))

/**
 * Translate a GET's `protection_rules` into the shape a PUT takes. Anything unrecognised is dropped:
 * a body GitHub rejects would cost the deployment-branch policy, which is what this write is for.
 */
export function existingEnvironmentProtection(result: ShellAttempt): ExistingEnvironmentProtection {
	if (result.exitCode !== 0) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(result.stdout)
	} catch {
		return {}
	}
	const protection = protectionSchema.safeParse(parsed)
	if (!protection.success) return {}
	const merged: { reviewers?: EnvironmentReviewer[]; wait_timer?: number } = {}
	for (const rule of protection.data.protection_rules) {
		const timer = waitTimerSchema.safeParse(rule)
		if (timer.success) {
			merged.wait_timer = timer.data.wait_timer
		}
		const required = reviewersSchema.safeParse(rule)
		if (required.success) {
			const reviewers = required.data.reviewers.flatMap((entry): EnvironmentReviewer[] => {
				const reviewer = reviewerSchema.safeParse(entry)
				return reviewer.success ? [reviewer.data] : []
			})
			if (reviewers.length > 0) merged.reviewers = reviewers
		}
	}
	return merged
}

/** Trigger the platform workflow (the real deploy runs in GitHub Actions). */
export async function triggerPlatformWorkflow(repo: string): Promise<void> {
	await run({ command: 'gh', args: ['workflow', 'run', 'platform.yml', '--repo', repo], cwd: ANCHOR })
}
