// The AWS installation's commands (`fabrika platform <command> --provider=aws`), which the CLI loads from
// `@fabrika/provider-aws/installation` through the open installation contract.

import { confirmations, describeArgument, UNATTENDED_FLAG } from '@fabrika/installation-init'
import type { InstallationCli, InstallationCommand } from '@fabrika/provider-contract/installation'
import { fileURLToPath } from 'node:url'
import { parseAwsInstallArgs, parseAwsUpgradeArgs } from './options'
import { awsPlatformClients, environmentCredentials, runAwsPlatform } from './run'

const USAGE = `AWS installation (under construction: not yet run against an account)

New here, or an agent? Run \`fabrika platform guide --provider=aws\` first: the whole bring-up in order.

Commands:
  fabrika platform guide   --provider=aws
  fabrika platform install --provider=aws [options]
  fabrika platform upgrade --provider=aws [options]

\`install\` makes an installation in an AWS account and region that holds none, or finishes one that stopped
part way; \`upgrade\` moves an existing one to a release. Both take the same options, and an install also how
people sign in and the outbound mail. Each asks once before it writes anything; ${UNATTENDED_FLAG} answers yes for a
run nobody watches.

Options (each also from the variable beside it):
  --account-id=<12 digits>          FABRIKA_AWS_ACCOUNT_ID
  --region=<region>                 FABRIKA_AWS_REGION
  --iam-host, --control-host, --operations-host=<host>
                                    FABRIKA_PLATFORM_IAM_HOST, _CONTROL_HOST, _OPERATIONS_HOST
  --iam-certificate, --control-certificate, --operations-certificate=<ACM ARN>
                                    FABRIKA_AWS_IAM_CERTIFICATE, _CONTROL_CERTIFICATE, _OPERATIONS_CERTIFICATE
  --apps-host=<host> --apps-certificate=<ACM ARN>
                                    the applications' listener's default (FABRIKA_AWS_APPS_HOST, _APPS_CERTIFICATE)
  --apps-vpc-cidr, --platform-vpc-cidr=<a /16>
                                    10.80.0.0/16 and 10.81.0.0/16 unless named
  --environment=<name>              FABRIKA_PLATFORM_ENVIRONMENT
  --commit=<40 hex>                 the release's commit (FABRIKA_PLATFORM_COMMIT)
  --repository=<owner/name>         contember/fabrika-platform unless named
  --base-image=<image@sha256:...>   the Bun image applications build from (FABRIKA_AWS_BASE_IMAGE)
  --mcp-authoring=<on|off>          off unless named
  ${UNATTENDED_FLAG}

Install only: --auth-methods=<oidc|password|oidc,password> (password unless named), --oidc-issuer and
--oidc-client-id with FABRIKA_IAM_OIDC_CLIENT_SECRET in the environment, and --email-provider,
--email-from, --email-from-name with the provider's own variables.

Credentials: the operator's own, as \`aws configure export-credentials --format env\` prints them
(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN). They are never logged.
`

const COMMANDS: readonly InstallationCommand[] = ['install', 'upgrade', 'guide']

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
	const options = kind === 'install' ? parseAwsInstallArgs(argv, process.env) : parseAwsUpgradeArgs(argv, process.env)
	const log = (line: string): void => console.info(line)
	await runAwsPlatform({
		kind,
		options,
		clients: awsPlatformClients(options.plan, environmentCredentials(process.env)),
		confirmations: confirmations(options.unattended, process.stdin, log, `${kind}s the platform in an AWS account`),
		signal: new AbortController().signal,
		sleep,
		log,
	})
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
		throw new Error(`the AWS installation does not support \`platform ${command}\`\n\n${USAGE}`)
	},
}
