// The `fabrika control` command area — the operator's non-browser client for the Delivery control
// plane ([ADR-0033](../../../docs/decisions/0033-operate-the-control-plane-from-the-cli.md)).
//
// It adds no server surface. Every verb is one procedure of `ControlRpcContract`, reached through the
// SAME typed client the console uses, so the two cannot drift. It loads no provider or installation
// package: the control API is provider-neutral, and `--provider` here only labels the envelope a
// registration carries.
//
// Output contract, matching `zops`: stdout carries DATA ONLY, progress and errors go to stderr, and
// `--json` prints the procedure's result verbatim so a caller never parses a table.

import { createRpcClient, type InferRpcClient, RpcError, type RpcFetch } from '@fabrika/app'
import {
	displayNameProblem,
	isCimdClientId,
	isOAuthResourceUri,
	type IssueKeyInput,
	type IssueKeyResult,
	MAX_KEY_LIFETIME_SECONDS,
	sha256Hex,
} from '@fabrika/auth-core'
import {
	APP_ENV_KINDS,
	APPROVAL_REQUESTED,
	type ApprovalRequestDto,
	approvalRequestedSchema,
	CONTROL_CLI_PRESETS,
	isFinalApprovalRequestState,
} from '@fabrika/control-contract'
import type {
	AppDto,
	AppEnvDto,
	AppEnvKind,
	AppSecretDto,
	ControlRpcContract,
	CreateApprovalRequestResponse,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	JsonValue,
	PlanDeploymentNamespaceRequest,
	PlanDeploymentNamespaceResponse,
	PutAppEnvRequest,
	PutAppSecretRequest,
	PutAppVarRequest,
	RegisterAppRequest,
	RegisterAppResponse,
	RunDto,
} from '@fabrika/control-contract'
import {
	type ExternalAppDto,
	type IamAdminRpcContract,
	isHttpsDocumentUrl,
	isOAuthIdentityAppId,
	isOAuthIdentityRoleKey,
	MAX_EXTERNAL_APP_CLIENTS,
	MAX_OAUTH_IDENTITY_ROLES,
	OAUTH_CLIENT_PROVIDERS,
	OAUTH_REGISTRY_NOT_IMPORTED,
	type OAuthClientDto,
	type PutExternalAppRequest,
	type PutOAuthClientRequest,
} from '@fabrika/iam-contract'
import { z } from 'zod'
import {
	authorizeDevice,
	controlOAuthBearer,
	type ControlOAuthDependencies,
	controlResourceFor,
	CREDENTIAL_HELPER_VARIABLE,
	defaultControlOAuthDependencies,
	parseControlCliPreset,
} from './control-oauth.js'
import { credentialOrigin, type OriginSource } from './credential-origin.js'

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.null(), z.string(), z.number(), z.boolean(), z.array(jsonValueSchema), z.record(jsonValueSchema)])
)
const manifestHeaderSchema = z.object({ manifestVersion: z.number().int().safe().positive() })
const issueKeyResultSchema = z.union([
	z.object({
		ok: z.literal(false),
		reason: z.enum(['missing_token', 'invalid_token', 'unknown_principal', 'disabled', 'not_allowed']).catch('not_allowed'),
	}),
	z.object({
		ok: z.literal(true),
		token: z.string(),
		id: z.string(),
		principalId: z.string().optional().catch(undefined),
	}).transform(({ principalId, ...result }) => ({ ...result, ...(principalId === undefined ? {} : { principalId }) })),
])

