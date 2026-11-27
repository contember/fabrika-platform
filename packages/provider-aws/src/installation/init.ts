// `fabrika platform init --provider=aws` (the AWS idea's checklist, step 11, the commands' step): the operator's
// sidecar repository for an installation that already exists, and the deployer role its workflow takes. Run once
// with the operator's own credentials, after `install`; idempotent, so run again it refreshes the workflow and
// converges the role.
//
// In order, each step that leaves this machine confirmed first:
//
// 1. **The account** the credentials belong to is the one named, and it holds an installation (its services' stack, its
//    record) and its ceilings (`ceilings.ts`), which the deployer's role names as its boundary.
// 2. **The sidecar repository** is created (private) or refreshed with the workflow, its README and `fabrika.ref`
//    (`sidecar.ts`, over `installation-init`'s scaffold).
// 3. **The role.** The repository's OIDC subject is customized to its owner's and its own numeric ids and the job's
//    context (`AWS_DEPLOYER_SUBJECT_CLAIMS`), then GitHub's provider and the deployer stack are applied (`deployer.ts`):
//    AWS gives the role to a job of that repository in the installation's GitHub Environment alone.
// 4. **The GitHub Environment**, named after the installation's environment, is written with four variables (the
//    account, the region, the role's ARN, the base image) and no secret: there is none. The deployment-branch policy is
//    set where the plan offers it, and a required reviewer is recommended with the command that adds one.
// 5. **The first run** is triggered if the operator agrees; with a reviewer, it waits for an approval.
//
// UNVERIFIED: GitHub's `actions/oidc/customization/sub` endpoint and the `sub` it then issues follow GitHub's
// documentation; the live check (step 13) settles both.

import {
	action,
	assertPinnedTag,
	branchProtectionCommand,
	capture,
	CHECKOUT_FLAG,
	type CommandEnv,
	type Confirmations,
	describeArgument,
	type EnvironmentConfig,
	environmentPolicyCommand,
	environmentReviewerCommand,
	type ProtectionOutcome,
	readFlag,
	requiredSetting,
	run,
	setting,
	sidecarCheckoutDir,
	type SidecarScaffoldInput,
	type SidecarScaffoldResult,
	UNATTENDED_FLAG,
} from '@fabrika/installation-init'
import type { IamGithubIdentity } from '../aws/iam'
import type { SsmPlatformSecrets } from '../aws/ssm'
import type { StsClient } from '../aws/sts'
import type { EnsureStackInput } from '../stack'
import { AWS_CEILINGS_STACK } from './ceilings'
import { applyAwsDeployer, AWS_DEPLOYER_SUBJECT_CLAIMS, awsDeployerRoleArn } from './deployer'
import { AWS_BASE_IMAGE_FORM } from './options'
import { AWS_INSTALLATION_RECORD, parseAwsInstallationRecord } from './record'
import { AWS_ACCOUNT_ID_FORM, AWS_REGION_FORM } from './runtime'
import { AWS_SERVICES_STACK } from './services'
import { AWS_SIDECAR_FILES, materializeAwsSidecar, readAwsPinnedTag } from './sidecar'

/** What `init` takes from the operator. No credential: the operator's AWS ones come from the standard variables. */
export interface AwsInitOptions {
	readonly accountId: string
	readonly region: string
	/** The sidecar repository, `<owner>/<name>`. */
	readonly repo: string
	/** Its local checkout: `--checkout`, or `fabrika-aws-<name>` in the working directory. */
	readonly checkoutDir: string
	/** The published fabrika tag the sidecar pins in `fabrika.ref`. */
	readonly fabrikaRef: string
	/** The Bun image applications build from, by digest, which every upgrade the workflow runs names. */
	readonly baseImage: string
	readonly unattended: boolean
}

