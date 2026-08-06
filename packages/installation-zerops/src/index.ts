import { reconcileSchema } from '@fabrika/auth'
import type { InstallationCli, InstallationCommand } from '@fabrika/installation-contract'
import { createZeropsApi, defaultSleep } from '@fabrika/provider-zerops'
import { generatedArtifacts } from '../zerops/artifacts'
import { assertArtifactMatchesSchema } from '../zerops/validate'
import { deployPlatform, PLATFORM_DEPLOY_ORDER } from './deploy'
import { parsePlatformDeployArgs } from './deploy-options'
import { consoleDeployLog } from './log'

const USAGE = `Zerops installation

Commands:
  fabrika platform plan   --provider=zerops
  fabrika platform deploy --provider=zerops [options]

\`platform init\` is not available for Zerops: the first bring-up (import the topology without code,
write every secret, then deploy) is still performed by hand. \`platform deploy\` updates an
installation that already exists; it never creates one.

── platform deploy ───────────────────────────────────────────────────────────────────────────────

Unattended and idempotent. It owns the WHOLE ordered sequence, so an operator's pipeline calls this
ONE step — on Cloudflare the order lives in the scaffolded workflow instead, deliberately
(ADR-0027). In order:

  1. resolve the project and its ${PLATFORM_DEPLOY_ORDER.join(', ')} services by hostname
  2. write each service's environment: the composed proxy manifest, the installation's environment
     name, and the origins derived from the resolved public hosts
  3. deploy ${PLATFORM_DEPLOY_ORDER.join(' → ')}, waiting for each to become ACTIVE
  4. reconcile the console's app schema and register its return origin with IAM
  5. ensure the proxy's public entry point

The order is a security property, not just a dependency: the application enforces nothing
(ADR-0022), so the proxy is deployed BEFORE control, and every environment write happens before any
deploy. A run that cannot apply the manifest never reaches step 3.

The proxy manifest is MERGED, never replaced. On a shared project an application's entry lives in the
same document; entries the platform does not own are carried through unchanged. An entry standing on
one of the platform's own public hosts is replaced, and the run says so.

Options (a flag beats the environment variable beside it):

  --project-id=<id>                 FABRIKA_ZEROPS_PROJECT_ID       the installation's project
  --project-name=<name>             FABRIKA_ZEROPS_PROJECT_NAME     with --client-id, instead of the id
  --client-id=<id>                  FABRIKA_ZEROPS_CLIENT_ID
  --env=<name>                      FABRIKA_PLATFORM_ENVIRONMENT    written to every service as ENVIRONMENT
  --iam-host=<host>                 FABRIKA_PLATFORM_IAM_HOST       all three, or none
  --console-host=<host>             FABRIKA_PLATFORM_CONSOLE_HOST
  --operations-host=<host>          FABRIKA_PLATFORM_OPERATIONS_HOST
  --scheme=<http|https>             FABRIKA_PLATFORM_SCHEME         default https
  --from-git=<url>                  FABRIKA_ZEROPS_BUILD_FROM_GIT   public repository to build from
  --dry-run                                                         read everything, change nothing

Naming NO host derives all three from the proxy service's Zerops subdomains and makes this a
\`zerops-subdomain\` installation, whose public entry point step 5 ensures. Naming all three makes it a
\`custom-domain\` installation: the domains are bound to the project balancer out of band and no
subdomain is published.

Credentials are read from the ENVIRONMENT ONLY and have no flag, so they cannot reach a CI log or a
process listing:

  FABRIKA_ZEROPS_ACCESS_TOKEN       required   Zerops access token (an INTEGRATION token scoped to
                                               this installation's projects, never a personal one)
  FABRIKA_IAM_PROVISIONING_KEY      required   the IAM-issued px_ admin key step 4 authenticates with
                                               (a --dry-run does not need it)
  FABRIKA_ZEROPS_API_URL            optional   region API base, when not the default

This command writes NO credential. Every secret an installation holds is placed at bring-up.
`

/** No cancellation source exists behind a CLI invocation; the ports all take a signal regardless. */
const neverAborted = (): AbortSignal => new AbortController().signal

const runPlan = (argv: readonly string[]): void => {
	if (argv.length > 0) {
		throw new Error(`Unexpected Zerops plan arguments: ${argv.join(' ')}`)
	}
	const artifacts = generatedArtifacts()
	for (const artifact of artifacts) {
		assertArtifactMatchesSchema(artifact)
		console.info(artifact.path)
	}
	console.info(`${artifacts.length} Zerops installation artifact(s) validated`)
}

const runDeploy = async (argv: readonly string[]): Promise<void> => {
	const input = parsePlatformDeployArgs(argv, process.env)
	await deployPlatform(input, {
		api: createZeropsApi({
			token: input.accessToken,
			...(input.apiBaseUrl === undefined ? {} : { baseUrl: input.apiBaseUrl }),
		}),
		reconcileSchema: (call) =>
			reconcileSchema({
				url: call.url,
				app: call.app,
				schema: call.schema,
				...(call.returnOrigins === undefined ? {} : { returnOrigins: call.returnOrigins }),
				...(call.adminKey === undefined ? {} : { adminKey: call.adminKey }),
				signal: call.signal,
			}),
		sleep: defaultSleep,
		log: consoleDeployLog(),
		signal: neverAborted(),
	})
}

export const installationCli: InstallationCli = {
	provider: 'zerops',
	commands: ['plan', 'deploy'],
	usage: USAGE,
	run: async (command: InstallationCommand, argv: readonly string[]) => {
		if (command === 'plan') {
			runPlan(argv)
			return
		}
		if (command === 'deploy') {
			await runDeploy(argv)
			return
		}
		throw new Error(`Zerops installation does not support \`platform ${command}\``)
	},
}
