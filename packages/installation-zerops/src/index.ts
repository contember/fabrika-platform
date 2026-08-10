import { reconcileSchema } from '@fabrika/auth'
import type { InstallationCli, InstallationCommand } from '@fabrika/installation-contract'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import { createZeropsApi, defaultSleep } from '@fabrika/provider-zerops'
import { generatedArtifacts } from '../zerops/artifacts'
import { assertArtifactMatchesSchema } from '../zerops/validate'
import { deployPlatform, PLATFORM_DEPLOY_ORDER } from './deploy'
import { parsePlatformDeployArgs } from './deploy-options'
import { consoleInitCollaborators, parseInitArgs, runInit } from './init'
import { consoleInstallCollaborators, runInstall } from './install'
import { parsePlatformInstallArgs } from './install-options'
import { consoleDeployLog } from './log'

const USAGE = `Zerops installation

Commands:
  fabrika platform install --provider=zerops [options]
  fabrika platform init    --provider=zerops <installation> [--repo=<owner>/<name>]
  fabrika platform plan    --provider=zerops
  fabrika platform deploy  --provider=zerops [options]

\`install\` CREATES an installation in a project you created empty; \`init\` and \`deploy\` UPDATE AN
INSTALLATION THAT ALREADY EXISTS. Run them in that order: install generates the provisioning key that
init then writes into the operator's GitHub Environment.

── platform install ──────────────────────────────────────────────────────────────────────────────

The from-scratch bring-up. You create an EMPTY Zerops project with core package LIGHT and
\`envIsolation: service\` — a project-level setting Zerops accepts at creation only, and which this
command cannot read back or correct — and everything after that is this command.

Interactive and laptop-side. It CONFIRMS before every step that leaves your machine: reading the
project, importing the services, minting the token, building the proxy, writing the variables, and
deploying. Declining any of them stops there; nothing before the import is a mutation.

  1. read the project and refuse a core package the selected tier does not match
  2. import ${PLATFORM_DEPLOY_ORDER.length + 2} services without code, and wait for the import's processes
  3. generate six secrets and mint the control plane's Zerops INTEGRATION token
     (client role NO_ACCESS, ADMIN on this project only — never your personal token)
  4. pass 1: give the proxy an EMPTY manifest and build it, so it publishes one public hostname per
     HTTP port; the three platform hosts are then READ off those, never composed
  5. write every remaining variable on all four services
  6. pass 2: hand the whole ordered sequence to \`platform deploy\`
  7. print the provisioning key ONCE — it is stored nowhere else

It REFUSES a project that already holds an installation's generated secrets: a second bring-up would
roll a new vault key over the old one, which is unrecoverable, and new signing keys, which logs
everyone out. Update an existing installation with \`platform deploy\`.

Only the LIGHT tier can be installed this way — it is the one topology that emits a services-only
import document. Authentication is PASSWORD ONLY; no administrator exists yet when this finishes.

Options (a flag beats the environment variable beside it):

  --project-id=<id>                 FABRIKA_ZEROPS_PROJECT_ID       the empty project you created
  --client-id=<id>                  FABRIKA_ZEROPS_CLIENT_ID        the client the token is minted on
  --env=<name>                      FABRIKA_PLATFORM_ENVIRONMENT    written to every service as ENVIRONMENT
  --scheme=<http|https>             FABRIKA_PLATFORM_SCHEME         default https
  --from-git=<url>                  FABRIKA_ZEROPS_BUILD_FROM_GIT   public repository every service builds from
  --tier=light                      FABRIKA_PLATFORM_TIER           default light, and the only value

  FABRIKA_ZEROPS_ACCESS_TOKEN       required   Zerops access token, environment only and no flag
  FABRIKA_ZEROPS_API_URL            optional   region API base, when not the default

── platform init ─────────────────────────────────────────────────────────────────────────────────

Creates and maintains the operator's SIDECAR REPOSITORY: the GitHub pipeline that calls
\`platform deploy\`, the tag it is pinned to, and the GitHub Environment holding this installation's
credentials. ADR-0025 puts that pipeline in a repository the operator owns — fabrika ships the
generator, never the pipeline, because one public repository cannot hold every account's credentials.

Interactive and laptop-side. It does the whole job and CONFIRMS before every step that leaves the
operator's disk: creating the repository, pushing it, writing the Environment, triggering the run.
Declining any of them stops there and prints what to run instead; a re-run is safe.

  <installation>                    names this installation: the GitHub Environment, the default
                                    repository \`contember/fabrika-zerops-<installation>\`, and the
                                    local checkout directory
  --repo=<owner>/<name>             a different sidecar repository

It writes TWO secrets into that Environment and GENERATES NEITHER — both already belong to the
installation, so a value invented here would not be one it accepts:

  FABRIKA_ZEROPS_ACCESS_TOKEN       a Zerops INTEGRATION token scoped to this installation's projects
  FABRIKA_IAM_PROVISIONING_KEY      the px_ admin key this installation's IAM was seeded with

Each is read from a hidden prompt or from the environment variable of the same name, sent to GitHub
over \`gh\` stdin, and never printed and never written to disk.

The generated pipeline pins a published TAG of contember/fabrika-platform and refuses a branch, at
init and again in the workflow. That tag decides what the pipeline DOES; it does not decide which
revision Zerops BUILDS, because a Zerops build source names a repository and not a revision.

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

/** The one collaborator both the deploy and the install reach IAM's provisioning surface through. */
const consoleSchemaReconciler: SchemaReconciler = (call) =>
	reconcileSchema({
		url: call.url,
		app: call.app,
		schema: call.schema,
		...(call.returnOrigins === undefined ? {} : { returnOrigins: call.returnOrigins }),
		...(call.adminKey === undefined ? {} : { adminKey: call.adminKey }),
		signal: call.signal,
	})

const runDeploy = async (argv: readonly string[]): Promise<void> => {
	const input = parsePlatformDeployArgs(argv, process.env)
	await deployPlatform(input, {
		api: createZeropsApi({
			token: input.accessToken,
			...(input.apiBaseUrl === undefined ? {} : { baseUrl: input.apiBaseUrl }),
		}),
		reconcileSchema: consoleSchemaReconciler,
		sleep: defaultSleep,
		log: consoleDeployLog(),
		signal: neverAborted(),
	})
}

const runPlatformInstall = async (argv: readonly string[]): Promise<void> => {
	const input = parsePlatformInstallArgs(argv, process.env)
	await runInstall(input, consoleInstallCollaborators(input, consoleSchemaReconciler))
}

export const installationCli: InstallationCli = {
	provider: 'zerops',
	commands: ['install', 'init', 'plan', 'deploy'],
	usage: USAGE,
	run: async (command: InstallationCommand, argv: readonly string[]) => {
		if (command === 'install') {
			await runPlatformInstall(argv)
			return
		}
		if (command === 'init') {
			await runInit(parseInitArgs(argv), consoleInitCollaborators())
			return
		}
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