const FLAGS: readonly (readonly [string, string])[] = [
	['--account-id', 'FABRIKA_AWS_ACCOUNT_ID'],
	['--region', 'FABRIKA_AWS_REGION'],
	['--repo', 'FABRIKA_AWS_SIDECAR_REPO'],
	['--tag', 'FABRIKA_PLATFORM_TAG'],
	['--base-image', 'FABRIKA_AWS_BASE_IMAGE'],
]
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** `init`'s arguments: every value as `--flag=value` or from its variable, `--yes` bare, nothing else. */
export function parseAwsInitArgs(argv: readonly string[], env: CommandEnv, cwd: string = process.cwd()): AwsInitOptions {
	for (const arg of argv) {
		if (arg === UNATTENDED_FLAG) continue
		const name = arg.split('=')[0] ?? arg
		if (![...FLAGS.map(([flag]) => flag), CHECKOUT_FLAG].includes(name)) throw new Error(`${describeArgument(arg)} is not an argument of this command`)
		if (!arg.includes('=')) throw new Error(`${name} takes its value as ${name}=<value>`)
	}
	const [accountId, region, repo, tag, baseImage] = FLAGS.map(([flag, variable]) =>
		requiredSetting(setting(argv, env, flag, variable), flag, variable)
	)
	if (accountId === undefined || region === undefined || repo === undefined || tag === undefined || baseImage === undefined) {
		throw new Error('aws: the account, the region, the repository, the tag and the base image are required')
	}
	if (!AWS_ACCOUNT_ID_FORM.test(accountId)) throw new Error('--account-id is not an account id (12 digits)')
	if (!AWS_REGION_FORM.test(region)) throw new Error('--region is not a region name (eu-central-1)')
	if (!REPOSITORY.test(repo)) throw new Error('--repo is not <owner>/<name>')
	if (!AWS_BASE_IMAGE_FORM.test(baseImage)) throw new Error('--base-image is not an image by digest (<registry>/<name>@sha256:<64 hex>)')
	const name = repo.split('/')[1] ?? repo
	return {
		accountId,
		region,
		repo,
		checkoutDir: sidecarCheckoutDir(readFlag(argv, CHECKOUT_FLAG), `fabrika-aws-${name}`, cwd),
		fabrikaRef: assertPinnedTag(tag),
		baseImage,
		unattended: argv.includes(UNATTENDED_FLAG),
	}
}

/** What `init` does on GitHub, through `gh`; every one of them confirmed first. Replaced in tests. */
export interface AwsInitGithub {
	repositoryExists(repo: string): Promise<boolean>
	scaffold(input: SidecarScaffoldInput): Promise<SidecarScaffoldResult>
	/** The repository's owner's and its own numeric ids. */
	repositoryIds(repo: string): Promise<{ readonly ownerId: string; readonly repositoryId: string }>
	/** Customizes the `sub` of the repository's OIDC tokens to `claims`. */
	setSubjectClaims(repo: string, claims: readonly string[]): Promise<void>
	configureEnvironment(config: EnvironmentConfig): Promise<void>
	triggerWorkflow(repo: string): Promise<void>
}

export interface AwsInitRun extends Pick<EnsureStackInput, 'cloudFormation' | 'signal' | 'sleep' | 'log'> {
	readonly options: AwsInitOptions
	readonly sts: Pick<StsClient, 'callerAccount'>
	readonly secrets: Pick<SsmPlatformSecrets, 'readSecret'>
	readonly iam: IamGithubIdentity
	readonly github: AwsInitGithub
	readonly confirmations: Confirmations
	/** A block the operator acts on: a title and its lines. */
	readonly action: (title: string, lines: readonly string[]) => void
}

/** What `init` ended with: the role, the Environment, whether a run was started. `null` where the operator declined. */
export interface AwsInitResult {
	readonly roleArn: string
	readonly environment: string
	readonly triggered: boolean
}

