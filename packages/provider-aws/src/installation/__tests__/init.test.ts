// `platform init` on AWS: the account checked and the installation, its record and its ceilings found before GitHub is
// touched; the sidecar scaffolded, the repository's OIDC subject customized to its ids, the deployer applied with those
// ids, the Environment written with four variables and no secret, a required reviewer asked for with its command, and
// the first run started; each step stopped by a declined question; and the arguments refused by name.

import {
	type Confirmations,
	type EnvironmentConfig,
	INITIAL_SCAFFOLD_COMMIT_MESSAGE,
	type ProtectionOutcome,
	REFRESH_SCAFFOLD_COMMIT_MESSAGE,
} from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StackStatus } from '../../aws/cloudformation'
import { AWS_CEILINGS_STACK } from '../ceilings'
import { AWS_DEPLOYER_STACK, awsDeployerRoleArn } from '../deployer'
import { type AwsInitGithub, type AwsInitRun, parseAwsInitArgs, runAwsInit } from '../init'
import { awsInstallChoices, parseAwsInstallArgs } from '../options'
import { AWS_INSTALLATION_RECORD, encodeAwsInstallationRecord } from '../record'
import { AWS_SERVICES_STACK } from '../services'

const A = '123456789012'
const certificate = (n: number) => `arn:aws:acm:eu-central-1:${A}:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const RECORD = encodeAwsInstallationRecord(awsInstallChoices(
	parseAwsInstallArgs([
		`--account-id=${A}`,
		'--region=eu-central-1',
		'--environment=production',
		'--iam-host=iam.example.com',
		'--control-host=control.example.com',
		'--operations-host=operations.example.com',
		'--apps-host=apps.example.com',
		`--commit=${'a'.repeat(40)}`,
		`--base-image=docker.io/oven/bun@sha256:${'b'.repeat(64)}`,
	], {}),
	{ iam: certificate(1), control: certificate(2), operations: certificate(3), apps: certificate(4) },
))
const BASE_IMAGE = `docker.io/oven/bun@sha256:${'b'.repeat(64)}`
const ARGV = [`--account-id=${A}`, '--region=eu-central-1', '--repo=acme/fabrika-aws', '--tag=v0.9.0', `--base-image=${BASE_IMAGE}`]

interface World {
	readonly calls: string[]
	readonly stacks: Map<string, { body: string; status: StackStatus }>
	readonly store: Map<string, string>
	caller: string
	environments: Omit<EnvironmentConfig, 'onProtection'>[]
	pin: string
	branch: ProtectionOutcome
	policy: ProtectionOutcome
}

const APPLIED: ProtectionOutcome = { applied: true, command: 'gh api …' }
const PLAN_LIMITED = (command: string): ProtectionOutcome => ({
	applied: false,
	// The words installation-init's `unavailableReason` gives a plan's refusal.
	reason: 'HTTP 403: not offered on this plan for a private repository',
	command,
})

function world(): World {
	const stacks = new Map<string, { body: string; status: StackStatus }>([
		[AWS_SERVICES_STACK, { body: '', status: 'CREATE_COMPLETE' }],
		[AWS_CEILINGS_STACK, { body: '', status: 'CREATE_COMPLETE' }],
	])
	return {
		calls: [],
		stacks,
		store: new Map([[AWS_INSTALLATION_RECORD, RECORD]]),
		caller: A,
		environments: [],
		pin: 'v0.9.0',
		branch: APPLIED,
		policy: APPLIED,
	}
}

async function init(w: World, dir: string, answers: readonly boolean[] = [], argv: readonly string[] = ARGV) {
	let asked = 0
	const confirmations: Confirmations = { confirm: async () => answers[asked++] ?? true }
	const github: AwsInitGithub = {
		repositoryExists: async () => false,
		scaffold: async (input) => {
			w.calls.push(`scaffold ${input.repo}`)
			await input.materialize(dir)
			if (w.pin !== 'v0.9.0') await Bun.write(join(dir, 'fabrika.ref'), `${w.pin}\n`)
			return { dir, created: true, branchProtection: w.branch }
		},
		repositoryIds: async () => ({ ownerId: '7654321', repositoryId: '123456789' }),
		setSubjectClaims: async (repo, claims) => {
			w.calls.push(`subject ${repo} ${claims.join(',')}`)
		},
		configureEnvironment: async ({ onProtection, ...config }) => {
			w.calls.push(`environment ${config.environment}`)
			w.environments.push(config)
			onProtection?.(w.policy)
		},
		triggerWorkflow: async (repo) => {
			w.calls.push(`trigger ${repo}`)
		},
	}
	const actions: { title: string; lines: readonly string[] }[] = []
	const lines: string[] = []
	const run: AwsInitRun = {
		options: parseAwsInitArgs(argv, {}, dir),
		sts: { callerAccount: async () => w.caller },
		secrets: { readSecret: async (name) => w.store.get(name) ?? null },
		iam: {
			ensureGithubOidcProvider: async () => {
				w.calls.push('provider')
				return 'existed'
			},
		},
		cloudFormation: {
			findStack: async (name) => {
				const stack = w.stacks.get(name)
				return stack === undefined ? null : { stackId: name, status: stack.status }
			},
			describeStack: async (id) => {
				const outputs: Record<string, string> = id === AWS_DEPLOYER_STACK ? { RoleArn: awsDeployerRoleArn(A) } : {}
				return { stackId: id, status: w.stacks.get(id)?.status ?? 'CREATE_COMPLETE', outputs }
			},
			getTemplate: async (name) => w.stacks.get(name)?.body ?? '',
			createStack: async ({ name, templateBody }) => {
				w.calls.push(`create ${name}`)
				w.stacks.set(name, { body: templateBody, status: 'CREATE_COMPLETE' })
				return name
			},
			updateStack: async ({ name, templateBody }) => {
				w.calls.push(`update ${name}`)
				w.stacks.set(name, { body: templateBody, status: 'UPDATE_COMPLETE' })
				return name
			},
		},
		github,
		confirmations,
		signal: new AbortController().signal,
		sleep: async () => {},
		log: (line) => lines.push(line),
		action: (title, body) => actions.push({ title, lines: body }),
	}
	return { result: await runAwsInit(run), actions, lines }
}

async function inTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'fabrika-aws-init-'))
	try {
		return await body(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

describe('platform init on AWS', () => {
	test('the sidecar, its subject by ids, the deployer, the Environment with no secret, the reviewer asked for, the first run', async () => {
		await inTemp(async (dir) => {
			const w = world()
			const { result, actions } = await init(w, dir)
			expect(result).toEqual({ roleArn: awsDeployerRoleArn(A), environment: 'production', triggered: true })
			expect(w.calls).toEqual([
				'scaffold acme/fabrika-aws',
				'subject acme/fabrika-aws repository_owner_id,repository_id,context',
				'provider',
				`create ${AWS_DEPLOYER_STACK}`,
				'environment production',
				'trigger acme/fabrika-aws',
			])
			// The role trusts the ids GitHub named, in the installation's Environment.
			expect(w.stacks.get(AWS_DEPLOYER_STACK)?.body).toContain('repository_owner_id:7654321:repository_id:123456789:environment:production')
			expect(w.environments).toEqual([{
				repo: 'acme/fabrika-aws',
				environment: 'production',
				secrets: {},
				vars: {
					FABRIKA_AWS_ACCOUNT_ID: A,
					FABRIKA_AWS_REGION: 'eu-central-1',
					FABRIKA_AWS_ROLE_ARN: awsDeployerRoleArn(A),
					FABRIKA_AWS_BASE_IMAGE: BASE_IMAGE,
				},
			}])
			const reviewer = actions.find((entry) => entry.title.includes('approve every upgrade'))
			expect(reviewer?.lines.some((line) => line.includes('gh api -X PUT repos/acme/fabrika-aws/environments/production'))).toBe(true)
			expect(await Bun.file(join(dir, '.github/workflows/platform.yml')).text()).toContain('environment: production')
		})
	})

	test('another account, no installation, no record or no ceilings is refused before GitHub is touched', async () => {
		await inTemp(async (dir) => {
			const other = world()
			other.caller = '210987654321'
			await expect(init(other, dir)).rejects.toThrow("account 210987654321's, not account 123456789012's")
			const none = world()
			none.stacks.delete(AWS_SERVICES_STACK)
			await expect(init(none, dir)).rejects.toThrow('holds no installation')
			const unrecorded = world()
			unrecorded.store.clear()
			await expect(init(unrecorded, dir)).rejects.toThrow('holds no installation record')
			const unbounded = world()
			unbounded.stacks.delete(AWS_CEILINGS_STACK)
			await expect(init(unbounded, dir)).rejects.toThrow('holds no ceilings stack')
			expect([...other.calls, ...none.calls, ...unrecorded.calls, ...unbounded.calls]).toEqual([])
		})
	})

	test('a declined step stops every later one', async () => {
		await inTemp(async (dir) => {
			const declinedScaffold = world()
			expect((await init(declinedScaffold, dir, [false])).result).toBeNull()
			expect(declinedScaffold.calls).toEqual([])
			const declinedRole = world()
			expect((await init(declinedRole, dir, [true, false])).result).toBeNull()
			expect(declinedRole.calls).toEqual(['scaffold acme/fabrika-aws'])
			const declinedEnvironment = world()
			expect((await init(declinedEnvironment, dir, [true, true, false])).result).toBeNull()
			expect(declinedEnvironment.calls).not.toContain('environment production')
			const declinedRun = world()
			expect((await init(declinedRun, dir, [true, true, true, false])).result).toMatchObject({ triggered: false })
			expect(declinedRun.calls).not.toContain('trigger acme/fabrika-aws')
		})
	})

	test('what of the protection is missing stands beside the reviewer, with the plan that offers no reviewer named', async () => {
		await inTemp(async (dir) => {
			const protectedWorld = world()
			const reviewer = (actions: { title: string; lines: readonly string[] }[]) =>
				actions.find((entry) => entry.title.includes('approve every upgrade'))?.lines ?? []
			const full = reviewer((await init(protectedWorld, dir)).actions)
			expect(full.some((line) => line.includes('NOT'))).toBe(false)
			const free = world()
			free.branch = PLAN_LIMITED('protect main')
			free.policy = PLAN_LIMITED('restrict the Environment')
			const limited = reviewer((await init(free, dir)).actions)
			expect(limited).toContain('protect main')
			expect(limited).toContain('restrict the Environment')
			expect(limited.some((line) => line.includes('nor a required reviewer'))).toBe(true)
		})
	})

	test("init's own push starts no run: the scaffold's commits skip the workflow its push path would fire", () => {
		// The workflow runs on a push to main touching its own file, which every scaffold that creates or changes it is.
		expect(INITIAL_SCAFFOLD_COMMIT_MESSAGE).toContain('[skip ci]')
		expect(REFRESH_SCAFFOLD_COMMIT_MESSAGE).toContain('[skip ci]')
	})

	test("a sidecar pinning another tag keeps the operator's pin and starts no run", async () => {
		await inTemp(async (dir) => {
			const w = world()
			w.pin = 'v0.8.0'
			const { result, lines } = await init(w, dir)
			expect(result).toMatchObject({ triggered: false })
			expect(lines.some((line) => line.includes('pins v0.8.0, not v0.9.0'))).toBe(true)
		})
	})

	test('its arguments: every value as --flag=value or its variable, a tag and an image by digest; nothing else', async () => {
		await inTemp(async (dir) => {
			expect(parseAwsInitArgs(ARGV, {}, dir)).toMatchObject({
				repo: 'acme/fabrika-aws',
				fabrikaRef: 'v0.9.0',
				checkoutDir: join(dir, 'fabrika-aws-fabrika-aws'),
			})
			expect(parseAwsInitArgs(ARGV.filter((arg) => !arg.startsWith('--repo')), { FABRIKA_AWS_SIDECAR_REPO: 'acme/other' }, dir).repo).toBe('acme/other')
			expect(() => parseAwsInitArgs([...ARGV, '--token=hidden'], {}, dir)).toThrow('`--token` is not an argument of this command')
			expect(() => parseAwsInitArgs([...ARGV.slice(1), '--account-id', A], {}, dir)).toThrow('--account-id takes its value as --account-id=<value>')
			const swap = (flag: string, value: string) => ARGV.map((arg) => (arg.startsWith(`${flag}=`) ? `${flag}=${value}` : arg))
			expect(() => parseAwsInitArgs(swap('--repo', 'acme'), {}, dir)).toThrow('--repo is not <owner>/<name>')
			expect(() => parseAwsInitArgs(swap('--base-image', 'oven/bun:latest'), {}, dir)).toThrow('--base-image is not an image by digest')
			expect(() => parseAwsInitArgs(swap('--tag', 'main'), {}, dir)).toThrow()
			expect(() => parseAwsInitArgs(swap('--account-id', '1234'), {}, dir)).toThrow('--account-id is not an account id')
		})
	})
})
