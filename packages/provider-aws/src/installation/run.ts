// `fabrika platform install --provider=aws` and `upgrade` (the AWS idea's checklist, step 11, the commands' step): the
// one run of `apply.ts`, with the operator's own credentials, its images (`images-build.ts`) and its parameters
// (`parameters.ts`) from the release and the installation's choices.
//
// - **The account the credentials belong to is the one named**, checked first (STS `GetCallerIdentity`): credentials
//   of another account exported by mistake stop the run before it reads or writes anything there.
// - **Install or upgrade, never mistaken for each other.** The services' stack is the last thing a run applies, so it
//   tells them apart: `install` refuses an account whose services' stack exists (a second install would be a second
//   bring-up over the operator's choices), and resumes one that stopped before it; `upgrade` refuses one that has
//   none. An install that stopped once its services' stack was created is finished by `upgrade`, which the refusal
//   says.
// - **The installation's choices from its record** (`record.ts`): an install writes them before its first stack and
//   is resumed against them; an upgrade takes every choice the operator leaves out from it. A changed network range,
//   host or environment name is refused; a changed certificate or MCP authoring is named before the one question.
// - **One confirmation**, before anything is written; `--yes` answers it for a run nobody watches.
// - **The operator's credentials** from the standard variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
//   `AWS_SESSION_TOKEN`), as `aws configure export-credentials --format env` prints them; never logged.
//
// UNVERIFIED: the whole run against an account; the live check (step 13) is its first.

import type { Confirmations } from '@fabrika/installation-init'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import { cloudFormationClient } from '../aws/cloudformation'
import { codeBuildClient } from '../aws/codebuild'
import { ecrClient } from '../aws/ecr'
import { ecsPlatformTasks } from '../aws/ecs'
import { CODEBUILD, ECR, ECS, SSM } from '../aws/json'
import { CLOUDFORMATION } from '../aws/query'
import { s3BucketOrigin, s3PartWriter } from '../aws/s3'
import { type SsmPlatformSecrets, ssmPlatformSecrets } from '../aws/ssm'
import { STS, type StsClient, stsClient } from '../aws/sts'
import { type AwsClientOptions, type AwsCredentialSource, awsServiceOrigin } from '../aws/transport'
import { readStackOutputs } from '../stack'
import { awsSourcesBucket } from './access'
import { awsProvisioningKey, awsSchemaReconciler, registerAwsPlatformApps } from './admin'
import { applyAwsPlatform, type AwsPlatformApplied, type AwsPlatformApplyInput } from './apply'
import { type AwsImagesBuildRun, buildAwsPlatformImages } from './images-build'
import { AWS_NETWORK_STACKS, type AwsNetworkSide } from './network'
import { AWS_CHOICE_KEYS, awsChoiceFlag, awsChoicesFrom, type AwsCommonOptions, type AwsInstallOptions, type AwsUpgradeOptions } from './options'
import { writeAwsParameters } from './parameters'
import { awsPlatformManifest } from './platform-manifest'
import {
	AWS_INSTALLATION_RECORD,
	awsChoiceChanges,
	type AwsInstallationChoices,
	encodeAwsInstallationRecord,
	parseAwsInstallationRecord,
} from './record'
import { AWS_SERVICES_STACK } from './services'

/** The operator's credentials from the environment, read per call; refused, by name, when a key is missing. */
export function environmentCredentials(env: Readonly<Record<string, string | undefined>>): AwsCredentialSource {
	return {
		current: async () => {
			const accessKeyId = env['AWS_ACCESS_KEY_ID']?.trim() ?? ''
			const secretAccessKey = env['AWS_SECRET_ACCESS_KEY']?.trim() ?? ''
			const sessionToken = env['AWS_SESSION_TOKEN']?.trim() ?? ''
			if (accessKeyId === '' || secretAccessKey === '') {
				throw new Error("aws: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required: the operator's own credentials")
			}
			return sessionToken === '' ? { accessKeyId, secretAccessKey } : { accessKeyId, secretAccessKey, sessionToken }
		},
	}
}

/** The clients a run makes its calls with. */
export interface AwsPlatformClients {
	readonly sts: Pick<StsClient, 'callerAccount'>
	readonly cloudFormation: AwsPlatformApplyInput['cloudFormation']
	readonly tasks: AwsPlatformApplyInput['tasks']
	readonly secrets: SsmPlatformSecrets
	readonly codeBuild: AwsImagesBuildRun['codeBuild']
	readonly ecr: AwsImagesBuildRun['ecr']
	readonly manifestWriter: AwsImagesBuildRun['manifestWriter']
}