/** Runs the whole of `init`; answers `null` when the operator declined a step, which stops every later one. */
export async function runAwsInit(input: AwsInitRun): Promise<AwsInitResult | null> {
	const { options, signal, log } = input
	const where = `account ${options.accountId}, ${options.region}`
	const caller = await input.sts.callerAccount(signal)
	if (caller !== options.accountId) {
		throw new Error(`aws: the credentials in the environment are account ${caller}'s, not account ${options.accountId}'s; export the named account's`)
	}
	if ((await input.cloudFormation.findStack(AWS_SERVICES_STACK, signal)) === null) {
		throw new Error(`aws: ${where} holds no installation; \`platform install\` makes one, and init then adds its sidecar`)
	}
	const record = await input.secrets.readSecret(AWS_INSTALLATION_RECORD, signal)
	if (record === null) throw new Error(`aws: ${where} holds no installation record at ${AWS_INSTALLATION_RECORD}; restore it before init`)
	const { environment } = parseAwsInstallationRecord(record)
	if ((await input.cloudFormation.findStack(AWS_CEILINGS_STACK, signal)) === null) {
		throw new Error(
			`aws: ${where} holds no ceilings stack (${AWS_CEILINGS_STACK}), which the deployer's role names as its boundary; `
				+ 'run `platform upgrade` once with your own credentials, then init',
		)
	}
	log(`aws: the sidecar ${options.repo} for the installation in ${where}, its GitHub Environment ${environment}, pinned to ${options.fabrikaRef}`)

	const exists = await input.github.repositoryExists(options.repo)
	if (
		!(await input.confirmations.confirm(
			exists ? `Refresh the workflow on ${options.repo} and push?` : `Create ${options.repo} (private) and push the workflow?`,
		))
	) {
		log('aws: nothing was changed')
		return null
	}
	const roleArn = awsDeployerRoleArn(options.accountId)
	// The scaffold's commits carry `[skip ci]` (installation-init's `scaffold.ts`), so this push, which touches the
	// workflow's own path, starts no run: only the operator's answer below does.
	const scaffolded = await input.github.scaffold({
		repo: options.repo,
		dir: options.checkoutDir,
		files: [...AWS_SIDECAR_FILES],
		materialize: (dir) =>
			materializeAwsSidecar(dir, {
				repo: options.repo,
				accountId: options.accountId,
				region: options.region,
				environment,
				roleArn,
				fabrikaRef: options.fabrikaRef,
			}),
	})
	const pinned = await readAwsPinnedTag(scaffolded.dir)
	if (pinned !== options.fabrikaRef) log(`aws: the existing pin ${pinned} was kept; fabrika.ref is the operator's, and bumping it upgrades`)

	const ids = await input.github.repositoryIds(options.repo)
	if (
		!(await input.confirmations.confirm(
			`Customize ${options.repo}'s OIDC subject to its ids, and apply the deployer role it takes in the ${environment} Environment?`,
		))
	) {
		log('aws: the repository is pushed; no role was made, so its workflow cannot run yet. Run init again when ready')
		return null
	}
	await input.github.setSubjectClaims(options.repo, AWS_DEPLOYER_SUBJECT_CLAIMS)
	const applied = await applyAwsDeployer({
		input: { accountId: options.accountId, repository: options.repo, repositoryOwnerId: ids.ownerId, repositoryId: ids.repositoryId, environment },
		iam: input.iam,
		cloudFormation: input.cloudFormation,
		signal,
		sleep: input.sleep,
		log,
	})
	if (applied !== roleArn) throw new Error(`aws: the deployer role is ${applied}, not the ${roleArn} the workflow names`)

	const vars = {
		FABRIKA_AWS_ACCOUNT_ID: options.accountId,
		FABRIKA_AWS_REGION: options.region,
		FABRIKA_AWS_ROLE_ARN: roleArn,
		FABRIKA_AWS_BASE_IMAGE: options.baseImage,
	}
	if (!(await input.confirmations.confirm(`Write ${Object.keys(vars).join(', ')} to the ${environment} Environment of ${options.repo}?`))) {
		log('aws: the Environment holds nothing yet, so the workflow cannot run. Run init again when ready')
		return null
	}
	let policy: ProtectionOutcome | undefined
	await input.github.configureEnvironment({
		repo: options.repo,
		environment,
		secrets: {},
		vars,
		onProtection: (outcome) => {
			policy = outcome
		},
	})
	input.action('OPERATOR ACTION: require a person to approve every upgrade', [
		`The workflow's role is an administrator of the account inside the installation's ceiling. Add yourself as a required reviewer of the`,
		`${environment} Environment, so no run takes the role before a person approves it:`,
		environmentReviewerCommand(options.repo, environment),
		...awsProtectionLines(options.repo, environment, scaffolded.branchProtection, policy),
		'Whoever can run the workflow there can still do what the platform stacks can; a role it makes may trust someone outside the',
		'account, who then gets the ceiling and no more. Keep this account for the installation alone.',
	])

	let triggered = false
	if (pinned !== options.fabrikaRef) {
		log(`aws: no run was started: ${options.repo} pins ${pinned}, not ${options.fabrikaRef}. Bump fabrika.ref and push to upgrade`)
	} else if (await input.confirmations.confirm(`Run the platform workflow on ${options.repo} now (with a reviewer, it waits for an approval)?`)) {
		await input.github.triggerWorkflow(options.repo)
		triggered = true
		log(`aws: the platform workflow is started: https://github.com/${options.repo}/actions`)
	}
	log('aws: from now on, bump fabrika.ref to a newer tag and push to upgrade; a release that changes the ceilings asks for your own run once')
	return { roleArn, environment, triggered }
}