const USAGE = `fabrika control — operate the Delivery control plane

Usage:
  fabrika control auth device --preset=<read|deploy|operate|create> [--app=<id>]
  fabrika control key issue --label=<name> --permissions=<a,b,c> --expires-in=<seconds> [--iam-url=<origin>]
  fabrika control apps list
  fabrika control apps get --app=<id>
  fabrika control apps environments list --app=<id>
  fabrika control apps environments put --provider=<name> --app=<id> --env=<name> --manifest=<path>
                           [--domain=<host>] [--public-origin=<url>] [--trigger-ref=<ref>] [--namespace=<id>]
                           [--cross-origin=<origin> ...] [--kind=standard|dev] [--wait]
  fabrika control apps environments suspend --app=<id> --env=<name> [--wait]
  fabrika control apps environments resume  --app=<id> --env=<name> [--wait]
  fabrika control apps variables list --app=<id>
  fabrika control apps variables put --app=<id> --name=<name> --value=<text> [--env=<name>] [--not-secret] [--request] [--wait]
  fabrika control apps variables delete --app=<id> --name=<name> [--env=<name>] [--request] [--wait]
  fabrika control apps secrets list --app=<id>
  fabrika control apps secrets put --app=<id> --name=<name> [--env=<name>] [--request] [--wait]    (the value on stdin)
  fabrika control apps secrets delete --app=<id> --name=<name> [--env=<name>] [--request] [--wait]
  fabrika control register --provider=<name> --app=<id> --repo=<url> --env=<name> --manifest=<path>
                           [--domain=<host>] [--public-origin=<url>] [--trigger-ref=<ref>]
                           [--namespace=<id>] [--installation-id=<n|none>] [--cross-origin=<origin> ...]
  fabrika control namespaces list
  fabrika control namespaces get     --namespace=<id>
  fabrika control namespaces plan   --namespace=<id> --env=<name> --preset=<cheap|mid|full> [placement]
  fabrika control namespaces create --namespace=<id> --env=<name> --preset=<cheap|mid|full> [placement]
  fabrika control namespaces reconcile --namespace=<id>
  fabrika control namespaces update --namespace=<id> --proxy-source=current
  fabrika control namespaces remove --namespace=<id>
  fabrika control namespaces release-claims --namespace=<id> --app=<id> --env=<name>
  fabrika control deploy --app=<id> --env=<name> [--ref=<ref>] [--wait]
  fabrika control runs list [--app=<id>] [--env=<name>] [--limit=<n>]
  fabrika control runs get --run=<id>
  fabrika control runs log --run=<id>
  fabrika control requests get <id> [--wait]
  fabrika control access request-grant --app=<id> --env=<name> --principal=<id> --role=<role>
                           [--scope=<dimension>:<value>] --expires-in=<seconds> [--wait]
  fabrika control external-apps list | get <app> | put --file=<app.json> | delete <app>   [--iam-url=<origin>]
  fabrika control oauth-clients list | put --file=<client.json> | delete <client id>   [--iam-url=<origin>]

\`register\` CREATES an app and refuses a second one with the same id. Re-registering a changed
manifest — a new import document, or a new \`zerops.yaml\` of an app without a contract — is
\`apps environments put\`, which replaces one environment's envelopes and leaves the app row alone. A
contract app's deploy registers the \`zerops.yaml\` of its commit itself.

A manifest that publishes the app through the namespace proxy is routed by HOST, so \`--domain\` is
REQUIRED for it — on \`register\` and on \`apps environments put\` alike — and a registration without one is
refused before anything is created. \`namespaces get\` lists the hosts a \`zerops-subdomain\` namespace
serves and which of them are still free; a custom-domain namespace serves the domain you bound to its
proxy. A manifest with no proxy target needs no domain.

\`apps environments suspend\` takes an environment offline in an incident, such as a compromised or leaked application.
Behind a Zerops namespace proxy every request to it answers 503 once the republished proxy is live, which takes the
minutes of a proxy build; \`namespaces get\` follows it. A namespace pinned to an older proxy source is refused with the
re-pin to run first. On Cloudflare the environment's object goes into maintenance \`closed\`. \`resume\` restores the
routing it had, or on Cloudflare the maintenance mode it was in. Neither stops the application's service, nor
revokes a key. Repeating either is a retry.

A variable's value is stored and printed in clear, so \`apps variables put\` refuses one that looks like a
credential (by its name, such as \`*_TOKEN\` or \`*_PASSWORD\`, or by its value) and names \`apps secrets put\` instead.
\`--not-secret\` stores it anyway, for a value you have checked is not one. A secret's value is write-only: \`apps secrets put\`
reads it from STDIN, never from a flag, so it reaches neither shell history nor a process listing, and
one trailing newline is dropped. No command prints it back; \`apps secrets list\` shows names, scope and
storage only. Generate one in the pipe:

  openssl rand -base64 32 | fabrika control apps secrets put --app=<id> --name=<name>

\`--public-origin\` is where IAM may return a signed-in person: without one, sign-in to the environment is
refused. When \`register\` is given none and the namespace lists \`--domain\` among its hosts, it sets
\`https://<domain>\` and says so on stderr. A custom domain needs the flag.

\`--cross-origin\` names an origin whose pages may call the environment's cross-origin endpoints (ADR-0022), and
repeats: the flags given are the environment's whole list. Each is an exact origin with a literal host
(\`https://app.example.com\`; \`http://\` only for a local one), never the environment's own domain, at most 16.
\`apps environments put\` without the flag keeps the stored list, and a lone empty \`--cross-origin=\` clears it.
On Zerops the change reaches the namespace proxy at once; on Cloudflare the next deploy of the environment
applies it.

\`--installation-id\` has three states: omitted resolves the installation from the repository owner's
connected GitHub App, \`none\` registers an anonymous PUBLIC repository source, and a number names one
installation outright. With \`none\`, control reads the repository once without a token and refuses one
GitHub hides: a private repository needs the GitHub App connected in the console first.

\`--trigger-ref\` is the git ref whose push deploys the environment; without it the environment deploys only
on \`deploy\`. A bare name is a branch: \`--trigger-ref=deploy/prod\` is stored as \`refs/heads/deploy/prod\`.
A full ref is kept as given: \`refs/heads/<branch>\`, \`refs/tags/<tag>\`, or a \`*\` glob such as
\`refs/tags/v*\`, which deploys every matching tag. A tag always needs the \`refs/tags/\` form. Each
environment of an app needs its own trigger ref. Branches named \`fabrika/…\` are reserved for MCP
workspaces and are never a trigger ref.

\`deploy\` of a protected environment with \`FABRIKA_CONTROL_KEY\` or a device grant is a request a person approves:
\`--ref\` names a 40-character commit SHA, by default one merged into the environment's trigger ref (or the default
branch), and stderr prints the console link the person opens. \`--wait\` follows the run until it succeeds or
fails, approval being one step on the way, and prints its final row; a refusal or an expiry says so on stderr.

\`requests get\` reads one approval request: a change an agent or a key asked a person to approve, by the id its
creation answered. stderr prints the console link while it waits, and why it did not run once it failed, went stale or
expired. \`--wait\` reads it again until it is refused, expired, executed, failed or stale, and prints its final row;
once a person decided it, it stops with an error after 15 minutes without an outcome.

\`--request\` on \`apps secrets put|delete\` and \`apps variables put|delete\` does not make the change: it asks a person
to approve it. Every other verb refuses it. Control stores the request, inert, and stderr prints the console link the person opens; for a secret it
also prints the value's fingerprint (the first 8 hex characters of its SHA-256, computed here), which the page shows
beside the value's length, so the person can tell it is the value you sent; when Control's answer names another
fingerprint, the command fails and says to refuse the request. Control seals the value and stores only that. stdout
prints the request's id, state and link; \`--wait\` follows it as \`requests get --wait\` does. Without \`--env\` the request
is for every environment of the app, and every protected one judges it. A secret the provider keeps (a Zerops
environment) cannot be requested yet.

\`access request-grant\` asks a person to give a principal (this agent's own, or another) one role of an application
environment. It needs \`access.request\` at the app, the role must be one the environment's approved contract declares,
a membership role takes \`--scope\` with a value of its dimension, and \`--expires-in\` is at most 30 days. An IAM
administrator of the application approves it at the console link stderr prints; the grant is then theirs, and where
the application's grants wait for approval, IAM holds it for a second administrator. An environment that does not gate
an agent's grants (not protected, or \`agent-grants\` off) refuses it: there is nothing to approve there. stdout prints
the request's id, state and link; \`--wait\` follows it as \`requests get --wait\` does.

Without \`--request\`, a write by \`FABRIKA_CONTROL_KEY\` or a device grant on a protected environment meets that
environment's approval policy (ADR-0083): \`apps secrets\`, \`apps variables\` and \`apps environments put|suspend|resume\`
are \`secrets\`, \`variables\` and \`registry\` writes.
A category set to \`off\` applies the write; \`refuse\` refuses it; \`person\` does not make the change but stores it as a
request, exactly as \`--request\` does: stdout prints its id, state and link, stderr the fingerprint of a secret, and the
command exits 75. Hand the person the link; nothing changes until they approve it. \`--wait\` follows the request
instead, and succeeds only when it executed.

Namespace placement options, each defaulting to what the preset would choose:

  --project=<name>                  the provider project the namespace owns; on Zerops the default is
                                    fabrika-<env>-<namespace id>, beside the installation's fabrika-<env>
  --core-package=<LIGHT|SERIOUS>    defaults to LIGHT on every environment, \`prod\` included (ADR-0038).
                                    SERIOUS is a deliberate choice: a project cannot be downgraded again
  --public-access=<custom-domain|zerops-subdomain>
  --exclusive-app=<id>              required by, and only by, the \`full\` preset
  --postgres-type=<type>            the \`cheap\` preset's shared PostgreSQL; on Zerops postgresql:single@18
                                    (default) or postgresql:ha@18, which keeps its data through a node loss.
                                    Fixed once created
  --postgres-profile=<profile>      its profile, given together with --postgres-type: oltp-hobby for single,
                                    oltp-staging (about $11) or oltp-production (about $72) for HA

\`namespaces plan\` is a preview and changes nothing. It prints one \`<path>\\t<value>\` row per field of
the plan, keyed by its path in \`--json\`; a multi-line value such as the proxy's descriptor file is shown
by size only. \`namespaces create\` commits that exact plan — the
same two steps the console's form takes — and returns as soon as the placement is recorded: provisioning
runs behind the control queue and takes minutes, so the state comes back \`pending\`. Follow it with
\`namespaces get\` or \`namespaces list\`; nothing needs to stay connected. \`namespaces remove\` frees the id
of a placement no application is registered in. It deletes nothing at the provider and prints, on stderr,
the provider resources it stopped tracking. \`namespaces update --proxy-source=current\` re-pins a placement's
proxy to the source this control plane deploys new placements from — a placement keeps the one it was created
with until you do — and queues the reconcile that rebuilds the proxy from it; a \`failed\` placement accepts it.

\`namespaces release-claims\` frees the resource names one app environment holds in a placement, which an
environment or app delete otherwise refuses over. Delete those resources at the provider first: the release
reads each one back and refuses, naming it, while any still exists. It prints one released key per line.

Every command accepts --json, which prints the procedure's result verbatim.

The control origin is not a credential and takes either form:

  --url=<origin>                    FABRIKA_CONTROL_URL

Credentials are read from the ENVIRONMENT ONLY and have no flag, so they cannot reach a CI log or a
process listing. One of:

  FABRIKA_CONTROL_KEY               a machine \`px_\` credential for the control app; it wins when both are set
  FABRIKA_CONTROL_CREDENTIAL_HELPER a command with \`get\` and \`store\` that holds the refresh token of a
                                    \`control auth device\` grant (below)

\`auth device\` asks IAM for a grant a person approves in the browser (RFC 8628). It prints the page and the
code on stderr and waits; the person signs in, checks the code, and picks how long the grant lasts (an hour, a
day or a week). The grant holds the preset's actions at one application, never more than that person may:

  read      deploy.read, data.read, operations.read
  deploy    read, and deploy.trigger
  operate   deploy, secret.manage, app.manage and operations.triage
  create    app.manage wherever the person holds it, with no --app: it also changes and deletes apps

The refresh token goes to the helper and nowhere else: the helper runs as \`sh -c '<helper> get|store'\`,
reads \`origin=<console origin>\` (and, for \`store\`, \`refresh_token=<token>\`) on stdin, and \`get\` prints
\`refresh_token=<token>\`, or nothing. Every call then trades it for a short-lived access token, and IAM
rotates it each time; a lock under $XDG_CACHE_HOME/fabrika (~/.cache/fabrika when unset) serializes that
between processes on this machine. If a refresh's answer is lost, the stored token is spent and the next
call says to run \`auth device\` again.

\`key issue\` mints that credential and therefore authenticates differently — it presents the
installation's IAM RPC key as transport authentication and its provisioning key as the ISSUING
credential. Every key expires: \`--expires-in\` is required and at most 2592000 (30 days). Both
credentials are read from the environment only:

  FABRIKA_IAM_RPC_URL               required   IAM's PUBLIC origin, or --iam-url
  FABRIKA_IAM_RPC_KEY               required   the installation's IAM RPC key
  FABRIKA_IAM_PROVISIONING_KEY      required   the installation's seeded \`px_\` provisioning key
  FABRIKA_CONTROL_APP_ID            optional   the control app's IAM id (default \`vozka\`)

The PUBLIC origin is the \`https://\` address the installation answers on — the one \`platform admin\`
and \`platform init\` print in their closing block, and the value \`FABRIKA_IAM_ISSUER\` holds on the
control service. It is NOT the private hostname the services use between themselves: \`http://iam:3000\`
resolves inside the provider's project and nowhere else, so from here it only ever fails to connect.

\`external-apps\` and \`oauth-clients\` manage the OAuth clients IAM serves (ADR-0089). They call IAM's admin API
with two of the variables \`key issue\` reads, and nothing else: FABRIKA_IAM_RPC_URL (or --iam-url), IAM's PUBLIC origin,
and FABRIKA_IAM_PROVISIONING_KEY, the bearer. An external application is an application outside this installation that
signs people in through IAM; \`put\` replaces it whole from a file (record, roles and clients) and is idempotent:

  {
    "app": "ops-tool",
    "name": "Ops tool",
    "resource": "https://ops.example.com",
    "roles": [{ "key": "viewer", "name": "Viewer" }],
    "clients": [{ "clientId": "https://ops.example.com/oauth/client.json",
                  "redirectUris": ["https://ops.example.com/oauth/callback"], "metadataUrl": null }]
  }

\`roles\` null or left out: every active user of the installation signs in. \`get\` prints the same file, ready to edit
and put back. Removing a client, changing the resource or deleting the application revokes the sign-ins through it.
\`oauth-clients put\` writes an MCP authoring client, whose tokens reach the console's /mcp:

  { "clientId": "https://claude.ai/oauth/mcp-oauth-client-metadata", "label": "claude",
    "redirectUris": ["https://claude.ai/api/mcp/auth_callback"] }

\`label\` is claude, chatgpt or external. A client of an external application is written only through
\`external-apps put\`, and \`oauth-clients\` refuses it. \`put\` checks the file before anything is sent. Until a platform
deploy of this release has imported the installation's client list, IAM refuses both \`put\`s; deploy, then repeat.
The console registers external applications too, under Access → External applications.

Connecting a GitHub source is NOT here and will not be: App creation is a browser flow whose
authorization requires a human principal (ADR-0029). Use Settings → Source in the console.
`

const DEFAULT_CONTROL_APP_ID = 'vozka'

interface Flags {
	readonly values: ReadonlyMap<string, string>
	/** Every value of every option, in order; `values` keeps the last. Only a repeatable option reads it. */
	readonly repeated: ReadonlyMap<string, readonly string[]>
	readonly json: boolean
	/** `--not-secret`: `apps variables put` stores a value that looks like a credential. */
	readonly notSecret: boolean
	/**
	 * `--wait`: `deploy` follows the run until it succeeds or fails; `requests get`, `--request` and a write Control stores as
	 * a request follow the request until it settles.
	 */
	readonly wait: boolean
	/** `--request`: a secret or variable write asks a person to approve it instead of making it (ADR-0083 §8). */
	readonly request: boolean
	readonly positional: readonly string[]
}

/**
 * Split `--key=value` options from positional words; `--json` is the one flag every verb shares, `--not-secret`, `--wait`
 * and `--request` the other bare ones.
 */
export const parseControlFlags = (argv: readonly string[]): Flags => {
	const values = new Map<string, string>()
	const repeated = new Map<string, string[]>()
	const positional: string[] = []
	let json = false
	let notSecret = false
	let wait = false
	let request = false
	for (const arg of argv) {
		if (arg === '--json') {
			json = true
		} else if (arg === '--not-secret') {
			notSecret = true
		} else if (arg === '--wait') {
			wait = true
		} else if (arg === '--request') {
			request = true
		} else if (arg.startsWith('--')) {
			const eq = arg.indexOf('=')
			if (eq === -1) {
				throw new Error(`Option ${arg} needs a value: ${arg}=<value>`)
			}
			const name = arg.slice(2, eq)
			const value = arg.slice(eq + 1)
			values.set(name, value)
			repeated.set(name, [...(repeated.get(name) ?? []), value])
		} else {
			positional.push(arg)
		}
	}
	return { values, repeated, json, notSecret, wait, request, positional }
}