/** Each client over the operator's credentials, at its service's endpoint in the installation's region. */
export function awsPlatformClients(where: Pick<AwsCommonOptions, 'accountId' | 'region'>, credentials: AwsCredentialSource): AwsPlatformClients {
	const { region } = where
	const options = (service: { readonly service: string }): AwsClientOptions => ({ origin: awsServiceOrigin(service, region), region, credentials })
	const bucket = awsSourcesBucket(where.accountId)
	return {
		sts: stsClient(options(STS)),
		cloudFormation: cloudFormationClient(options(CLOUDFORMATION)),
		tasks: ecsPlatformTasks(options(ECS)),
		secrets: ssmPlatformSecrets(options(SSM)),
		codeBuild: codeBuildClient(options(CODEBUILD)),
		ecr: ecrClient(options(ECR)),
		manifestWriter: (key) =>
			s3PartWriter({ origin: s3BucketOrigin(bucket, region), region, credentials }, { bucket, region, accountId: where.accountId, key }),
	}
}

interface AwsPlatformRunShared {
	readonly clients: AwsPlatformClients
	readonly confirmations: Confirmations
	readonly signal: AbortSignal
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly log: (line: string) => void
	/** The run itself; `applyAwsPlatform` but in a test. */
	readonly apply?: (input: AwsPlatformApplyInput) => Promise<AwsPlatformApplied>
	/** IAM's provisioning surface; `@fabrika/auth`'s but in a test. */
	readonly reconcile?: SchemaReconciler
}

export type AwsPlatformRunInput =
	| (AwsPlatformRunShared & { readonly kind: 'install'; readonly options: AwsInstallOptions })
	| (AwsPlatformRunShared & { readonly kind: 'upgrade'; readonly options: AwsUpgradeOptions })

/** The installation's record, `null` when the account holds none. */
async function readRecord(secrets: Pick<SsmPlatformSecrets, 'readSecret'>, signal: AbortSignal): Promise<AwsInstallationChoices | null> {
	const text = await secrets.readSecret(AWS_INSTALLATION_RECORD, signal)
	return text === null ? null : parseAwsInstallationRecord(text)
}

/**
 * An upgrade's choices when the record is gone: every one named, none defaulted, and the two ranges the ones the network
 * stacks hold, so a lost record is written back without a range the installation does not have.
 */
async function rebuiltChoices(input: AwsPlatformRunInput & { readonly kind: 'upgrade' }): Promise<AwsInstallationChoices> {
	const { options, clients, signal } = input
	const named = input.options.named
	const missing = AWS_CHOICE_KEYS.filter((key) => key !== 'mcpAuthoring' && named[key] === undefined)
	if (missing.length > 0) {
		throw new Error(
			`aws: the installation in account ${options.accountId}, ${options.region} has no record at ${AWS_INSTALLATION_RECORD}; restore it from the keys' backup, or name every choice to write it back (missing: ${
				missing.map(awsChoiceFlag).join(', ')
			})`,
		)
	}
	const choices = awsChoicesFrom(options, named)
	for (const side of ['apps', 'platform'] satisfies AwsNetworkSide[]) {
		const outputs = await readStackOutputs(clients.cloudFormation, AWS_NETWORK_STACKS[side], signal)
		const held = outputs?.['VpcCidr']
		if (held !== choices.plan.vpcCidrs[side]) {
			throw new Error(`aws: the ${side} network holds ${held ?? 'no range'}, not the ${choices.plan.vpcCidrs[side]} named; name the range it holds`)
		}
	}
	return choices
}

/** The choices this run applies, refused where they would change what may not change; the changes it names. */
async function settledChoices(
	input: AwsPlatformRunInput,
	held: AwsInstallationChoices | null,
): Promise<{ readonly choices: AwsInstallationChoices; readonly named: readonly string[] }> {
	const { options } = input
	if (input.kind === 'install') {
		if (held === null) return { choices: input.options.choices, named: [] }
		const changes = awsChoiceChanges(held, input.options.choices)
		if (changes.refused.length > 0) {
			throw new Error(`aws: an install that stopped part way is resumed with its own choices, and these differ: ${changes.refused.join('; ')}`)
		}
		return { choices: input.options.choices, named: changes.named }
	}
	if (held === null) return { choices: await rebuiltChoices(input), named: [`the installation record, written back from the choices named`] }
	const choices = awsChoicesFrom(options, input.options.named, held)
	const changes = awsChoiceChanges(held, choices)
	if (changes.refused.length > 0) {
		throw new Error(`aws: an upgrade does not change ${changes.refused.join('; ')}; leave those flags out to keep the installation's own`)
	}
	return { choices, named: changes.named }
}

