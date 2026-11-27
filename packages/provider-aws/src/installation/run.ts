// `fabrika platform install --provider=aws` and `upgrade` (the AWS idea's checklist, step 11, the commands' step): the
// one run of `apply.ts`, with the operator's own credentials, its images (`images-build.ts`) and its parameters
// (`parameters.ts`) from the release and the hosts the operator names.
//
// - **Install or upgrade, never mistaken for each other.** The services' stack is the last thing a run applies, so it
//   tells them apart: `install` refuses an installation whose services' stack exists (a second install would write a
//   sign-in method or a mailer over the operator's, and make anew a key that was lost), and resumes one that stopped
//   before it; `upgrade` refuses one that has none.
// - **One confirmation**, naming what the run does, before anything is written; `--yes` answers it for a run nobody
//   watches.
// - **The operator's credentials** from the standard variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
//   `AWS_SESSION_TOKEN`), as `aws configure export-credentials --format env` prints them; never logged.
//
// UNVERIFIED: the whole run against an account; the live check (step 13) is its first.

import type { Confirmations } from '@fabrika/installation-init'
import { type CloudFormationClient, cloudFormationClient } from '../aws/cloudformation'
import { codeBuildClient } from '../aws/codebuild'
import { ecrClient } from '../aws/ecr'
import { ecsPlatformTasks } from '../aws/ecs'
import { CODEBUILD, ECR, ECS, SSM } from '../aws/json'
import { CLOUDFORMATION } from '../aws/query'
import { s3BucketOrigin, s3PartWriter } from '../aws/s3'
import { type SsmPlatformSecrets, ssmPlatformSecrets } from '../aws/ssm'
import { type AwsClientOptions, type AwsCredentialSource, awsServiceOrigin } from '../aws/transport'
import { awsSourcesBucket } from './access'
import { applyAwsPlatform, type AwsPlatformApplied, type AwsPlatformApplyInput } from './apply'
import { type AwsImagesBuildRun, buildAwsPlatformImages } from './images-build'
import type { AwsInstallOptions, AwsPlatformOptions } from './options'
import { writeAwsParameters } from './parameters'
import { awsPlatformManifest } from './platform-manifest'
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
	readonly cloudFormation: AwsPlatformApplyInput['cloudFormation']
	readonly tasks: AwsPlatformApplyInput['tasks']
	readonly secrets: SsmPlatformSecrets
	readonly codeBuild: AwsImagesBuildRun['codeBuild']
	readonly ecr: AwsImagesBuildRun['ecr']
	readonly manifestWriter: AwsImagesBuildRun['manifestWriter']
}

/** Each client over the operator's credentials, at its service's endpoint in the installation's region. */
export function awsPlatformClients(plan: AwsPlatformOptions['plan'], credentials: AwsCredentialSource): AwsPlatformClients {
	const options = (service: { readonly service: string }): AwsClientOptions => ({
		origin: awsServiceOrigin(service, plan.region),
		region: plan.region,
		credentials,
	})
	const bucket = awsSourcesBucket(plan.accountId)
	return {
		cloudFormation: cloudFormationClient(options(CLOUDFORMATION)),
		tasks: ecsPlatformTasks(options(ECS)),
		secrets: ssmPlatformSecrets(options(SSM)),
		codeBuild: codeBuildClient(options(CODEBUILD)),
		ecr: ecrClient(options(ECR)),
		manifestWriter: (key) =>
			s3PartWriter(
				{ origin: s3BucketOrigin(bucket, plan.region), region: plan.region, credentials },
				{ bucket, region: plan.region, accountId: plan.accountId, key },
			),
	}
}

export interface AwsPlatformRunInput {
	readonly kind: 'install' | 'upgrade'
	readonly options: AwsPlatformOptions | AwsInstallOptions
	readonly clients: AwsPlatformClients
	readonly confirmations: Confirmations
	readonly signal: AbortSignal
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly log: (line: string) => void
	/** The run itself; `applyAwsPlatform` but in a test. */
	readonly apply?: (input: AwsPlatformApplyInput) => Promise<AwsPlatformApplied>
}

/** Whether the installation's services' stack exists: what tells an installation from one still to be made. */
async function servicesExist(cloudFormation: Pick<CloudFormationClient, 'findStack'>, signal: AbortSignal): Promise<boolean> {
	return (await cloudFormation.findStack(AWS_SERVICES_STACK, signal)) !== null
}

/** Installs or upgrades the platform: refuses the wrong one, asks once, then runs every stack in order. */
export async function runAwsPlatform(input: AwsPlatformRunInput): Promise<AwsPlatformApplied | null> {
	const { kind, options, clients, signal, log } = input
	const { plan } = options
	const exists = await servicesExist(clients.cloudFormation, signal)
	if (kind === 'install' && exists) {
		throw new Error(`aws: account ${plan.accountId} in ${plan.region} already holds an installation; \`platform upgrade\` moves it to a release`)
	}
	if (kind === 'upgrade' && !exists) {
		throw new Error(`aws: account ${plan.accountId} in ${plan.region} holds no installation yet; \`platform install\` makes one`)
	}
	const bringUp = 'bringUp' in options ? options.bringUp : undefined
	const manifest = awsPlatformManifest(plan, { mcp: options.mcpAuthoring })
	log(`aws: ${kind === 'install' ? 'installing' : 'upgrading'} the platform in account ${plan.accountId}, ${plan.region}`)
	log(`aws: release ${options.release.repository} ${options.release.commitSha}`)
	log(`aws: hosts ${plan.hosts.iam}, ${plan.hosts.control}, ${plan.hosts.operations}; applications' default ${plan.appsDefault.host}`)
	const agreed = await input.confirmations.confirm(
		kind === 'install'
			? 'Create the networks, balancers, database, images and services of a new installation in this account?'
			: 'Apply this release to the installation: its images, database setup, parameters and services?',
	)
	if (!agreed) {
		log('aws: nothing was changed')
		return null
	}
	const apply = input.apply ?? applyAwsPlatform
	return apply({
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
				environment: options.environment,
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
}