const required = (flags: Flags, name: string): string => {
	const value = flags.values.get(name)
	if (value === undefined || value === '') {
		throw new Error(`--${name} is required`)
	}
	return value
}

const optional = (flags: Flags, name: string): string | undefined => {
	const value = flags.values.get(name)
	return value === undefined || value === '' ? undefined : value
}

/**
 * `--cross-origin=<origin>`, repeatable: the environment's whole list. Omitted keeps the stored list on
 * `apps environments put`; a lone empty `--cross-origin=` sends an empty list, which clears it.
 */
const crossOrigins = (flags: Flags): string[] | undefined => {
	const given = flags.repeated.get('cross-origin')
	if (given === undefined) return undefined
	if (given.length === 1 && given[0] === '') return []
	if (given.includes('')) {
		throw new Error('An empty --cross-origin= clears the list and takes no other --cross-origin')
	}
	return [...given]
}

const positiveInteger = (raw: string, name: string): number => {
	const parsed = Number(raw)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`--${name} must be a positive integer`)
	}
	return parsed
}

const secret = (variable: string, env: Readonly<Record<string, string | undefined>>): string => {
	const value = env[variable]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${variable} is required (environment only — it has no flag).`)
	}
	return value.trim()
}

/** The console's client with a bearer instead of a cookie, and no SSO bounce: there is no browser to send. */
export type ControlClient = InferRpcClient<ControlRpcContract>

const CONTROL_ORIGIN: OriginSource = { label: 'Control', flag: 'url', variable: 'FABRIKA_CONTROL_URL' }

const IAM_ORIGIN: OriginSource = {
	label: 'IAM',
	flag: 'iam-url',
	variable: 'FABRIKA_IAM_RPC_URL',
	hint: "It is IAM's PUBLIC https origin (control's FABRIKA_IAM_ISSUER): a private hostname such as `http://iam:3000` answers only "
		+ "inside the provider's project, never from this machine.",
}

const KEY_LABEL = '[FABRIKA_CONTROL_KEY]'

/** `text` with the control key cut out: every diagnostic of an area that holds the key passes through it. */
export const withoutControlKey = (text: string, env: Readonly<Record<string, string | undefined>>): string => {
	const key = env['FABRIKA_CONTROL_KEY']?.trim()
	return key === undefined || key === '' ? text : text.replaceAll(key, KEY_LABEL)
}

/** Whether a JSON body holds `key`, also behind JSON escapes, which a plain search of the text would miss. */
const carriesKey = (text: string, key: string): boolean => {
	if (text.includes(key)) return true
	try {
		return JSON.stringify(JSON.parse(text)).includes(JSON.stringify(key).slice(1, -1))
	} catch {
		return false
	}
}

/**
 * A JSON answer that carries the key is dropped whole, so no row, `--json` output or error can repeat it. Any other
 * body passes: the RPC client reports a non-JSON answer by its status alone.
 */
const withoutEchoedKey = async (
	response: Response,
	key: string,
	source: { readonly service: string; readonly label: string } = { service: 'Control', label: KEY_LABEL },
): Promise<Response> => {
	if (!(response.headers.get('content-type') ?? '').includes('application/json')) return response
	const text = await response.text()
	if (carriesKey(text, key)) {
		return Response.json({ error: { type: 'transport', message: `${source.service}'s answer carried ${source.label}; it was dropped` } }, {
			status: 502,
		})
	}
	return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** Control's origin and the fetch that carries the Control credential to it. */
export interface ControlTransport {
	readonly origin: string
	readonly fetch: RpcFetch
	/** The credential is a person's device grant, not FABRIKA_CONTROL_KEY. */
	readonly grant: boolean
}

/** Neither credential is set; both are read from the environment only. */
export const MISSING_CONTROL_CREDENTIAL = `FABRIKA_CONTROL_KEY is required (environment only — it has no flag), or ${CREDENTIAL_HELPER_VARIABLE} `
	+ 'after `fabrika control auth device`.'

/**
 * The bearer for one request: FABRIKA_CONTROL_KEY when it is set, else an access token for the resource the request
 * calls, refreshed through the grant the credential helper holds.
 */
const controlBearer = (
	origin: string,
	env: Readonly<Record<string, string | undefined>>,
	send: RpcFetch,
	oauth: ControlOAuthDependencies | undefined,
): (input: RequestInfo | URL) => Promise<string> => {
	const key = env['FABRIKA_CONTROL_KEY']?.trim()
	if (key !== undefined && key !== '') return () => Promise.resolve(key)
	const helper = env[CREDENTIAL_HELPER_VARIABLE]?.trim()
	if (helper === undefined || helper === '') throw new Error(MISSING_CONTROL_CREDENTIAL)
	const bearer = controlOAuthBearer(origin, oauth ?? defaultControlOAuthDependencies(helper, env, send))
	return (input) => bearer(controlResourceFor(origin, input))
}

/**
 * The origin from `url` or FABRIKA_CONTROL_URL, the credential from the environment only, no redirect followed. Every
 * client of the console's origin is built on it.
 */
export const controlTransport = (
	url: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
	send: RpcFetch = fetch,
	oauth?: ControlOAuthDependencies,
): ControlTransport => {
	const origin = credentialOrigin(url ?? env['FABRIKA_CONTROL_URL'], CONTROL_ORIGIN)
	const bearer = controlBearer(origin, env, send, oauth)
	return {
		origin,
		grant: (env['FABRIKA_CONTROL_KEY']?.trim() ?? '') === '',
		fetch: async (input, init) => {
			let token: string
			try {
				token = await bearer(input)
			} catch (error) {
				// The RPC client reads a rejected fetch as "Network request failed"; this answer keeps the reason.
				const message = error instanceof Error ? error.message : 'the Control credential could not be obtained'
				return Response.json({ error: { type: 'credential', message } }, { status: 401 })
			}
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${token}`)
			// A redirect would carry the bearer to wherever it points.
			return await withoutEchoedKey(await send(input, { ...init, headers, redirect: 'manual' }), token)
		},
	}
}

/** The one client of Control that `fabrika control`, `fabrika env` and `fabrika operations` share. */
export const connectControl = (
	url: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
	oauth?: ControlOAuthDependencies,
): ControlClient => {
	const transport = controlTransport(url, env, fetch, oauth)
	return createRpcClient<ControlRpcContract>({ baseUrl: `${transport.origin}/api/rpc`, fetch: transport.fetch })
}

const controlClient = (flags: Flags, env: Readonly<Record<string, string | undefined>>): ControlClient => connectControl(flags.values.get('url'), env)

const readJsonFile = async (path: string): Promise<JsonValue> => {
	const file = Bun.file(path)
	if (!(await file.exists())) {
		throw new Error(`No such file: ${path}`)
	}
	return parseJsonText(await file.text(), path)
}

/** `label` names the source in errors: a file path, or what produced an in-memory manifest. */
const parseJsonText = (text: string, label: string): JsonValue => {
	try {
		const parsed: unknown = JSON.parse(text)
		const result = jsonValueSchema.safeParse(parsed)
		if (!result.success) throw new Error(`${label} contains a value JSON cannot carry`)
		return result.data
	} catch (error) {
		throw error instanceof SyntaxError ? new Error(`${label} is not valid JSON`) : error
	}
}

const emit = (flags: Pick<Flags, 'json'>, result: unknown, render: () => string): void => {
	console.info(flags.json ? JSON.stringify(result, null, 2) : render())
}

/** A list prints one row per item; an empty one says so on stderr, so stdout stays data and a human still gets an answer. */
const emitList = <Item>(flags: Flags, result: { readonly items: readonly Item[] }, row: (item: Item) => string, empty: string): void => {
	if (!flags.json && result.items.length === 0) {
		console.warn(empty)
		return
	}
	emit(flags, result, () => result.items.map(row).join('\n'))
}

/** `fabrika app build` writes `manifestVersion`; it is the version the provider's artifact codec accepts. */
const manifestVersion = (manifest: JsonValue, path: string): number => {
	const result = manifestHeaderSchema.safeParse(manifest)
	if (!result.success) {
		throw new Error(`${path} declares no manifestVersion — run \`fabrika app build\` to produce one`)
	}
	return result.data.manifestVersion
}

const appLine = (app: AppDto): string => `${app.id}\t${app.repoUrl}\t${app.defaultBranch}`

const runLine = (run: RunDto): string => `${run.id}\t${run.appId}\t${run.env}\t${run.status}\t${run.ref}`

/**
 * The one `key issue` failure whose cause is almost always the address itself.
 *
 * `fetch` rejects only when the request never completed, so this reports what could not be reached and the mistake that
 * produces it. The cause object may quote anything, so only its short error code is.
 */
const unreachableIam = (origin: string, cause: unknown): string => {
	const code = typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'code') : undefined
	const reason = typeof code === 'string' && code !== '' && code.length <= 40 ? code : 'the connection failed'
	return `IAM could not be reached at ${origin} (${reason}). ${IAM_ORIGIN.hint}`
}

