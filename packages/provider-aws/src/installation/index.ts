// The AWS installation's commands (`fabrika platform <command> --provider=aws`), which the CLI loads from
// `@fabrika/provider-aws/installation` through the open installation contract.

import { confirmations, describeArgument, UNATTENDED_FLAG } from '@fabrika/installation-init'
import type { InstallationCli, InstallationCommand } from '@fabrika/provider-contract/installation'
import { fileURLToPath } from 'node:url'
import { awsAdmitFirstAdministrator, awsSchemaReconciler, parseAwsAdminArgs, runAwsAdmin } from './admin'
import { parseAwsInstallArgs, parseAwsUpgradeArgs } from './options'
import { awsPlatformClients, environmentCredentials, runAwsPlatform } from './run'

const USAGE = `AWS installation (under construction: not yet run against an account)

New here, or an agent? Run \`fabrika platform guide --provider=aws\` first: the whole bring-up in order.

Commands:
  fabrika platform guide   --provider=aws
  fabrika platform install --provider=aws [options]
  fabrika platform upgrade --provider=aws [options]
  fabrika platform admin   --provider=aws --account-id=<12 digits> --region=<region> --email=<address> [--reissue]

\`install\` makes an installation in an AWS account and region that holds none, or finishes one that stopped
before its services were created; \`upgrade\` moves an existing one to a release, and finishes an install that
stopped after. Both check first that the credentials are the named account's. An install names every choice
below and records them in the account; an upgrade takes every choice it does not name from that record, refuses a
changed network range, host or environment name, and names a changed certificate or MCP switch before it asks. Each
asks once before it writes anything; ${UNATTENDED_FLAG} answers yes for a run nobody watches.

Both (each also from the variable beside it):
  --account-id=<12 digits>          FABRIKA_AWS_ACCOUNT_ID
  --region=<region>                 FABRIKA_AWS_REGION
  --commit=<40 hex>                 the release's commit (FABRIKA_PLATFORM_COMMIT)
  --repository=<owner/name>         contember/fabrika-platform unless named
  --base-image=<image@sha256:...>   the Bun image applications build from (FABRIKA_AWS_BASE_IMAGE)
  ${UNATTENDED_FLAG}

The installation's choices (an install names each; an upgrade only what it changes):
  --iam-host, --control-host, --operations-host=<host>
                                    FABRIKA_PLATFORM_IAM_HOST, _CONTROL_HOST, _OPERATIONS_HOST
  --iam-certificate, --control-certificate, --operations-certificate=<ACM ARN>
                                    FABRIKA_AWS_IAM_CERTIFICATE, _CONTROL_CERTIFICATE, _OPERATIONS_CERTIFICATE
  --apps-host=<host> --apps-certificate=<ACM ARN>
                                    the applications' listener's default (FABRIKA_AWS_APPS_HOST, _APPS_CERTIFICATE)
  --apps-vpc-cidr, --platform-vpc-cidr=<a /16>
                                    an install's 10.80.0.0/16 and 10.81.0.0/16 unless named
  --environment=<name>              FABRIKA_PLATFORM_ENVIRONMENT
  --mcp-authoring=<on|off>          an install's off unless named

Install only: --auth-methods=<oidc|password|oidc,password> (password unless named), --oidc-issuer and
--oidc-client-id with FABRIKA_IAM_OIDC_CLIENT_SECRET in the environment, and --email-provider,
--email-from, --email-from-name with the provider's own variables.

\`admin\` comes last, once the hosts point at the platform's balancer: it registers the console and IAM's vocabulary
with IAM and admits the first administrator (FABRIKA_PLATFORM_ADMIN_EMAIL for --email). IAM's provisioning key is read
from the installation itself, never given. An enrollment URL it prints is a credential: printed once, stored nowhere.

Credentials: the operator's own, as \`aws configure export-credentials --format env\` prints them
(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN). They are never logged.
`

const COMMANDS: readonly InstallationCommand[] = ['install', 'upgrade', 'admin', 'guide']

/** The operator's guide of this release, shipped beside this module. */
export const readAwsInstallationGuide = (): Promise<string> => Bun.file(fileURLToPath(new URL('./guide.md', import.meta.url))).text()

/** Waits `ms`, or rejects once `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		const stop = (): void => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop)
			resolve()
		}, ms)
		signal.addEventListener('abort', stop, { once: true })
	})

const runPlatform = async (kind: 'install' | 'upgrade', argv: readonly string[]): Promise<void> => {
	const log = (line: string): void => console.info(line)
	const shared = (options: { readonly accountId: string; readonly region: string; readonly unattended: boolean }) => ({
		clients: awsPlatformClients(options, environmentCredentials(process.env)),
		confirmations: confirmations(options.unattended, process.stdin, log, `${kind}s the platform in an AWS account`),
		signal: new AbortController().signal,
		sleep,
		log,
	})
	if (kind === 'install') {
		const options = parseAwsInstallArgs(argv, process.env)
		await runAwsPlatform({ kind, options, ...shared(options) })
		return
	}
	const options = parseAwsUpgradeArgs(argv, process.env)
	await runAwsPlatform({ kind, options, ...shared(options) })
}

export const installationCli: InstallationCli = {
	provider: 'aws',
	commands: COMMANDS,
	usage: USAGE,
	async run(command, argv) {
		if (command === 'guide') {
			if (argv.length > 0) throw new Error(`Unexpected AWS guide arguments: ${argv.map(describeArgument).join(' ')}`)
			console.info(await readAwsInstallationGuide())
			return
		}
		if (command === 'install' || command === 'upgrade') {
			await runPlatform(command, argv)
			return
		}
		if (command === 'admin') {
			const options = parseAwsAdminArgs(argv, process.env)
			const clients = awsPlatformClients(options, environmentCredentials(process.env))
			await runAwsAdmin({
				options,
				sts: clients.sts,
				secrets: clients.secrets,
				reconcile: awsSchemaReconciler,
				admit: awsAdmitFirstAdministrator,
				signal: new AbortController().signal,
				log: (line) => console.info(line),
				// stdout alone, on a line of its own: the enrollment URL.
				print: (line) => process.stdout.write(`${line}\n`),
			})
			return
		}
		throw new Error(`the AWS installation does not support \`platform ${command}\`\n\n${USAGE}`)
	},
}
