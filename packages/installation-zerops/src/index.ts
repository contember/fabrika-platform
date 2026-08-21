import { reconcileSchema } from '@fabrika/auth'
import type { InstallationCli, InstallationCommand } from '@fabrika/installation-contract'
import { info as consoleInfo, ok as consoleOk, step as consoleStep, warn as consoleWarn } from '@fabrika/installation-init'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import { createZeropsApi, defaultSleep } from '@fabrika/provider-zerops'
import { generatedArtifacts } from '../zerops/artifacts'
import { assertArtifactMatchesSchema } from '../zerops/validate'
import { consoleAdminCollaborators, runPlatformAdmin } from './admin'
import { parsePlatformAdminArgs, REISSUE_FLAG } from './admin-options'
import { deployPlatform, PLATFORM_CONCURRENT_DEPLOY, PLATFORM_DEPLOY_ORDER, PLATFORM_SEQUENTIAL_DEPLOY } from './deploy'
import { parsePlatformDeployArgs } from './deploy-options'
import { consoleInitCollaborators, parseInitArgs, runInit } from './init'
import { consoleInstallCollaborators, runInstall } from './install'
import { parsePlatformInstallArgs, UNATTENDED_FLAG } from './install-options'
import { consoleDeployLog } from './log'
import { consoleUpgradeCollaborators, FABRIKA_REPOSITORY, runUpgrade, SIDECAR_BRANCH } from './upgrade'
import { parsePlatformUpgradeArgs, UPGRADE_DRY_RUN_FLAG } from './upgrade-options'