/**
 * What of the sidecar's protection is missing, for the block beside the reviewer's command: `main`'s rule (without it the
 * Environment's branch policy admits every branch), the Environment's branch policy, and, where GitHub's plan refused
 * a rule, that the same plan offers no required reviewer either. Nothing when both are in place.
 */
export function awsProtectionLines(
	repo: string,
	environment: string,
	branch: ProtectionOutcome | undefined,
	policy: ProtectionOutcome | undefined,
): string[] {
	const lines: string[] = []
	if (branch?.applied !== true) {
		lines.push(
			`main is NOT protected (${branch?.reason ?? 'not checked'}); until it is, the Environment's branch policy admits every branch:`,
			branch?.command ?? branchProtectionCommand(repo),
		)
	}
	if (policy?.applied !== true) {
		lines.push(
			`The ${environment} Environment is NOT restricted to main (${policy?.reason ?? 'not set'}):`,
			policy?.command ?? environmentPolicyCommand(repo, environment),
		)
	}
	if ([branch, policy].some((outcome) => outcome?.reason?.includes('not offered on this plan') === true)) {
		lines.push(
			"GitHub's plan does not offer these rules on a private repository, nor a required reviewer: there, whoever can push to main or",
			'start the workflow takes the role unapproved. Move the sidecar to a plan that offers them before relying on it.',
		)
	}
	return lines
}

const ANCHOR = process.cwd()
const IDS = /^([1-9]\d{0,19})\t([1-9]\d{0,19})$/

/** The real GitHub side: `gh`, git and installation-init's scaffold and Environment. */
export function ghAwsInitGithub(
	base: Pick<AwsInitGithub, 'repositoryExists' | 'scaffold' | 'configureEnvironment' | 'triggerWorkflow'>,
): AwsInitGithub {
	return {
		...base,
		async repositoryIds(repo) {
			const answer = (await capture({ command: 'gh', args: ['api', `repos/${repo}`, '--jq', '[.owner.id, .id] | @tsv'], cwd: ANCHOR })).trim()
			const [, ownerId, repositoryId] = IDS.exec(answer) ?? []
			if (ownerId === undefined || repositoryId === undefined) throw new Error(`aws: GitHub named no ids for ${repo}`)
			return { ownerId, repositoryId }
		},
		setSubjectClaims: (repo, claims) =>
			run({
				command: 'gh',
				args: ['api', '-X', 'PUT', `repos/${repo}/actions/oidc/customization/sub`, '--input', '-'],
				cwd: ANCHOR,
				stdin: JSON.stringify({ use_default: false, include_claim_keys: [...claims] }),
			}),
	}
}

/** A block the operator acts on, as the console prints it. */
export const consoleAction = (title: string, lines: readonly string[]): void => action(title, [...lines])
