/**
 * Harden the sidecar repository the operator owns. It holds the installation's entire credential set,
 * so a push to `main` must not be able to rewrite the pipeline that reads them. ADR-0025 leaves the
 * repository operator-owned; this only stops it from being weaker than the account it controls.
 *
 * GitHub Free offers neither rule on a PRIVATE repository, so a refusal is REPORTED, never fatal: the
 * operator is told what is unprotected and the exact command that applies it later. Every body travels
 * over stdin (`gh api --input -`), never on argv.
 *
 * An Environment's `protected_branches` policy is only as strong as the branch rule it points at: with no
 * protection rule on `main`, the policy admits `main` and restricts nothing. The two are reported together
 * for that reason.
 */

import { detail, ok, warn } from './log'
import { attempt, type ShellAttempt, type ShellStep } from './shell'

/** A harmless cwd anchor — `gh` resolves the repository from the API path, not from cwd. */
const ANCHOR = process.cwd()

/** No force pushes, no deletions, admins included. No required review: `platform upgrade` pushes to `main`. */
export const BRANCH_PROTECTION_BODY = JSON.stringify({
	required_status_checks: null,
	enforce_admins: true,
	required_pull_request_reviews: null,
	restrictions: null,
	allow_force_pushes: false,
	allow_deletions: false,
})

/** Only a protected branch may use the Environment's secrets — and only where such a rule exists. */
export const DEPLOYMENT_BRANCH_POLICY = { protected_branches: true, custom_branch_policies: false } as const

/** The same policy as a standalone PUT body, for the command an operator runs by hand. */
export const DEPLOYMENT_BRANCH_POLICY_BODY = JSON.stringify({ deployment_branch_policy: DEPLOYMENT_BRANCH_POLICY })

/** Whether one hardening rule is in place, plus the command that applies it when it is not. */
export interface ProtectionOutcome {
	readonly applied: boolean
	/** One short, printable line saying why it is not applied. Absent when it is. */
	readonly reason?: string
	/** The `gh api` invocation that applies this rule later. */
	readonly command: string
}

/** Run a `gh` step whose failure is an ANSWER rather than an error. The seam tests drive. */
export type GhAttempt = (step: ShellStep) => Promise<ShellAttempt>

export const branchProtectionCommand = (repo: string): string =>
	`printf '%s' '${BRANCH_PROTECTION_BODY}' | gh api -X PUT repos/${repo}/branches/main/protection --input -`

export const environmentPolicyCommand = (repo: string, environment: string): string =>
	`printf '%s' '${DEPLOYMENT_BRANCH_POLICY_BODY}' | gh api -X PUT repos/${repo}/environments/${environment} --input -`

/** Recommended, never applied by us: an approval click per deploy is the operator's call. */
export const environmentReviewerCommand = (repo: string, environment: string): string => {
	const body = '{"reviewers":[{"type":"User","id":%s}],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}'
	return `printf '${body}' "$(gh api user --jq .id)" | gh api -X PUT repos/${repo}/environments/${environment} --input -`
}

/** The HTTP status `gh` names in its error line (`gh: … (HTTP 403)`), when it names one. */
export const ghHttpStatus = (result: ShellAttempt): number | undefined => {
	const status = /\(HTTP (\d{3})\)/.exec(result.stderr)?.[1]
	return status === undefined ? undefined : Number(status)
}

/**
 * The three statuses GitHub answers when a plan does not offer a protection rule. A 422 can also mean a
 * malformed request, so this is a heuristic — it decides only whether we DEGRADE or give up, never
 * whether something is safe.
 */
export const PLAN_LIMITED: ReadonlySet<number> = new Set([403, 404, 422])

/** True when GitHub's answer is one this code is willing to continue without the rule on. */
export const isPlanLimited = (result: ShellAttempt): boolean => {
	const status = ghHttpStatus(result)
	return status !== undefined && PLAN_LIMITED.has(status)
}

/** One printable line for a refusal — the plan limit when GitHub named one, the exit code otherwise. */
export const unavailableReason = (result: ShellAttempt): string => {
	const status = ghHttpStatus(result)
	if (isPlanLimited(result)) {
		return `HTTP ${String(status)} — not offered on this plan for a private repository`
	}
	return `\`gh\` exited ${result.exitCode}${status === undefined ? '' : ` (HTTP ${status})`}`
}

/** Protect `main` on the sidecar. Reports what is unprotected and never throws. */
export async function protectSidecarBranch(repo: string, gh: GhAttempt = attempt): Promise<ProtectionOutcome> {
	const command = branchProtectionCommand(repo)
	const result = await gh({
		command: 'gh',
		args: ['api', '-X', 'PUT', `repos/${repo}/branches/main/protection`, '--input', '-'],
		cwd: ANCHOR,
		stdin: BRANCH_PROTECTION_BODY,
	})
	if (result.exitCode === 0) {
		ok('Branch protection on main: no force pushes, no deletions, enforced for admins.')
		return { applied: true, command }
	}
	const reason = unavailableReason(result)
	warn(`main is UNPROTECTED on ${repo} (${reason}) — nothing stops a force-push or a branch delete on main.`)
	detail(`Apply it later: ${command}`)
	return { applied: false, reason, command }
}

/**
 * Read-only: does `main` already carry a protection rule? For a repository this run did NOT create — a
 * PUT there would replace whatever the operator configured, so the existing rules are reported, never
 * overwritten. A 404 is GitHub's answer for "no protection rule", which is exactly what we warn about.
 */
export async function probeSidecarBranchProtection(repo: string, gh: GhAttempt = attempt): Promise<ProtectionOutcome> {
	const command = branchProtectionCommand(repo)
	const result = await gh({ command: 'gh', args: ['api', `repos/${repo}/branches/main/protection`], cwd: ANCHOR })
	if (result.exitCode === 0) {
		ok('Branch protection on main: already configured (left as the operator set it).')
		return { applied: true, command }
	}
	const status = ghHttpStatus(result)
	const reason = status === 404 ? 'HTTP 404 — no protection rule on main' : unavailableReason(result)
	warn(`main is UNPROTECTED on ${repo} (${reason}) — nothing stops a force-push or a branch delete on main.`)
	detail(`Apply it later: ${command}`)
	return { applied: false, reason, command }
}