const USAGE = `Zerops installation

Commands:
  fabrika platform install --provider=zerops [options]
  fabrika platform init    --provider=zerops <installation> [--repo=<owner>/<name>]
  fabrika platform plan    --provider=zerops
  fabrika platform deploy  --provider=zerops [options]
  fabrika platform admin   --provider=zerops --email=<address> --iam-host=<host> [--scheme=<http|https>] [${REISSUE_FLAG}]
  fabrika platform upgrade --provider=zerops --to=<tag> [<installation>] [--sidecar=<path>|<owner>/<name>] [${UPGRADE_DRY_RUN_FLAG}]

\`install\` CREATES an installation in a project you created empty; \`init\` and \`deploy\` UPDATE AN
INSTALLATION THAT ALREADY EXISTS. Run them in that order: install generates the provisioning key that
init then writes into the operator's GitHub Environment. \`admin\` comes LAST, once the installation is
serving: it admits the first human, and nothing before it can sign in. \`upgrade\` is the one you run
again and again afterwards: it moves the sidecar's pin to a newer published release and follows the
deploy that push triggers.

── platform install ──────────────────────────────────────────────────────────────────────────────

The from-scratch bring-up. With \`--create-project\` it creates the project too, with core package
LIGHT and \`envIsolation: service\` — the two settings Zerops accepts at project CREATION only and never
afterwards. \`--project-id=<id>\` installs into an empty project you created yourself instead, with both
already right; nothing here can read \`envIsolation\` back or correct it.

Interactive and laptop-side. It CONFIRMS before every step that leaves your machine: reading the
project, importing the services, minting the token, building the proxy, writing the variables, and
deploying. Declining any of them stops there; nothing before the import is a mutation. A stdin that
is not a terminal is refused unless \`${UNATTENDED_FLAG}\` is given — with nobody there to answer, a default yes
is not consent.

  1. create the project and wait for it to be ACTIVE (\`--create-project\`; its id is printed before
     the wait), or read the one you named — and refuse a core package the tier does not match
  2. import ${PLATFORM_DEPLOY_ORDER.length + 2} services without code, and wait for the import's processes
  3. generate seven secrets and mint the control plane's Zerops INTEGRATION token
     (client role NO_ACCESS, ADMIN on this project only — never your personal token)
  4. pass 1: give the proxy an EMPTY manifest and build it, so it publishes one public hostname per
     HTTP port; the three platform hosts are then READ off those, never composed
  5. write every remaining variable on all five runtime services
  6. pass 2: hand the whole ordered sequence to \`platform deploy\`
  7. print the provisioning key ONCE — it is stored nowhere else

It REFUSES a project that already holds an installation's generated secrets: a second bring-up would
roll a new vault key over the old one, which is unrecoverable, and new signing keys, which logs
everyone out. Update an existing installation with \`platform deploy\`.

Only the LIGHT tier can be installed this way — it is the one topology that emits a services-only
import document. Authentication is PASSWORD ONLY; no administrator exists yet when this finishes.

Options (a flag beats the environment variable beside it):

  --project-id=<id>                 FABRIKA_ZEROPS_PROJECT_ID       the empty project you created
  --create-project                                                  create the project on --client-id instead of
                                                                    naming one with --project-id
  --project-name=<name>                                             the created project's name, default
                                                                    fabrika-<env>
  --client-id=<id>                  FABRIKA_ZEROPS_CLIENT_ID        the client the token is minted on
  --env=<name>                      FABRIKA_PLATFORM_ENVIRONMENT    written to every service as ENVIRONMENT
  --scheme=<http|https>             FABRIKA_PLATFORM_SCHEME         default https
  --from-git=<url>                  FABRIKA_ZEROPS_BUILD_FROM_GIT   public repository every service builds from
  --tier=light                      FABRIKA_PLATFORM_TIER           default light, and the only value
  ${UNATTENDED_FLAG}                                                             answer every confirmation yes —
                                                                    required when stdin is not a terminal

	FABRIKA_ZEROPS_ACCESS_TOKEN       required   Zerops access token, environment only and no flag
	FABRIKA_ZEROPS_API_URL            optional   region API base, when not the default

── platform init ─────────────────────────────────────────────────────────────────────────────────

Configures the installation's private source service, then creates and maintains the operator's SIDECAR REPOSITORY: the GitHub pipeline that calls
\`platform deploy\`, the tag it is pinned to, and the GitHub Environment holding this installation's
credentials. ADR-0025 puts that pipeline in a repository the operator owns — fabrika ships the
generator, never the pipeline, because one public repository cannot hold every account's credentials.

Interactive and laptop-side. It does the whole job and CONFIRMS before every step that leaves the
operator's disk: reading the project, configuring source, creating or pushing the repository, writing
the Environment, and triggering the run.
Declining any of them stops there and prints what to run instead; a re-run is safe.

For an existing installation, init imports only a missing source service with a steady services-only
document, waits for its exact processes, and writes one shared RPC key to source and control. A matching
existing key is reused; a mismatch is refused. It also repairs the nonsecret project binding used by
Control. Normal init leaves source in anonymous public-repository mode. GitHub App creation, activation,
webhook configuration, and installation verification belong to the authenticated Control UI at
\`Settings → Source\`. A leftover unkeyed or split GitHub App value is ignored, never adopted: since
ADR-0039 the only credential source can use is a keyed one, so connect a new source in Control.
Init never prompts for,
writes, recovers, or prints GitHub App credentials, and no source credential reaches the sidecar or
GitHub Environment.

If an older init left an owner-only local recovery file, this release does not open or delete it. Since
ADR-0039 there is nothing left to adopt it into: connect a new source in Control and delete the old
file afterwards.

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
  3. deploy ${PLATFORM_CONCURRENT_DEPLOY.join(' + ')} together, then ${PLATFORM_SEQUENTIAL_DEPLOY.join(' → ')}, waiting for each to become ACTIVE
  4. ensure the proxy's public entry point
  5. reconcile the console's app schema and register its return origin with IAM

The order is a security property, not just a dependency: the application enforces nothing
(ADR-0022), so the proxy is deployed BEFORE control, and every environment write happens before any
deploy. A run that cannot apply the manifest never reaches step 3. ${PLATFORM_CONCURRENT_DEPLOY.join(', ')} order
NOTHING against each other — none calls a sibling at boot and none reads a variable another's build
needs — so they build at once; a failure of one is reported with that service named, and the other two
are still followed to their end.

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
\`zerops-subdomain\` installation, whose public entry point step 4 ensures. Naming all three makes it a
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

── platform admin ────────────────────────────────────────────────────────────────────────────────

The first human. A fresh installation has none — nothing seeds an admission list, and this command is
why it does not have to. It is unattended, prompts for nothing, and changes nothing on a re-run:

  1. find the principal holding that mailbox, or invite one
  2. grant it the CROSS-APP \`admin\` role, unless it already holds one
  3. issue ONE password enrollment and print its URL

The grant is cross-app (\`app: null\`) and that is load-bearing: grants filter to the calling app, so an
\`admin\` grant scoped to the console's own app id leaves Delivery and Operations working while the
Access plane refuses. A re-run invites nobody twice, grants nothing twice and issues no second
enrollment — a password that is already set, or an enrollment already outstanding, is REPORTED. Pass
\`${REISSUE_FLAG}\` to replace an outstanding one, which is the way out when the first expired unopened.

The enrollment URL is a credential: it is printed once, on a line of its own, and stored nowhere.

\`install\` reports the host this needs as \`✓ iam <host>\` and ends with this command ready to run.

Options (a flag beats the environment variable beside it):

  --email=<address>                 FABRIKA_PLATFORM_ADMIN_EMAIL    the administrator's mailbox
  --iam-host=<host>                 FABRIKA_PLATFORM_IAM_HOST       IAM's public hostname, as \`deploy\` names it
  --scheme=<http|https>             FABRIKA_PLATFORM_SCHEME         default https
  ${REISSUE_FLAG}                                                         replace an outstanding enrollment

  FABRIKA_IAM_PROVISIONING_KEY      required   the px_ admin key \`install\` printed, environment only

── platform upgrade ──────────────────────────────────────────────────────────────────────────────

Roll a RUNNING installation onto a newer published fabrika release. Five steps in the sidecar
repository \`platform init\` created, in one command: check that ${FABRIKA_REPOSITORY} carries the tag,
write it to \`fabrika.ref\`, commit it as \`chore: roll <installation> forward to fabrika <tag>\`, push —
and the push is what triggers the pipeline — then print the run's URL and watch it to its conclusion.

The run URL is printed BEFORE the watch begins, so an operator who closes the terminal can come back
to it. The generated workflow QUEUES behind an earlier roll rather than cancelling it, so a run may sit
\`queued\` for a while; that is reported, not waited on silently.

A published TAG stays the only acceptable pin (ADR-0025): a branch or a commit SHA is refused here,
before anything is contacted, and again by the workflow at run time. It also refuses a directory that is
not a checkout, a checkout not on \`${SIDECAR_BRANCH}\` or tracking no upstream (the workflow triggers on
\`push: branches: [${SIDECAR_BRANCH}]\`, so a push from anywhere else deploys nothing), a sidecar with uncommitted
changes to tracked files (the commit stages \`fabrika.ref\` alone), and a pin already equal to \`--to\` —
though a pin that is committed and NEVER PUSHED says so instead, because that is what a failed push
leaves behind and no deploy happened.

A tag lookup that FAILS is a third answer and never "no such tag": a rate limit or an expired \`gh\`
login reported as a missing tag sends an operator to check the wrong repository.

  --to=<tag>                        required   the published fabrika release to roll onto, e.g. v0.1.0
  <installation>                               names the sidecar \`platform init\` created: the checkout
                                               ./fabrika-zerops-<installation> under the current directory
  --sidecar=<path>                             a checkout somewhere else — anything that is not shaped
                                               \`<owner>/<name>\`, so ./owner/name names a directory
  --sidecar=<owner>/<name>                     a GitHub repository, cloned into a temporary directory
                                               whose path is printed
  ${UPGRADE_DRY_RUN_FLAG}                                    report the roll it would commit and stop

Name the installation or the sidecar; naming both is fine and the sidecar wins. This command holds no
credential of its own: \`gh\` and \`git\` carry the operator's own login, which is also why it runs on a
laptop and not in the pipeline it triggers.
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

const runAdmin = async (argv: readonly string[]): Promise<void> => {
	const input = parsePlatformAdminArgs(argv, process.env)
	await runPlatformAdmin(
		input,
		consoleAdminCollaborators(input, {
			step: (title) => consoleStep(title),
			info: (message) => consoleInfo(message),
			warn: (message) => consoleWarn(message),
			ok: (message) => consoleOk(message),
		}),
	)
}

const runPlatformInstall = async (argv: readonly string[]): Promise<void> => {
	const input = parsePlatformInstallArgs(argv, process.env)
	await runInstall(input, consoleInstallCollaborators(input, consoleSchemaReconciler))
}

const runPlatformUpgrade = async (argv: readonly string[]): Promise<void> => {
	await runUpgrade(parsePlatformUpgradeArgs(argv), consoleUpgradeCollaborators())
}

export const installationCli: InstallationCli = {
	provider: 'zerops',
	commands: ['install', 'init', 'plan', 'deploy', 'admin', 'upgrade'],
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
		if (command === 'admin') {
			await runAdmin(argv)
			return
		}
		if (command === 'upgrade') {
			await runPlatformUpgrade(argv)
			return
		}
		throw new Error(`Zerops installation does not support \`platform ${command}\``)
	},
}
