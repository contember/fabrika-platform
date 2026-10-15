import { IAM_APP_ID, IAM_APP_SCHEMA } from '@fabrika/iam-contract'
import type { InstallationCli, InstallationCommand } from '@fabrika/provider-contract/installation'
import { resolve } from 'node:path'
import { parseCloudflareArgs, platformComponents } from '../cli-args'
import { deployCloudflareConfig } from '../command'
import type { PlatformIamTarget } from '../provider'
import { defaultReconcileSchema } from '../schema'
import { initCommand } from './init'

const USAGE = `Cloudflare installation

Commands:
  fabrika platform init --provider=cloudflare <account> --console-host=<host> --operations-host=<host> --iam-host=<host>
      --auth-methods=<oidc|password|oidc,password> --email-provider=<none|resend> [options] [--yes]
  fabrika platform plan --provider=cloudflare --runner-config=<path> --worker-config=<path> [--env=<env>]
  fabrika platform deploy --provider=cloudflare --runner-config=<path> --worker-config=<path> [--env=<env>]
  fabrika platform plan --provider=cloudflare --component-config=<path> [--env=<env>]
  fabrika platform deploy --provider=cloudflare --component-config=<path> [--env=<env>]

init prompts for nothing. Every value is a flag or the environment variable beside it, flag first:
  --account-id=<id>             CLOUDFLARE_ACCOUNT_ID             required when the token acts on several accounts
  --repo=<owner>/<name>                                           default <account>/fabrika-platform
  --checkout=<dir>                                                default ./fabrika-platform-<account>, outside any git repository
  --console-host=<host>         FABRIKA_CONTROL_DOMAIN            the control plane's hostname
  --operations-host=<host>      OPERATIONS_HOSTNAME               the Operations ingest hostname
  --iam-host=<host>             FABRIKA_IAM_HOSTNAME              IAM's hostname; its issuer is https://<host>
  --admins=<email,...>          FABRIKA_CONTROL_BOOTSTRAP_ADMINS  first admins for the escape hatch
  --auth-methods=<methods>      FABRIKA_IAM_OIDC_ENABLED + FABRIKA_IAM_PASSWORD_ENABLED
  --oidc-issuer=<url>           FABRIKA_IAM_OIDC_ISSUER           default https://accounts.google.com
  --oidc-client-id=<id>         FABRIKA_IAM_OIDC_CLIENT_ID        absent: a placeholder, human SSO login stays inert
  --human-email-domains=<d,...> FABRIKA_IAM_HUMAN_EMAIL_DOMAINS   who may self-provision at login
  --email-provider=<none|resend> FABRIKA_EMAIL_PROVIDER
  --email-from=<sender>         FABRIKA_EMAIL_FROM                required for resend
Credentials come from the environment only: CLOUDFLARE_API_TOKEN, FABRIKA_IAM_OIDC_CLIENT_SECRET (a real
OIDC client), FABRIKA_EMAIL_RESEND_API_KEY (resend). The account's installer env file resumes all of them.
The env file resumes the account id, the auth methods, the OIDC issuer and client id, the email provider
and sender, and every credential; the hosts, repository, checkout and admins are not saved. An empty flag
(such as --oidc-client-id=) counts as absent and falls back to that saved value; to return to the
placeholder client, remove FABRIKA_IAM_OIDC_CLIENT_ID and FABRIKA_IAM_OIDC_CLIENT_SECRET from the env file.
init confirms before it goes on with a token it could not verify ("Proceed anyway?"), creates or pushes the repository,
writes the Environment and triggers the workflow. --yes answers all of them yes; without it, init needs a
terminal.

The pair form deploys the executor then the control plane. The single-component form deploys exactly
one platform config (IAM, Operations) — the stages a pipeline runs before that pair exists. Both may
name a platform resource; \`fabrika app deploy\` may not.
`

/** IAM's origin and the provisioning key, when the stage names both; a component with a schema needs them. */
const platformIam = (): PlatformIamTarget | undefined => {
	const url = process.env['FABRIKA_IAM_ISSUER']
	const adminKey = process.env['FABRIKA_IAM_PROVISIONING_KEY']
	return url === undefined || url === '' || adminKey === undefined || adminKey === '' ? undefined : { url, adminKey }
}

const deployPlatform = async (argv: readonly string[], forceDryRun: boolean): Promise<void> => {
	const args = parseCloudflareArgs(['platform', 'deploy', ...argv, ...(forceDryRun ? ['--dry-run'] : [])])
	const env = args.env ?? 'prod'
	const stateNamespace = process.env['CLOUDFLARE_STATE_NAMESPACE']
	const iam = platformIam()
	const rootCwd = process.cwd()
	for (const component of platformComponents(args)) {
		const absolute = resolve(rootCwd, component.configPath)
		const cwd = resolve(absolute, '..')
		process.chdir(cwd)
		try {
			console.info(`\n▸ ${component.label} → ${env}${args.dryRun ? ' (dry-run)' : ''}`)
			// This IS the platform deploying itself; an application deploy through the runner never gets this.
			const result = await deployCloudflareConfig({
				env,
				configPath: absolute,
				cwd,
				dryRun: args.dryRun,
				platformResources: 'allow',
				...(iam === undefined ? {} : { platformIam: iam }),
				// Honoured because the scaffolded workflow states it on the IAM stage; absent elsewhere.
				...(stateNamespace === undefined ? {} : { stateNamespace }),
			})
			console.info(`${result.appId} → ${result.env}: ${result.status}`)
			if (result.status === 'failed') {
				throw new Error(`${component.label} deployment failed`)
			}
		} finally {
			process.chdir(rootCwd)
		}
	}
	// IAM's own vocabulary registers beside the console's (ADR-0058): its own stage cannot, its keys sync after it deploys.
	if (args.componentConfig === undefined || args.componentConfig === '') {
		await registerIamVocabulary(iam, args.dryRun)
	}
}

const registerIamVocabulary = async (iam: PlatformIamTarget | undefined, dryRun: boolean): Promise<void> => {
	if (dryRun) {
		console.info(`would reconcile \`${IAM_APP_ID}\`'s own vocabulary with IAM`)
		return
	}
	if (iam === undefined) {
		throw new Error(`registering \`${IAM_APP_ID}\`'s vocabulary needs FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY`)
	}
	await defaultReconcileSchema({ url: iam.url, app: IAM_APP_ID, schema: IAM_APP_SCHEMA, adminKey: iam.adminKey, signal: new AbortController().signal })
	console.info(`${IAM_APP_ID}: vocabulary reconciled`)
}

const run = async (command: InstallationCommand, argv: readonly string[]): Promise<void> => {
	if (command === 'init') {
		await initCommand(argv)
		return
	}
	if (command !== 'plan' && command !== 'deploy') {
		// The router already filters on `commands`, so this is unreachable today — and it is the branch that
		// keeps it unreachable: without it, a command added to the contract later falls through to a deploy.
		throw new Error(`Cloudflare installation does not support \`platform ${command}\``)
	}
	await deployPlatform(argv, command === 'plan')
}

export const cloudflareInstallationCli: InstallationCli = {
	provider: 'cloudflare',
	commands: ['init', 'plan', 'deploy'],
	usage: USAGE,
	run,
}