const runKeyIssue = async (flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	const permissions = required(flags, 'permissions').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
	if (permissions.length === 0) {
		throw new Error('--permissions needs at least one action')
	}
	const expiresIn = positiveInteger(required(flags, 'expires-in'), 'expires-in')
	if (expiresIn > MAX_KEY_LIFETIME_SECONDS) {
		throw new Error(`--expires-in must be at most ${MAX_KEY_LIFETIME_SECONDS} seconds (30 days): IAM issues no longer-lived key`)
	}
	const body: IssueKeyInput = {
		app: env['FABRIKA_CONTROL_APP_ID']?.trim() || DEFAULT_CONTROL_APP_ID,
		credential: secret('FABRIKA_IAM_PROVISIONING_KEY', env),
		requestId: crypto.randomUUID(),
		service: { label: required(flags, 'label'), permissions },
		label: required(flags, 'label'),
		expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
	}
	const base = credentialOrigin(flags.values.get('iam-url') ?? env['FABRIKA_IAM_RPC_URL'], IAM_ORIGIN)
	const response = await fetch(`${base}/rpc/issueKey`, {
		method: 'POST',
		headers: { authorization: `Bearer ${secret('FABRIKA_IAM_RPC_KEY', env)}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
		// A followed 307/308 would re-send the provisioning key to wherever it points.
		redirect: 'manual',
	}).catch((cause: unknown) => {
		throw new Error(unreachableIam(base, cause))
	})
	if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
		throw new Error(`IAM answered with a redirect (HTTP ${response.status}), which is not followed. ${IAM_ORIGIN.hint}`)
	}
	if (!response.ok) {
		// The body can quote what came off the wire, so report the status and nothing else.
		throw new Error(`IAM refused the issue request: HTTP ${response.status}`)
	}
	const result: unknown = await response.json()
	const outcome = decodeIssueKeyResult(result)
	if (!outcome.ok) {
		throw new Error(`IAM denied the issue request: ${outcome.reason}`)
	}
	// The token is the command's DATA and goes to stdout alone; the handles a caller needs in order to
	// revoke it later go to stderr, so `--quiet`-style capture gets the credential and nothing else.
	console.error(`credential ${outcome.id}${outcome.principalId === undefined ? '' : `, principal ${outcome.principalId}`}`)
	console.info(flags.json ? JSON.stringify(outcome, null, 2) : outcome.token)
}

const APP_ID = /^[a-z0-9][a-z0-9-]*$/

/** `auth device`: the device grant for one preset, stored through the credential helper; nothing goes to stdout. */
const runAuthDevice = async (flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	const origin = credentialOrigin(flags.values.get('url') ?? env['FABRIKA_CONTROL_URL'], CONTROL_ORIGIN)
	const raw = required(flags, 'preset')
	const preset = parseControlCliPreset(raw)
	if (preset === null) throw new Error(`--preset must be one of ${CONTROL_CLI_PRESETS.join(', ')}`)
	const app = optional(flags, 'app')
	if (preset === 'create' && app !== undefined) throw new Error('--preset=create holds its action wherever you may, and takes no --app')
	if (preset !== 'create' && (app === undefined || !APP_ID.test(app))) throw new Error(`--preset=${preset} needs --app=<application id>`)
	const helper = env[CREDENTIAL_HELPER_VARIABLE]?.trim()
	if (helper === undefined || helper === '') {
		throw new Error(`${CREDENTIAL_HELPER_VARIABLE} is required: the refresh token is stored through it and never printed`)
	}
	await authorizeDevice({ origin, preset, ...(app === undefined ? {} : { app }) }, defaultControlOAuthDependencies(helper, env, fetch))
}

const decodeIssueKeyResult = (value: unknown): IssueKeyResult => {
	const result = issueKeyResultSchema.safeParse(value)
	if (!result.success) {
		throw new Error('IAM returned an unreadable issueKey result')
	}
	return result.data
}

const registrationLine = (result: RegisterAppResponse): string => `${result.app.id}\t${result.env.env}\t${result.env.provider}`

/** Everything a registration carries except the manifest, read from flags before any manifest exists. */
type RegistrationInputs = Omit<RegisterAppRequest, 'target' | 'artifact'>

const registrationInputs = (flags: Flags): RegistrationInputs => {
	const installationId = optional(flags, 'installation-id')
	// Three states, because the registry has three: absent resolves from the connected GitHub App,
	// `none` is the anonymous public-repository path, and a number names one installation outright.
	const anonymousSource = installationId === 'none'
	const domain = optional(flags, 'domain')
	const publicOrigin = optional(flags, 'public-origin')
	const origins = crossOrigins(flags)
	const triggerRef = optional(flags, 'trigger-ref')
	const namespaceId = optional(flags, 'namespace')
	return {
		id: required(flags, 'app'),
		repoUrl: required(flags, 'repo'),
		env: required(flags, 'env'),
		...(installationId === undefined
			// Blank → resolve from the installed GitHub App, which is what the console's empty field means.
			? { resolveInstallationId: true }
			: anonymousSource
			? { githubInstallationId: null }
			: { githubInstallationId: positiveInteger(installationId, 'installation-id') }),
		...(domain === undefined ? {} : { domain }),
		...(publicOrigin === undefined ? {} : { publicOrigin }),
		...(origins === undefined ? {} : { crossOrigins: origins }),
		...(triggerRef === undefined ? {} : { triggerRef }),
		...(namespaceId === undefined ? {} : { namespaceId }),
	}
}

/** The one request both `control register` and `app register` send, so the two cannot differ on the wire. */
const registrationRequest = (inputs: RegistrationInputs, provider: string, manifest: JsonValue, label: string): RegisterAppRequest => {
	// The envelope's version is the manifest's own, never a literal: `fabrika app build` writes the
	// version its provider's codec accepts, and a hardcoded one goes stale the moment that codec moves.
	const version = manifestVersion(manifest, label)
	const { id, repoUrl, env, ...placement } = inputs
	return {
		id,
		repoUrl,
		env,
		// An empty placeholder: registration DISCOVERS the real target from the manifest and replaces this.
		target: { provider, version, payload: {} },
		artifact: { provider, version, payload: manifest },
		...placement,
	}
}

/**
 * The registration with the public origin sign-in returns to, when `--public-origin` is not given and the namespace
 * lists `--domain` among the hosts it serves. IAM refuses to return to an environment without one. A namespace lists
 * only the hosts its provider publishes, and Zerops publishes each one over HTTPS.
 */
const withNamespacePublicOrigin = async (body: RegisterAppRequest, client: ControlClient): Promise<RegisterAppRequest> => {
	const { domain, namespaceId } = body
	if (body.publicOrigin !== undefined || domain === undefined || domain === null || namespaceId === undefined || namespaceId === null) {
		return body
	}
	const namespace = await client.namespaces.get({ namespaceId })
	if (!(namespace.hosts ?? []).some((entry) => entry.host === domain)) {
		console.warn(
			`no public origin: namespace ${namespaceId} does not list ${domain}, so sign-in cannot return to ${body.id}/${body.env} `
				+ 'until `apps environments put` sets --public-origin',
		)
		return body
	}
	const publicOrigin = `https://${domain}`
	console.warn(`public origin ${publicOrigin}: namespace ${namespaceId} serves ${domain}`)
	return { ...body, publicOrigin }
}

const runRegister = async (flags: Flags, provider: string | undefined, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	if (provider === undefined || provider === '') {
		throw new Error('--provider=<name> is required: it labels the envelope this registration carries.')
	}
	const manifestPath = required(flags, 'manifest')
	const manifest = await readJsonFile(manifestPath)
	const client = controlClient(flags, env)
	const body = await withNamespacePublicOrigin(registrationRequest(registrationInputs(flags), provider, manifest, manifestPath), client)
	const result = await client.register(body)
	emit(flags, result, () => registrationLine(result))
}

/** The exact text `app build` would write, and the provider whose envelope carries it. */
export interface CompiledManifest {
	readonly provider: string
	readonly text: string
}

/** Resolves the app's provider and compiles its manifest for one environment; both run the app's own code. */
export type ManifestTextCompiler = (environment: string) => Promise<CompiledManifest>

const IN_MEMORY_MANIFEST = 'the compiled manifest'

/** The message of a failure that ran with `value` in reach, with `value` cut out and named by `label`. */
const failureMessage = (error: unknown, value: string, label: string): string => {
	const message = error instanceof RpcError ? `${error.type}: ${error.message}` : error instanceof Error ? error.message : String(error)
	return message.replaceAll(value, `[${label}]`)
}

/**
 * `fabrika app register`: compile in memory, then send the SAME request `control register` sends for
 * that manifest read from disk. Inputs, the control origin and the credential are checked before the
 * compile; nothing is written locally in either phase.
 */
export const registerCompiledManifest = async (
	argv: readonly string[],
	compile: ManifestTextCompiler,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> => {
	const flags = parseControlFlags(argv)
	for (const refused of ['manifest', 'output']) {
		if (flags.values.has(refused)) {
			throw new Error(
				`\`app register\` compiles the manifest in memory and takes no --${refused}; use \`control register --manifest=<path>\` for a built file.`,
			)
		}
	}
	const inputs = registrationInputs(flags)
	const client = controlClient(flags, env)
	const controlKey = secret('FABRIKA_CONTROL_KEY', env)
	let body: RegisterAppRequest
	try {
		const compiled = await compile(inputs.env)
		const manifest = parseJsonText(compiled.text, IN_MEMORY_MANIFEST)
		body = registrationRequest(inputs, compiled.provider, manifest, IN_MEMORY_MANIFEST)
	} catch (error) {
		throw new Error(`Compile phase failed; nothing was registered. ${failureMessage(error, controlKey, 'FABRIKA_CONTROL_KEY')}`)
	}
	let result: RegisterAppResponse
	try {
		result = await client.register(await withNamespacePublicOrigin(body, client))
	} catch (error) {
		throw new Error(
			`Register phase failed after a successful compile; no manifest file was written. ${failureMessage(error, controlKey, 'FABRIKA_CONTROL_KEY')}`,
		)
	}
	emit(flags, result, () => registrationLine(result))
}

/**
 * `apps environments put` is how a REGISTERED app takes a changed manifest — `register` creates and
 * refuses a second app with the same id, so it cannot serve a redeploy of a moved descriptor.
 *
 * It replaces the whole environment record, so every optional placement flag left out is cleared. That
 * is the procedure's own semantics, shared with the console, not a choice made here.
 */
const runEnvironments = async (
	verb: string | undefined,
	flags: Flags,
	provider: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
): Promise<void> => {
	const client = controlClient(flags, env)
	if (verb === 'list') {
		const appId = required(flags, 'app')
		const result = await client.apps.environments.list({ appId })
		emitList(flags, result, environmentLine, `app ${appId} has no environments`)
		return
	}
	if (verb === 'put') {
		if (provider === undefined || provider === '') {
			throw new Error('--provider=<name> is required: it labels the envelope this environment carries.')
		}
		const manifestPath = required(flags, 'manifest')
		const manifest = await readJsonFile(manifestPath)
		const version = manifestVersion(manifest, manifestPath)
		const domain = optional(flags, 'domain')
		const publicOrigin = optional(flags, 'public-origin')
		const origins = crossOrigins(flags)
		const triggerRef = optional(flags, 'trigger-ref')
		const namespaceId = optional(flags, 'namespace')
		const kind = environmentKind(flags)
		const environment: PutAppEnvRequest = {
			// The same empty placeholder `register` sends: the target is DISCOVERED from the manifest.
			target: { provider, version, payload: {} },
			artifact: { provider, version, payload: manifest },
			...(domain === undefined ? {} : { domain }),
			...(publicOrigin === undefined ? {} : { publicOrigin }),
			...(origins === undefined ? {} : { crossOrigins: origins }),
			...(triggerRef === undefined ? {} : { triggerRef }),
			...(namespaceId === undefined ? {} : { namespaceId }),
			...(kind === undefined ? {} : { kind }),
		}
		const target = { appId: required(flags, 'app'), env: required(flags, 'env') }
		const result = await directWrite(client, flags, () => client.apps.environments.put({ ...target, environment }))
		if (result === null) return
		emit(flags, result, () => `${result.appId}\t${result.env}\t${result.provider}`)
		return
	}
	if (verb === 'suspend' || verb === 'resume') {
		const target = { appId: required(flags, 'app'), env: required(flags, 'env') }
		const result = await directWrite(
			client,
			flags,
			() => verb === 'suspend' ? client.apps.environments.suspend(target) : client.apps.environments.resume(target),
		)
		if (result === null) return
		if (result.namespaceId !== null) {
			console.warn(
				`the proxy of namespace ${result.namespaceId} is rebuilding; follow it: fabrika control namespaces get --namespace=${result.namespaceId}`,
			)
		}
		emit(flags, result, () => `${result.appId}\t${result.env}\t${result.suspendedAt === undefined ? 'serving' : 'suspended'}`)
		return
	}
	throw new Error(`Unknown \`control apps environments\` verb: ${verb ?? '(missing)'}`)
}

/** `--kind`, set only when the environment is created: a `dev` environment follows one workspace (ADR-0049). */
const environmentKind = (flags: Flags): AppEnvKind | undefined => {
	const kind = optional(flags, 'kind')
	if (kind === undefined) return undefined
	const known = APP_ENV_KINDS.find((candidate) => candidate === kind)
	if (known === undefined) throw new Error(`--kind must be one of ${APP_ENV_KINDS.join(', ')}`)
	return known
}

/** One environment per line; the cross origins are comma-joined, `-` when it lists none (a Control older than the field included). */
export const environmentLine = (item: Pick<AppEnvDto, 'appId' | 'env' | 'provider' | 'domain'> & Partial<Pick<AppEnvDto, 'crossOrigins'>>): string =>
	`${item.appId}\t${item.env}\t${item.provider}\t${item.domain ?? '-'}\t${
		item.crossOrigins === undefined || item.crossOrigins.length === 0 ? '-' : item.crossOrigins.join(',')
	}`

/**
 * A variable is NOT a secret: its value is stored and read back in clear, so it takes a flag. The one
 * thing an app cannot commit and fabrika cannot infer — an installation's IAM issuer, say — is written
 * here, and the deploy carries it to the service's environment.
 */
const runVariables = async (verb: string | undefined, flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	const client = controlClient(flags, env)
	const appId = required(flags, 'app')
	const scope = optional(flags, 'env')
	if (verb === 'list') {
		const result = await client.apps.variables.list({ appId })
		emitList(flags, result, (item) => `${item.env ?? '*'}\t${item.name}\t${item.value}`, `app ${appId} has no variables`)
		return
	}
	if (verb === 'put') {
		const variable: PutAppVarRequest = {
			name: required(flags, 'name'),
			value: required(flags, 'value'),
			...(scope === undefined ? {} : { env: scope }),
			...(flags.notSecret ? { notSecret: true } : {}),
		}
		if (flags.request) {
			await requestChange(client, flags, 'apps.variables.put', { appId, variable: { ...variable } })
			return
		}
		const result = await directWrite(client, flags, () => client.apps.variables.put({ appId, variable }))
		if (result === null) return
		emit(flags, result, () => `${result.env ?? '*'}\t${result.name}\t${result.value}`)
		return
	}
	if (verb === 'delete') {
		const target = { appId, name: required(flags, 'name'), ...(scope === undefined ? {} : { env: scope }) }
		if (flags.request) {
			await requestChange(client, flags, 'apps.variables.delete', target)
			return
		}
		const result = await directWrite(client, flags, () => client.apps.variables.delete(target))
		if (result === null) return
		emit(flags, result, () => (result.ok ? 'deleted' : 'not deleted'))
		return
	}
	throw new Error(`Unknown \`control apps variables\` verb: ${verb ?? '(missing)'}`)
}

/** Where `apps secrets put` reads a secret's value. The CLI reads the process's stdin; a test hands its own. */
export interface SecretValueInput {
	readonly isTerminal: () => boolean
	readonly text: () => Promise<string>
}

const processStdin: SecretValueInput = {
	isTerminal: () => process.stdin.isTTY === true,
	text: () => Bun.stdin.text(),
}

/** The value piped in, without the one newline `echo` or a heredoc ends it with. */
const readSecretValue = async (input: SecretValueInput, appId: string, name: string): Promise<string> => {
	if (input.isTerminal()) {
		throw new Error(
			'`apps secrets put` reads the value from stdin, and stdin is a terminal. Pipe the value in, for example: '
				+ `openssl rand -base64 32 | fabrika control apps secrets put --app=${appId} --name=${name}`,
		)
	}
	const value = (await input.text()).replace(/\r?\n$/, '')
	if (value === '') {
		throw new Error('`apps secrets put` read an empty value from stdin; nothing was stored')
	}
	return value
}

/**
 * A secret's value is write-only: it comes in on stdin, never as a flag a shell history or a process listing
 * keeps, and no verb prints it. Control seals it and keeps only a reference.
 */
const runSecrets = async (
	verb: string | undefined,
	flags: Flags,
	env: Readonly<Record<string, string | undefined>>,
	input: SecretValueInput,
): Promise<void> => {
	const client = controlClient(flags, env)
	const appId = required(flags, 'app')
	const scope = optional(flags, 'env')
	if (verb === 'list') {
		const result = await client.apps.secrets.list({ appId })
		emitList(flags, result, (item) => `${item.env ?? '*'}\t${item.name}\t${item.storage}`, `app ${appId} has no secrets`)
		return
	}
	if (verb === 'put') {
		if (flags.values.has('value')) {
			throw new Error('`apps secrets put` takes no --value: pipe the value in on stdin, so it stays out of shell history and process listings')
		}
		const name = required(flags, 'name')
		const value = await readSecretValue(input, appId, name)
		const secret: PutAppSecretRequest = { name, value, ...(scope === undefined ? {} : { env: scope }) }
		if (flags.request) {
			await requestChange(client, flags, 'apps.secrets.put', { appId, secret: { ...secret } }, value)
			return
		}
		let result: AppSecretDto | null
		try {
			result = await directWrite(client, flags, () => client.apps.secrets.put({ appId, secret }), value)
		} catch (error) {
			if (error instanceof ApprovalPendingError) throw error
			throw new Error(failureMessage(error, value, 'secret value'))
		}
		if (result === null) return
		emit(flags, result, () => `${result.env ?? '*'}\t${result.name}\tok`)
		return
	}
	if (verb === 'delete') {
		const target = { appId, name: required(flags, 'name'), ...(scope === undefined ? {} : { env: scope }) }
		if (flags.request) {
			await requestChange(client, flags, 'apps.secrets.delete', target)
			return
		}
		const result = await directWrite(client, flags, () => client.apps.secrets.delete(target))
		if (result === null) return
		emit(flags, result, () => (result.ok ? 'deleted' : 'not deleted'))
		return
	}
	throw new Error(`Unknown \`control apps secrets\` verb: ${verb ?? '(missing)'}`)
}

const runApps = async (
	verb: string | undefined,
	flags: Flags,
	provider: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
	input: SecretValueInput,
): Promise<void> => {
	if (verb === 'secrets') {
		await runSecrets(flags.positional[1], flags, env, input)
		return
	}
	if (verb === 'variables') {
		await runVariables(flags.positional[1], flags, env)
		return
	}
	if (verb === 'environments') {
		await runEnvironments(flags.positional[1], flags, provider, env)
		return
	}
	const client = controlClient(flags, env)
	if (verb === 'list') {
		const result = await client.apps.list()
		emitList(flags, result, appLine, 'no applications registered yet')
		return
	}
	if (verb === 'get') {
		const result = await client.apps.get({ appId: required(flags, 'app') })
		emit(flags, result, () => appLine(result))
		return
	}
	throw new Error(`Unknown \`control apps\` verb: ${verb ?? '(missing)'}`)
}

const runRuns = async (verb: string | undefined, flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	const client = controlClient(flags, env)
	if (verb === 'list') {
		const appId = optional(flags, 'app')
		const environment = optional(flags, 'env')
		const limit = optional(flags, 'limit')
		const result = await client.runs.list({
			...(appId === undefined ? {} : { appId }),
			...(environment === undefined ? {} : { env: environment }),
			...(limit === undefined ? {} : { limit: positiveInteger(limit, 'limit') }),
		})
		emitList(flags, result, runLine, 'no runs')
		return
	}
	if (verb === 'get') {
		const result = await client.runs.get({ runId: required(flags, 'run') })
		const hint = runHint(result)
		if (hint !== null) console.warn(hint)
		emit(flags, result, () => runLine(result))
		return
	}
	if (verb === 'log') {
		const result = await client.runs.log({ runId: required(flags, 'run') })
		emit(flags, result, () => result.lines.map((line) => line.text).join('\n'))
		return
	}
	throw new Error(`Unknown \`control runs\` verb: ${verb ?? '(missing)'}`)
}

/** Also `fabrika namespace`'s row, which reads only these fields of Control's answer. */
export const namespaceLine = (namespace: Pick<DeploymentNamespaceDto, 'id' | 'env' | 'state' | 'exclusiveAppId'>): string =>
	`${namespace.id}\t${namespace.env}\t${namespace.state}\t${namespace.exclusiveAppId ?? '-'}`

/** One line per host the placement serves: a `free` one is exactly what the next `--domain` accepts. */
const namespaceHostLines = (namespace: DeploymentNamespaceDetailDto): string[] =>
	(namespace.hosts ?? []).map((entry) =>
		`${entry.host}\t${entry.port}\t${entry.takenBy === undefined ? 'free' : `taken by ${entry.takenBy.appId}/${entry.takenBy.environment}`}`
	)

/**
 * One `<path>\t<value>` row per scalar of a provider payload, keyed by its path in `--json`. The payload
 * is the provider's own schema, so it is walked rather than decoded. A multi-line string — a whole
 * descriptor file — cannot be a row cell, so its row names only its size.
 */
const payloadRows = (path: string, value: JsonValue): string[] => {
	if (Array.isArray(value)) {
		return value.length === 0 ? [`${path}\t[]`] : value.flatMap((item, index) => payloadRows(`${path}.${index}`, item))
	}
	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value)
		return entries.length === 0 ? [`${path}\t{}`] : entries.flatMap(([key, item]) => payloadRows(`${path}.${key}`, item))
	}
	return [`${path}\t${value === null ? 'null' : cell(String(value))}`]
}

/** A value that would break a row — a line break or a tab — is shown by size only; `--json` prints it whole. */
const cell = (value: string): string => /[\r\n\t]/.test(value) ? `(${new TextEncoder().encode(value).byteLength} bytes; --json prints it)` : value

export const namespacePlanLines = (plan: PlanDeploymentNamespaceResponse): string[] => [
	`namespace.id\t${plan.namespace.id}`,
	`namespace.env\t${plan.namespace.env}`,
	`namespace.exclusiveAppId\t${plan.namespace.exclusiveAppId ?? '-'}`,
	`namespace.target.provider\t${plan.namespace.target.provider}`,
	`namespace.target.version\t${plan.namespace.target.version}`,
	...payloadRows('namespace.target.payload', plan.namespace.target.payload),
	`presentation.preset\t${plan.presentation.preset}`,
	`presentation.title\t${cell(plan.presentation.title)}`,
	...plan.presentation.facts.map((fact) => `presentation.fact\t${cell(fact.label)}\t${cell(fact.value)}`),
	...plan.presentation.instructions.map((instruction) => `presentation.instruction\t${cell(instruction)}`),
]

/**
 * The failure is a DIAGNOSTIC, so it goes to stderr and leaves the data columns above untouched. A `failed` state is an
 * answer, not a command failure, so the exit code stays 0, and the line names the verb that resumes it. An unconfirmed
 * update is the exception: only retrying that update clears it, and its message says so.
 */
const warnNamespaceFailure = (namespace: DeploymentNamespaceDto): void => {
	// Falsy, not `=== null`: a control plane that omits the field must not print an empty diagnostic.
	if (namespace.lastError) console.warn(`${namespace.lastErrorCode ?? 'unknown'}: ${namespace.lastError}`)
	if (namespace.state === 'failed' && namespace.unconfirmedTarget === undefined) {
		console.warn(`resume it with: fabrika control namespaces reconcile --namespace=${namespace.id}`)
	}
}

/** Placement flags are the preset's overrides, so only the ones actually given are sent. */
const namespacePlan = (flags: Flags): PlanDeploymentNamespaceRequest => {
	const exclusiveAppId = optional(flags, 'exclusive-app')
	const options: Record<string, JsonValue> = {}
	const project = optional(flags, 'project')
	const corePackage = optional(flags, 'core-package')
	const publicAccess = optional(flags, 'public-access')
	if (project !== undefined) options['projectName'] = project
	if (corePackage !== undefined) options['corePackage'] = corePackage
	if (publicAccess !== undefined) options['publicAccess'] = publicAccess
	const postgresType = optional(flags, 'postgres-type')
	const postgresProfile = optional(flags, 'postgres-profile')
	// Together or not at all: a type without a profile gets the platform's default, which for HA is the dedicated ~$72 one.
	if ((postgresType === undefined) !== (postgresProfile === undefined)) throw new Error('--postgres-type and --postgres-profile go together')
	if (postgresType !== undefined && postgresProfile !== undefined) options['postgres'] = { type: postgresType, profile: postgresProfile }
	return {
		id: required(flags, 'namespace'),
		env: required(flags, 'env'),
		preset: required(flags, 'preset'),
		...(exclusiveAppId === undefined ? {} : { exclusiveAppId }),
		...(Object.keys(options).length === 0 ? {} : { options }),
	}
}

const runNamespaces = async (verb: string | undefined, flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	const client = controlClient(flags, env)
	if (verb === 'list') {
		const result = await client.namespaces.list()
		emitList(flags, result, namespaceLine, 'no deployment namespaces yet')
		return
	}
	if (verb === 'get') {
		const result = await client.namespaces.get({ namespaceId: required(flags, 'namespace') })
		warnNamespaceFailure(result)
		emit(flags, result, () => [namespaceLine(result), ...namespaceHostLines(result)].join('\n'))
		return
	}
	if (verb === 'plan') {
		const result = await client.namespaces.plan(namespacePlan(flags))
		emit(flags, result, () => namespacePlanLines(result).join('\n'))
		return
	}
	if (verb === 'reconcile') {
		// Provisioning checkpoints its progress, so a namespace left `failed` by a denied or interrupted
		// call is resumed by re-queueing it here rather than by creating a second one under another id.
		const result = await client.namespaces.reconcile({ namespaceId: required(flags, 'namespace') })
		emit(flags, result, () => namespaceLine(result))
		return
	}
	if (verb === 'remove') {
		const result = await client.namespaces.remove({ namespaceId: required(flags, 'namespace') })
		// Fabrika holds OWNER on the projects it creates and deletes none of them here (ADR-0034), so what
		// it has just stopped tracking is named for the operator to remove by hand. Only the facts the
		// provider MARKED as live resources: a policy fact is not something anyone has to go and delete.
		for (const fact of (result.removed.presentation?.facts ?? []).filter((fact) => fact.resource === true)) {
			console.warn(`retained\t${fact.label}\t${fact.value}`)
		}
		emit(flags, result, () => namespaceLine(result.removed))
		return
	}
	if (verb === 'release-claims') {
		const result = await client.namespaces.releaseClaims({
			namespaceId: required(flags, 'namespace'),
			appId: required(flags, 'app'),
			env: required(flags, 'env'),
		})
		emit(flags, result, () => result.released.map((key) => `released\t${key}`).join('\n'))
		return
	}
	if (verb === 'update') {
		const namespaceId = required(flags, 'namespace')
		if (required(flags, 'proxy-source') !== 'current') {
			throw new Error('--proxy-source takes only `current`: the source this control plane deploys new placements from')
		}
		// The envelope names the provider and codec the stored target already has; the provider merges the field over it.
		const { target } = await client.namespaces.get({ namespaceId })
		const result = await client.namespaces.update({
			namespaceId,
			namespace: { target: { provider: target.provider, version: target.version, payload: { proxySource: 'current' } } },
		})
		warnNamespaceFailure(result)
		emit(flags, result, () => namespaceLine(result))
		return
	}
	if (verb === 'create') {
		const request = namespacePlan(flags)
		// Plan then commit THAT plan, exactly as the console's two-step form does — never a second
		// derivation, which could differ if the provider's defaults moved between the two calls.
		const planned = await client.namespaces.plan(request)
		const result = await client.namespaces.create({
			id: request.id,
			env: request.env,
			target: planned.namespace.target,
			...(request.exclusiveAppId === undefined ? {} : { exclusiveAppId: request.exclusiveAppId }),
		})
		warnNamespaceFailure(result)
		emit(flags, result, () => namespaceLine(result))
		return
	}
	throw new Error(`Unknown \`control namespaces\` verb: ${verb ?? '(missing)'}`)
}

// ── IAM's client registry (ADR-0089) ─────────────────────────────────────────
// `external-apps` and `oauth-clients` call IAM's `/admin/rpc` with the provisioning key as the bearer, the credential
// Control's own IAM provisioning client sends. A person's device grant does not reach IAM's admin API.

const PROVISIONING_KEY_LABEL = '[FABRIKA_IAM_PROVISIONING_KEY]'

/** `text` with the provisioning key cut out: every diagnostic of the registry verbs passes through it. */
const withoutProvisioningKey = (text: string, env: Readonly<Record<string, string | undefined>>): string => {
	const key = env['FABRIKA_IAM_PROVISIONING_KEY']?.trim()
	return key === undefined || key === '' ? text : text.replaceAll(key, PROVISIONING_KEY_LABEL)
}

export type IamAdminClient = InferRpcClient<IamAdminRpcContract>

/** IAM's admin RPC at its public origin, with the provisioning key from the environment only and no redirect followed. */
export const iamAdminClient = (
	url: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
	send: RpcFetch = fetch,
): IamAdminClient => {
	const origin = credentialOrigin(url ?? env['FABRIKA_IAM_RPC_URL'], IAM_ORIGIN)
	const key = secret('FABRIKA_IAM_PROVISIONING_KEY', env)
	return createRpcClient<IamAdminRpcContract>({
		baseUrl: `${origin}/admin/rpc`,
		bounceOnAuth: false,
		fetch: async (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${key}`)
			let response: Response
			try {
				// A followed 307/308 would re-send the provisioning key to wherever it points; the client refuses a 3xx.
				response = await send(input, { ...init, headers, redirect: 'manual' })
			} catch (cause) {
				// The RPC client reads a rejected fetch as "Network request failed"; this answer keeps the reason.
				return Response.json({ error: { type: 'transport', message: unreachableIam(origin, cause) } }, { status: 502 })
			}
			return await withoutEchoedKey(response, key, { service: 'IAM', label: PROVISIONING_KEY_LABEL })
		},
	})
}

const roleFileSchema = z.object({ key: z.string(), name: z.string() }).strict()
const externalAppClientFileSchema = z.object({
	clientId: z.string(),
	redirectUris: z.array(z.string()),
	metadataUrl: z.string().nullable().optional(),
}).strict()
const externalAppFileSchema = z.object({
	app: z.string(),
	name: z.string(),
	resource: z.string(),
	roles: z.array(roleFileSchema).nullable().optional(),
	clients: z.array(externalAppClientFileSchema),
}).strict()
const oauthClientFileSchema = z.object({
	clientId: z.string(),
	label: z.enum(OAUTH_CLIENT_PROVIDERS),
	redirectUris: z.array(z.string()),
	metadataUrl: z.string().nullable().optional(),
}).strict()

/** What IAM refuses of one client's coordinates, checked with the contract's own predicates. */
const clientProblems = (at: string, client: { clientId: string; redirectUris: string[]; metadataUrl?: string | null | undefined }): string[] => {
	const problems: string[] = []
	if (!isCimdClientId(client.clientId)) problems.push(`${at}.clientId must be the https URL of the client's metadata document, with a path`)
	const uris = client.redirectUris
	if (uris.length === 0 || uris.length > 32 || !uris.every((uri) => isOAuthResourceUri(uri)) || new Set(uris).size !== uris.length) {
		problems.push(`${at}.redirectUris must list 1 to 32 distinct exact https URLs (loopback http locally) without a fragment`)
	}
	if (client.metadataUrl != null && !isHttpsDocumentUrl(client.metadataUrl)) {
		problems.push(`${at}.metadataUrl must be an https URL without credentials or a fragment, or null`)
	}
	return problems
}

/** Zod's complaints about a file's shape, each as `<path>: <message>`; never the value it read. */
const shapeProblems = (error: z.ZodError): string[] =>
	error.issues.map((issue) => `${issue.path.length === 0 ? '(file)' : issue.path.join('.')}: ${issue.message}`)

const refuseFile = (path: string, what: string, problems: readonly string[]): never => {
	throw new Error(`${path} is not ${what}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
}

/** An `externalApps.put` request from a file, checked against the contract before it is sent; IAM checks it again. */
export const parseExternalAppFile = (value: JsonValue, path: string): PutExternalAppRequest => {
	const shape = externalAppFileSchema.safeParse(value)
	if (!shape.success) return refuseFile(path, 'an external application', shapeProblems(shape.error))
	const file = shape.data
	const problems: string[] = []
	if (!isOAuthIdentityAppId(file.app)) problems.push('app must be lowercase letters, digits and dashes, without `@`, at most 63 characters')
	const nameProblem = displayNameProblem(file.name)
	if (nameProblem !== null) problems.push(`name ${nameProblem}`)
	if (!isOAuthResourceUri(file.resource) || !file.resource.startsWith('https://')) problems.push('resource must be an https URI without a fragment')
	const roles = file.roles ?? []
	if (roles.length > MAX_OAUTH_IDENTITY_ROLES) problems.push(`roles holds at most ${MAX_OAUTH_IDENTITY_ROLES} roles`)
	for (const [index, role] of roles.entries()) {
		if (!isOAuthIdentityRoleKey(role.key)) problems.push(`roles.${index}.key must be lowercase like an app id and no built-in role`)
		else if (roles.findIndex((other) => other.key === role.key) !== index) problems.push(`roles.${index}.key repeats '${role.key}'`)
		if (role.name === '' || role.name.length > 100) problems.push(`roles.${index}.name must be 1 to 100 characters`)
	}
	if (file.clients.length > MAX_EXTERNAL_APP_CLIENTS) problems.push(`clients holds at most ${MAX_EXTERNAL_APP_CLIENTS} clients`)
	for (const [index, client] of file.clients.entries()) {
		problems.push(...clientProblems(`clients.${index}`, client))
		if (file.clients.findIndex((other) => other.clientId === client.clientId) !== index) problems.push(`clients.${index}.clientId repeats a client`)
	}
	if (problems.length > 0) return refuseFile(path, 'an external application', problems)
	return {
		app: file.app,
		name: file.name,
		resource: file.resource,
		roles: roles.length === 0 ? null : roles,
		clients: file.clients.map((client) => ({ clientId: client.clientId, redirectUris: client.redirectUris, metadataUrl: client.metadataUrl ?? null })),
	}
}

/** An `oauthClients.put` request (an MCP authoring client) from a file, checked against the contract before it is sent. */
export const parseOAuthClientFile = (value: JsonValue, path: string): PutOAuthClientRequest => {
	const shape = oauthClientFileSchema.safeParse(value)
	if (!shape.success) return refuseFile(path, 'an authoring client', shapeProblems(shape.error))
	const file = shape.data
	const problems = clientProblems('(file)', file)
	if (problems.length > 0) return refuseFile(path, 'an authoring client', problems)
	return { clientId: file.clientId, label: file.label, redirectUris: file.redirectUris, metadataUrl: file.metadataUrl ?? null }
}

/** What `external-apps get` prints: the file `external-apps put` takes back, so a record can be kept and edited as a file. */
export const externalAppFile = (app: ExternalAppDto): PutExternalAppRequest => ({
	app: app.app,
	name: app.name ?? app.app,
	resource: app.resource,
	roles: app.roles,
	clients: app.clients,
})

const externalAppLine = (app: ExternalAppDto): string =>
	[app.app, app.name ?? '', app.resource, `${app.roles?.length ?? 0} roles`, `${app.clients.length} clients`].join('\t')

const oauthClientLine = (client: OAuthClientDto): string =>
	[client.clientId, client.label, client.externalApp ?? 'authoring', client.redirectUris.join(',')].join('\t')

const positionalArgument = (flags: Flags, what: string, usage: string): string => {
	const value = flags.positional[1]
	if (value === undefined || value === '') throw new Error(`${usage} needs ${what}`)
	if (flags.positional.length > 2) throw new Error(`${usage} takes only ${what}`)
	return value
}

const fileArgument = async (flags: Flags): Promise<{ readonly path: string; readonly value: JsonValue }> => {
	const path = required(flags, 'file')
	return { path, value: await readJsonFile(path) }
}

/** Every registry verb names the not-imported refusal's way out: deploy the platform first. */
const registryCall = async <T>(call: () => Promise<T>): Promise<T> => {
	try {
		return await call()
	} catch (error) {
		if (error instanceof RpcError && error.httpStatus === 409 && error.message === OAUTH_REGISTRY_NOT_IMPORTED) {
			throw new Error(
				'IAM does not take registry writes yet: a platform deploy of this release has not imported the OAuth client list. '
					+ 'Run the platform deploy, then repeat this command.',
			)
		}
		throw error
	}
}

const runExternalApps = async (verb: string | undefined, flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	if (verb === 'put') {
		const { path, value } = await fileArgument(flags)
		const request = parseExternalAppFile(value, path)
		const result = await registryCall(() => iamAdminClient(flags.values.get('iam-url'), env).externalApps.put(request))
		emit(flags, result, () => externalAppLine(result))
		return
	}
	if (verb === 'list') {
		if (flags.positional.length > 1) throw new Error('`control external-apps list` takes no argument')
		const result = await iamAdminClient(flags.values.get('iam-url'), env).externalApps.list()
		emitList(flags, result, externalAppLine, 'no external applications registered')
		return
	}
	if (verb === 'get') {
		const app = positionalArgument(flags, 'an app id', '`control external-apps get`')
		const result = await iamAdminClient(flags.values.get('iam-url'), env).externalApps.get({ app })
		console.info(JSON.stringify(flags.json ? result : externalAppFile(result), null, 2))
		return
	}
	if (verb === 'delete') {
		const app = positionalArgument(flags, 'an app id', '`control external-apps delete`')
		const result = await iamAdminClient(flags.values.get('iam-url'), env).externalApps.delete({ app })
		emit(flags, result, () => 'deleted')
		return
	}
	throw new Error(`Unknown \`control external-apps\` verb: ${verb ?? '(missing)'}`)
}

const runOAuthClients = async (verb: string | undefined, flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	if (verb === 'put') {
		const { path, value } = await fileArgument(flags)
		const request = parseOAuthClientFile(value, path)
		const result = await registryCall(() => iamAdminClient(flags.values.get('iam-url'), env).oauthClients.put(request))
		emit(flags, result, () => oauthClientLine(result))
		return
	}
	if (verb === 'list') {
		if (flags.positional.length > 1) throw new Error('`control oauth-clients list` takes no argument')
		const result = await iamAdminClient(flags.values.get('iam-url'), env).oauthClients.list()
		emitList(flags, result, oauthClientLine, 'no OAuth clients registered')
		return
	}
	if (verb === 'delete') {
		const clientId = positionalArgument(flags, 'a client id', '`control oauth-clients delete`')
		const result = await iamAdminClient(flags.values.get('iam-url'), env).oauthClients.delete({ clientId })
		emit(flags, result, () => 'deleted')
		return
	}
	throw new Error(`Unknown \`control oauth-clients\` verb: ${verb ?? '(missing)'}`)
}

const runDeploy = async (flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	const ref = optional(flags, 'ref')
	const client = controlClient(flags, env)
	const created = await client.deploy({
		appId: required(flags, 'app'),
		env: required(flags, 'env'),
		...(ref === undefined ? {} : { ref }),
	})
	const result = flags.wait ? await followRun((runId) => client.runs.get({ runId }), created, { intervalMs: WAIT_INTERVAL_MS }) : created
	const hint = runHint(result)
	if (hint !== null && !flags.wait) console.warn(hint)
	emit(flags, result, () => runLine(result))
}

/** How often `deploy --wait` reads the run, and `requests get --wait` the request, again. */
const WAIT_INTERVAL_MS = 5000

/**
 * What stderr says about a run beside its row: the link a person approves it at, or why it failed. A non-person's
 * deploy of a protected environment carries the link from its creation (ADR-0050 §4).
 */
export const runHint = (run: RunDto): string | null => {
	if (run.status === 'failed') {
		if (run.failureCause === 'rejected') return 'a person refused this deploy; nothing was deployed'
		if (run.failureCause === 'expired') return 'nobody approved or refused this deploy before its deadline, so it expired; nothing was deployed'
		return `why it failed: fabrika control runs log --run=${run.id}`
	}
	if (run.approvalUrl !== undefined) return `a person approves or refuses this deploy at ${run.approvalUrl}`
	return null
}

/**
 * Follow a run until it succeeds or fails, saying on stderr when it starts to wait for a person and where. Approval is
 * only a step: an approved run deploys, and its outcome is what this answers.
 */
export const followRun = async (
	read: (runId: string) => Promise<RunDto>,
	created: RunDto,
	options: { readonly intervalMs: number },
): Promise<RunDto> => {
	let run = created
	let said: string | null = null
	while (run.status !== 'succeeded' && run.status !== 'failed') {
		const hint = runHint(run)
		const line = hint === null ? `the run is ${run.status.replace('_', ' ')}` : hint
		if (line !== said) console.warn(line)
		said = line
		await Bun.sleep(options.intervalMs)
		run = await read(run.id)
	}
	const hint = runHint(run)
	if (hint !== null) console.warn(hint)
	return run
}

/**
 * Ask a person to approve a write instead of making it (ADR-0083 §8): stderr says where they decide it and, for a
 * secret, the value's fingerprint, computed here and compared with Control's; stdout prints the request. `secretValue`
 * is cut out of any failure that quotes it.
 */
const requestChange = async (client: ControlClient, flags: Flags, kind: string, input: JsonValue, secretValue?: string): Promise<void> => {
	let created: CreateApprovalRequestResponse
	try {
		created = await client.approvals.requests.create({ kind, input })
	} catch (error) {
		if (secretValue === undefined) throw error
		throw new Error(failureMessage(error, secretValue, 'secret value'))
	}
	await handRequest(client, flags, created, { routed: false, ...(secretValue === undefined ? {} : { secretValue }) })
}

/**
 * The exit code of a write that did not apply because it waits for a person (ADR-0083 §3): neither done nor failed.
 * sysexits' EX_TEMPFAIL, "not done now; it may be later".
 */
export const APPROVAL_PENDING_EXIT_CODE = 75

/** A write Control stored as a request for a person instead of making it; the process exits with `APPROVAL_PENDING_EXIT_CODE`. */
export class ApprovalPendingError extends Error {
	readonly exitCode = APPROVAL_PENDING_EXIT_CODE
}

/** What printing and following a request takes from a command's flags. */
export interface RequestOutput {
	readonly json: boolean
	readonly wait: boolean
}

/**
 * The request Control stored a write as (`approval_requested`), or null for any other answer. An answer whose data does
 * not read as a request is left as Control's refusal, whose message names the link.
 */
const routedRequest = (error: unknown): CreateApprovalRequestResponse | null => {
	if (!(error instanceof RpcError) || error.type !== APPROVAL_REQUESTED) return null
	const parsed = approvalRequestedSchema.safeParse(error.data)
	return parsed.success ? parsed.data : null
}

/**
 * Make a write; when Control stores it as a request for a person instead (D8, a protected environment), print the
 * request as `--request` does and, without `--wait`, fail with `ApprovalPendingError`. With `--wait` the request is
 * followed: an executed one answers null, anything else fails. `secretValue` is the value a secret write sent, whose
 * fingerprint is computed here.
 */
export const directWrite = async <T>(
	client: ControlClient,
	output: RequestOutput,
	write: () => Promise<T>,
	secretValue?: string,
): Promise<T | null> => {
	try {
		return await write()
	} catch (error) {
		const created = routedRequest(error)
		if (created === null) throw error
		await handRequest(client, output, created, { routed: true, ...(secretValue === undefined ? {} : { secretValue }) })
		return null
	}
}

/**
 * Print a request a person decides: for a secret, the value's fingerprint, computed here and compared with Control's;
 * then follow it with `--wait`, or print it. A routed write that did not execute fails.
 */
const handRequest = async (
	client: ControlClient,
	output: RequestOutput,
	created: CreateApprovalRequestResponse,
	options: { readonly routed: boolean; readonly secretValue?: string },
): Promise<void> => {
	if (options.secretValue !== undefined) {
		// The first 8 hex characters of the value's SHA-256, as the page shows them: the CLI's own, not an echo of Control's.
		const fingerprint = sha256Hex(options.secretValue).slice(0, 8)
		if (created.fingerprint !== fingerprint) {
			throw new Error(
				`Control answered the fingerprint ${created.fingerprint ?? '(none)'}, but the value sent has ${fingerprint}: `
					+ `refuse the request at ${created.url}, since what it holds is not the value you sent`,
			)
		}
		console.warn(`the value's fingerprint is ${fingerprint}: the person sees the same one beside the value's length on the page`)
	}
	if (output.wait) {
		const read = (id: string) => client.approvals.requests.get({ id })
		const result = await followRequest(read, await read(created.id), { intervalMs: WAIT_INTERVAL_MS, settleTimeoutMs: REQUEST_SETTLE_TIMEOUT_MS })
		emit(output, result, () => requestLine(result))
		if (options.routed && result.state !== 'executed') {
			throw new Error(requestHint(result) ?? `the request is ${result.state}`)
		}
		return
	}
	if (!options.routed) console.warn(`a person approves or refuses this request at ${created.url}`)
	emit(output, created, () => `${created.id}\t${created.state}\t${created.url}`)
	if (options.routed) {
		throw new ApprovalPendingError(
			`the change was not made: it waits for a person, who approves or refuses it at ${created.url}; `
				+ `hand them the link, and follow it with \`fabrika control requests get ${created.id} --wait\``,
		)
	}
}

const runRequests = async (verb: string | undefined, flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	if (verb !== 'get') throw new Error(`Unknown \`control requests\` verb: ${verb ?? '(missing)'}`)
	const id = flags.positional[1]
	if (id === undefined) throw new Error('`control requests get` needs the request id: fabrika control requests get <id>')
	const client = controlClient(flags, env)
	const read = (requestId: string) => client.approvals.requests.get({ id: requestId })
	const request = await read(id)
	const result = flags.wait
		? await followRequest(read, request, { intervalMs: WAIT_INTERVAL_MS, settleTimeoutMs: REQUEST_SETTLE_TIMEOUT_MS })
		: request
	const hint = requestHint(result)
	if (hint !== null && !flags.wait) console.warn(hint)
	emit(flags, result, () => requestLine(result))
}

/** `access request-grant`: ask a person to give a principal one role of an application environment (ADR-0083 §8). */
const runAccess = async (verb: string | undefined, flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	if (verb !== 'request-grant') throw new Error(`Unknown \`control access\` verb: ${verb ?? '(missing)'}`)
	const expiresIn = Number(required(flags, 'expires-in'))
	if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) throw new Error('--expires-in must be a positive whole number of seconds')
	const scope = optional(flags, 'scope')
	const separator = scope?.indexOf(':') ?? -1
	if (scope !== undefined && (separator <= 0 || separator === scope.length - 1)) {
		throw new Error("--scope names a value of the role's dimension: --scope=<dimension>:<value>")
	}
	const input: JsonValue = {
		appId: required(flags, 'app'),
		env: required(flags, 'env'),
		principalId: required(flags, 'principal'),
		role: required(flags, 'role'),
		scope: scope === undefined ? null : { type: scope.slice(0, separator), value: scope.slice(separator + 1) },
		expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
	}
	await requestChange(controlClient(flags, env), flags, 'iam.grants.create', input)
}

const requestLine = (request: ApprovalRequestDto): string => `${request.id}\t${request.kind}\t${request.appId}\t${request.env}\t${request.state}`

/** What stderr says about a request beside its row: where a person decides it, or why it did not run. */
export const requestHint = (request: ApprovalRequestDto): string | null => {
	switch (request.state) {
		case 'pending':
			return request.url === undefined ? 'the request waits for a person' : `a person approves or refuses this request at ${request.url}`
		case 'rejected':
			return 'a person refused this request; nothing changed'
		case 'expired':
			return 'nobody approved or refused this request before its deadline, so it expired; nothing changed'
		case 'failed':
		case 'stale':
		case 'unknown':
			return request.error === undefined ? `the request is ${request.state}` : `the request is ${request.state}: ${request.error}`
		case 'approved':
		case 'executing':
			return `the request is ${request.state}`
		case 'executed':
			return null
	}
}

/**
 * How long `requests get --wait` follows a request once a person decided it. Waiting is bounded by the request's deadline,
 * but an `unknown` outcome lasts until Control settles it, which a Control without the request's kind never does.
 */
const REQUEST_SETTLE_TIMEOUT_MS = 15 * 60_000

/**
 * Follow a request until it settles, saying each stage once on stderr; what it ended as is what this answers. Once it is
 * no longer pending, it stops with an error after `settleTimeoutMs`.
 */
export const followRequest = async (
	read: (id: string) => Promise<ApprovalRequestDto>,
	first: ApprovalRequestDto,
	options: { readonly intervalMs: number; readonly settleTimeoutMs: number },
): Promise<ApprovalRequestDto> => {
	let request = first
	let said: string | null = null
	let decidedAt: number | null = null
	while (!isFinalApprovalRequestState(request.state)) {
		if (request.state !== 'pending') {
			decidedAt ??= Date.now()
			if (Date.now() - decidedAt >= options.settleTimeoutMs) {
				throw new Error(
					`the request is still ${request.state} after ${Math.round(options.settleTimeoutMs / 60_000)} minutes; Control keeps following it: `
						+ `fabrika control requests get ${request.id}`,
				)
			}
		}
		const line = requestHint(request) ?? `the request is ${request.state}`
		if (line !== said) console.warn(line)
		said = line
		await Bun.sleep(options.intervalMs)
		request = await read(request.id)
	}
	const hint = requestHint(request)
	if (hint !== null) console.warn(hint)
	return request
}

/**
 * `command` is the group (`key`, `apps`, `runs`, `requests`, `register`, `deploy`); the verb, where a group has
 * one, is the first positional word after it. `provider` reaches here only to label an envelope.
 */
/** Whether a command takes `--request`: only the writes it routes through an approval request. */
const takesRequest = (command: string | undefined, positional: readonly string[]): boolean =>
	command === 'apps' && (positional[0] === 'secrets' || positional[0] === 'variables') && (positional[1] === 'put' || positional[1] === 'delete')

export const runControlCli = async (
	command: string | undefined,
	argv: readonly string[],
	provider?: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
	input: SecretValueInput = processStdin,
): Promise<void> => {
	try {
		const flags = parseControlFlags(argv)
		const verb = flags.positional[0]
		if (flags.request && !takesRequest(command, flags.positional)) {
			throw new Error(
				'--request is taken only by apps secrets put|delete and apps variables put|delete; anywhere else it would be ignored and the write made directly',
			)
		}
		switch (command) {
			case undefined:
				console.info(USAGE)
				return
			case 'auth':
				if (verb !== 'device') throw new Error(`Unknown \`control auth\` verb: ${verb ?? '(missing)'}`)
				await runAuthDevice(flags, env)
				return
			case 'key':
				if (verb !== 'issue') throw new Error(`Unknown \`control key\` verb: ${verb ?? '(missing)'}`)
				await runKeyIssue(flags, env)
				return
			case 'apps':
				await runApps(verb, flags, provider, env, input)
				return
			case 'runs':
				await runRuns(verb, flags, env)
				return
			case 'namespaces':
				await runNamespaces(verb, flags, env)
				return
			case 'requests':
				await runRequests(verb, flags, env)
				return
			case 'access':
				await runAccess(verb, flags, env)
				return
			case 'register':
				await runRegister(flags, provider, env)
				return
			case 'deploy':
				await runDeploy(flags, env)
				return
			case 'external-apps':
				await runExternalApps(verb, flags, env)
				return
			case 'oauth-clients':
				await runOAuthClients(verb, flags, env)
				return
			default:
				throw new Error(`Unknown control command: ${command}\n\n${USAGE}`)
		}
	} catch (error) {
		if (error instanceof ApprovalPendingError) throw error
		// An RPC denial is an ANSWER, not a transport fault; keep its type so a caller can tell "the
		// control plane said no" from "the control plane was unreachable".
		const message = error instanceof RpcError ? `${error.type}: ${error.message}` : error instanceof Error ? error.message : String(error)
		throw new Error(withoutProvisioningKey(withoutControlKey(message, env), env))
	}
}

export { USAGE as CONTROL_USAGE }