/** Installs or upgrades the platform: refuses the wrong account and the wrong command, asks once, then runs every stack. */
export async function runAwsPlatform(input: AwsPlatformRunInput): Promise<AwsPlatformApplied | null> {
	const { kind, options, clients, signal, log } = input
	const where = `account ${options.accountId}, ${options.region}`
	const caller = await clients.sts.callerAccount(signal)
	if (caller !== options.accountId) {
		throw new Error(`aws: the credentials in the environment are account ${caller}'s, not account ${options.accountId}'s; export the named account's`)
	}
	const exists = (await clients.cloudFormation.findStack(AWS_SERVICES_STACK, signal)) !== null
	if (kind === 'install' && exists) {
		throw new Error(
			`aws: ${where} already holds an installation; \`platform upgrade\` moves it to a release, and finishes an install that stopped once its services were created`,
		)
	}
	if (kind === 'upgrade' && !exists) throw new Error(`aws: ${where} holds no installation yet; \`platform install\` makes one`)
	const held = await readRecord(clients.secrets, signal)
	const { choices, named } = await settledChoices(input, held)
	const { plan } = choices
	const bringUp = input.kind === 'install' ? input.options.bringUp : undefined
	const manifest = awsPlatformManifest(plan, { mcp: choices.mcpAuthoring })
	log(`aws: ${kind === 'install' ? 'installing' : 'upgrading'} the platform in ${where}`)
	log(`aws: release ${options.release.repository} ${options.release.commitSha}`)
	log(`aws: hosts ${plan.hosts.iam}, ${plan.hosts.control}, ${plan.hosts.operations}; applications' default ${plan.appsDefault.host}`)
	log(`aws: networks ${plan.vpcCidrs.apps} (applications) and ${plan.vpcCidrs.platform} (platform); environment ${choices.environment}`)
	for (const change of named) log(`aws: changing ${change}`)
	const agreed = await input.confirmations.confirm(
		kind === 'install'
			? 'Create the networks, balancers, database, images and services of a new installation in this account?'
			: 'Apply this release to the installation: its images, database setup, parameters and services?',
	)
	if (!agreed) {
		log('aws: nothing was changed')
		return null
	}
	const recordText = encodeAwsInstallationRecord(choices)
	if (held === null || encodeAwsInstallationRecord(held) !== recordText) await clients.secrets.putSecret(AWS_INSTALLATION_RECORD, recordText, signal)
	const apply = input.apply ?? applyAwsPlatform
	const applied = await apply({
		plan,
		cloudFormation: clients.cloudFormation,
		tasks: clients.tasks,
		secrets: clients.secrets,
		images: (state) =>
			buildAwsPlatformImages({
				state,
				release: options.release,
				manifest,
				codeBuild: clients.codeBuild,
				ecr: clients.ecr,
				manifestWriter: clients.manifestWriter,
				signal,
				sleep: input.sleep,
				log,
			}),
		parameters: (state) =>
			writeAwsParameters({
				state,
				environment: choices.environment,
				...(bringUp === undefined ? {} : { bringUp }),
				manifest: manifest.deployed,
				release: options.release,
				baseImage: options.baseImage,
				secrets: clients.secrets,
				signal,
				log,
			}),
		signal,
		sleep: input.sleep,
		log,
	})
	if (kind === 'upgrade') {
		// A release may change the console's vocabulary or IAM's: registered once the services it describes serve.
		await registerAwsPlatformApps({
			plan,
			provisioningKey: await awsProvisioningKey(clients.secrets, signal),
			reconcile: input.reconcile ?? awsSchemaReconciler,
			signal,
			log,
		})
	} else {
		log(`aws: next, point the hosts at ${applied.balancers.platformBalancerDnsName}, then \`platform admin --provider=aws\` registers the console and`)
		log('aws: admits the first administrator')
	}
	return applied
}
