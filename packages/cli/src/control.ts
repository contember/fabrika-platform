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

import { createRpcClient, RpcError } from '@fabrika/app'
import type { IssueKeyInput, IssueKeyResult } from '@fabrika/auth-core'
import type {
	AppDto,
	ControlRpcContract,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	JsonValue,
	PlanDeploymentNamespaceRequest,
	PutAppEnvRequest,
	PutAppVarRequest,
	RegisterAppRequest,
	RunDto,
} from '@fabrika/control-contract'

const USAGE = `fabrika control — operate the Delivery control plane

Usage:
  fabrika control key issue --label=<name> --permissions=<a,b,c> [--expires-in=<seconds>] [--iam-url=<origin>]
  fabrika control apps list
  fabrika control apps get --app=<id>
  fabrika control apps environments list --app=<id>
  fabrika control apps environments put --provider=<name> --app=<id> --env=<name> --manifest=<path>
                           [--domain=<host>] [--public-origin=<url>] [--trigger-ref=<ref>] [--namespace=<id>]
  fabrika control apps variables list --app=<id>
  fabrika control apps variables put --app=<id> --name=<name> --value=<text> [--env=<name>]
  fabrika control apps variables delete --app=<id> --name=<name> [--env=<name>]
  fabrika control register --provider=<name> --app=<id> --repo=<url> --env=<name> --manifest=<path>
                           [--domain=<host>] [--public-origin=<url>] [--trigger-ref=<ref>]
                           [--namespace=<id>] [--installation-id=<n|none>]
  fabrika control namespaces list
  fabrika control namespaces get     --namespace=<id>
  fabrika control namespaces plan   --namespace=<id> --env=<name> --preset=<cheap|mid|full> [placement]
  fabrika control namespaces create --namespace=<id> --env=<name> --preset=<cheap|mid|full> [placement]
  fabrika control namespaces reconcile --namespace=<id>
  fabrika control namespaces remove --namespace=<id>
  fabrika control deploy --app=<id> --env=<name> [--ref=<ref>]
  fabrika control runs list [--app=<id>] [--env=<name>] [--limit=<n>]
  fabrika control runs get --run=<id>
  fabrika control runs log --run=<id>

\`register\` CREATES an app and refuses a second one with the same id. Re-registering a changed
manifest — a new \`zerops.yaml\`, a new import document — is \`apps environments put\`, which replaces
one environment's envelopes and leaves the app row alone.

A manifest that publishes the app through the namespace proxy is routed by HOST, so \`--domain\` is
REQUIRED for it — on \`register\` and on \`apps environments put\` alike — and a registration without one is
refused before anything is created. \`namespaces get\` lists the hosts a \`zerops-subdomain\` namespace
serves and which of them are still free; a custom-domain namespace serves the domain you bound to its
proxy. A manifest with no proxy target needs no domain.

\`--installation-id\` has three states: omitted resolves the installation from the organization's
connected GitHub App, \`none\` registers an anonymous PUBLIC repository source, and a number names one
installation outright.

Namespace placement options, each defaulting to what the preset would choose:

  --project=<name>                  the provider project the namespace owns
  --core-package=<LIGHT|SERIOUS>    defaults to LIGHT on every environment, \`prod\` included (ADR-0038).
                                    SERIOUS is a deliberate choice: a project cannot be downgraded again
  --public-access=<custom-domain|zerops-subdomain>
  --exclusive-app=<id>              required by, and only by, the \`full\` preset

\`namespaces plan\` is a preview and changes nothing. \`namespaces create\` commits that exact plan — the
same two steps the console's form takes — and returns as soon as the placement is recorded: provisioning
runs behind the control queue and takes minutes, so the state comes back \`pending\`. Follow it with
\`namespaces get\` or \`namespaces list\`; nothing needs to stay connected. \`namespaces remove\` frees the id
of a placement no application is registered in. It deletes nothing at the provider and prints, on stderr,
the provider resources it stopped tracking.

Every command accepts --json, which prints the procedure's result verbatim.

The control origin is not a credential and takes either form:

  --url=<origin>                    FABRIKA_CONTROL_URL

Credentials are read from the ENVIRONMENT ONLY and have no flag, so they cannot reach a CI log or a
process listing:

  FABRIKA_CONTROL_KEY               required   a machine \`px_\` credential for the control app

\`key issue\` mints that credential and therefore authenticates differently — it presents the
installation's IAM RPC key as transport authentication and its provisioning key as the ISSUING
credential. Both are read from the environment only:

  FABRIKA_IAM_RPC_URL               required   IAM's PUBLIC origin, or --iam-url
  FABRIKA_IAM_RPC_KEY               required   the installation's IAM RPC key
  FABRIKA_IAM_PROVISIONING_KEY      required   the installation's seeded \`px_\` provisioning key
  FABRIKA_CONTROL_APP_ID            optional   the control app's IAM id (default \`vozka\`)

The PUBLIC origin is the \`https://\` address the installation answers on — the one \`platform admin\`
and \`platform init\` print in their closing block, and the value \`FABRIKA_IAM_ISSUER\` holds on the
control service. It is NOT the private hostname the services use between themselves: \`http://iam:3000\`
resolves inside the provider's project and nowhere else, so from here it only ever fails to connect.

Connecting a GitHub source is NOT here and will not be: App creation is a browser flow whose
authorization requires a human principal (ADR-0031). Use Settings → Source in the console.
`

const DEFAULT_CONTROL_APP_ID = 'vozka'

interface Flags {
	readonly values: ReadonlyMap<string, string>
	readonly json: boolean
	readonly positional: readonly string[]
}

/** Split `--key=value` options from positional words; `--json` is the one flag every verb shares. */
export const parseControlFlags = (argv: readonly string[]): Flags => {
	const values = new Map<string, string>()
	const positional: string[] = []
	let json = false
	for (const arg of argv) {
		if (arg === '--json') {
			json = true
		} else if (arg.startsWith('--')) {
			const eq = arg.indexOf('=')
			if (eq === -1) {
				throw new Error(`Option ${arg} needs a value: ${arg}=<value>`)
			}
			values.set(arg.slice(2, eq), arg.slice(eq + 1))
		} else {
			positional.push(arg)
		}
	}
	return { values, json, positional }
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

const positiveInteger = (raw: string, name: string): number => {
	const parsed = Number(raw)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`--${name} must be a positive integer`)
	}
	return parsed
}

/** An origin from the flag, else the environment. Trailing slashes are dropped so paths concatenate. */
const origin = (flags: Flags, flag: string, variable: string, env: Readonly<Record<string, string | undefined>>): string => {
	const value = flags.values.get(flag) ?? env[variable]
	if (value === undefined || value.trim() === '') {
		throw new Error(`Control origin is required. Pass --${flag}=<origin> or set ${variable}.`)
	}
	return value.trim().replace(/\/+$/, '')
}

const secret = (variable: string, env: Readonly<Record<string, string | undefined>>): string => {
	const value = env[variable]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${variable} is required (environment only — it has no flag).`)
	}
	return value.trim()
}

/** The console's client with a bearer instead of a cookie, and no SSO bounce: there is no browser to send. */
const controlClient = (flags: Flags, env: Readonly<Record<string, string | undefined>>) => {
	const base = origin(flags, 'url', 'FABRIKA_CONTROL_URL', env)
	const key = secret('FABRIKA_CONTROL_KEY', env)
	return createRpcClient<ControlRpcContract>({
		baseUrl: `${base}/api/rpc`,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${key}`)
			return fetch(input, { ...init, headers })
		},
	})
}

const readJsonFile = async (path: string): Promise<JsonValue> => {
	const file = Bun.file(path)
	if (!(await file.exists())) {
		throw new Error(`No such file: ${path}`)
	}
	const text = await file.text()
	try {
		const parsed: unknown = JSON.parse(text)
		return asJsonValue(parsed, path)
	} catch (error) {
		throw error instanceof SyntaxError ? new Error(`${path} is not valid JSON`) : error
	}
}

/** `JSON.parse` returns `unknown`; narrow it to the contract's own JSON type without a cast. */
const asJsonValue = (value: unknown, path: string): JsonValue => {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value
	}
	if (Array.isArray(value)) {
		return value.map((entry) => asJsonValue(entry, path))
	}
	if (typeof value === 'object') {
		const out: Record<string, JsonValue> = {}
		for (const [key, entry] of Object.entries(value)) {
			out[key] = asJsonValue(entry, path)
		}
		return out
	}
	throw new Error(`${path} contains a value JSON cannot carry`)
}

const emit = (flags: Flags, result: unknown, render: () => string): void => {
	console.info(flags.json ? JSON.stringify(result, null, 2) : render())
}

/** `fabrika app build` writes `manifestVersion`; it is the version the provider's artifact codec accepts. */
const manifestVersion = (manifest: JsonValue, path: string): number => {
	const version = typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
		? Reflect.get(manifest, 'manifestVersion')
		: undefined
	if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
		throw new Error(`${path} declares no manifestVersion — run \`fabrika app build\` to produce one`)
	}
	return version
}

const appLine = (app: AppDto): string => `${app.id}\t${app.repoUrl}\t${app.defaultBranch}`

const runLine = (run: RunDto): string => `${run.id}\t${run.appId}\t${run.env}\t${run.status}\t${run.ref}`

/**
 * The one `key issue` failure whose cause is almost always the wrong KIND of address.
 *
 * `fetch` rejects only when the request never completed, so this reports what could not be reached and
 * the one mistake that produces it. The origin is not a credential and is named; the cause object may
 * quote anything, so only its short error code is.
 */
const unreachableIam = (base: string, cause: unknown): string => {
	const code = typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'code') : undefined
	const reason = typeof code === 'string' && code !== '' && code.length <= 40 ? code : 'the connection failed'
	return `IAM could not be reached at ${base} (${reason}). FABRIKA_IAM_RPC_URL must be IAM's PUBLIC origin: `
		+ "a private hostname such as `http://iam:3000` answers only inside the provider's project, never from this machine."
}

const runKeyIssue = async (flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	const permissions = required(flags, 'permissions').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
	if (permissions.length === 0) {
		throw new Error('--permissions needs at least one action')
	}
	const expiresIn = optional(flags, 'expires-in')
	const body: IssueKeyInput = {
		app: env['FABRIKA_CONTROL_APP_ID']?.trim() || DEFAULT_CONTROL_APP_ID,
		credential: secret('FABRIKA_IAM_PROVISIONING_KEY', env),
		requestId: crypto.randomUUID(),
		service: { label: required(flags, 'label'), permissions },
		label: required(flags, 'label'),
		...(expiresIn === undefined ? {} : { expiresAt: Math.floor(Date.now() / 1000) + positiveInteger(expiresIn, 'expires-in') }),
	}
	const base = origin(flags, 'iam-url', 'FABRIKA_IAM_RPC_URL', env)
	const response = await fetch(`${base}/rpc/issueKey`, {
		method: 'POST',
		headers: { authorization: `Bearer ${secret('FABRIKA_IAM_RPC_KEY', env)}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	}).catch((cause: unknown) => {
		throw new Error(unreachableIam(base, cause))
	})
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

const decodeIssueKeyResult = (value: unknown): IssueKeyResult => {
	if (typeof value !== 'object' || value === null) {
		throw new Error('IAM returned an unreadable issueKey result')
	}
	const ok = Reflect.get(value, 'ok')
	if (ok === false) {
		const reason = Reflect.get(value, 'reason')
		return { ok: false, reason: isIssueKeyDenial(reason) ? reason : 'not_allowed' }
	}
	const token = Reflect.get(value, 'token')
	const id = Reflect.get(value, 'id')
	const principalId = Reflect.get(value, 'principalId')
	if (ok !== true || typeof token !== 'string' || typeof id !== 'string') {
		throw new Error('IAM returned an unreadable issueKey result')
	}
	return { ok: true, token, id, ...(typeof principalId === 'string' ? { principalId } : {}) }
}

const ISSUE_KEY_DENIALS = ['missing_token', 'invalid_token', 'unknown_principal', 'disabled', 'not_allowed'] as const

const isIssueKeyDenial = (value: unknown): value is (typeof ISSUE_KEY_DENIALS)[number] =>
	typeof value === 'string' && ISSUE_KEY_DENIALS.some((denial) => denial === value)

const runRegister = async (flags: Flags, provider: string | undefined, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	if (provider === undefined || provider === '') {
		throw new Error('--provider=<name> is required: it labels the envelope this registration carries.')
	}
	const manifestPath = required(flags, 'manifest')
	const manifest = await readJsonFile(manifestPath)
	// The envelope's version is the manifest's own, never a literal: `fabrika app build` writes the
	// version its provider's codec accepts, and a hardcoded one goes stale the moment that codec moves.
	const version = manifestVersion(manifest, manifestPath)
	const installationId = optional(flags, 'installation-id')
	// Three states, because the registry has three: absent resolves from the connected GitHub App,
	// `none` is the anonymous public-repository path, and a number names one installation outright.
	const anonymousSource = installationId === 'none'
	const domain = optional(flags, 'domain')
	const publicOrigin = optional(flags, 'public-origin')
	const triggerRef = optional(flags, 'trigger-ref')
	const namespaceId = optional(flags, 'namespace')
	const body: RegisterAppRequest = {
		id: required(flags, 'app'),
		repoUrl: required(flags, 'repo'),
		env: required(flags, 'env'),
		// An empty placeholder: registration DISCOVERS the real target from the manifest and replaces this.
		target: { provider, version, payload: {} },
		artifact: { provider, version, payload: manifest },
		...(installationId === undefined
			// Blank → resolve from the installed GitHub App, which is what the console's empty field means.
			? { resolveInstallationId: true }
			: anonymousSource
			? { githubInstallationId: null }
			: { githubInstallationId: positiveInteger(installationId, 'installation-id') }),
		...(domain === undefined ? {} : { domain }),
		...(publicOrigin === undefined ? {} : { publicOrigin }),
		...(triggerRef === undefined ? {} : { triggerRef }),
		...(namespaceId === undefined ? {} : { namespaceId }),
	}
	const result = await controlClient(flags, env).register(body)
	emit(flags, result, () => `${result.app.id}\t${result.env.env}\t${result.env.provider}`)
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
		const result = await client.apps.environments.list({ appId: required(flags, 'app') })
		emit(flags, result, () => result.items.map((item) => `${item.appId}\t${item.env}\t${item.provider}\t${item.domain ?? '-'}`).join('\n'))
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
		const triggerRef = optional(flags, 'trigger-ref')
		const namespaceId = optional(flags, 'namespace')
		const environment: PutAppEnvRequest = {
			// The same empty placeholder `register` sends: the target is DISCOVERED from the manifest.
			target: { provider, version, payload: {} },
			artifact: { provider, version, payload: manifest },
			...(domain === undefined ? {} : { domain }),
			...(publicOrigin === undefined ? {} : { publicOrigin }),
			...(triggerRef === undefined ? {} : { triggerRef }),
			...(namespaceId === undefined ? {} : { namespaceId }),
		}
		const result = await client.apps.environments.put({ appId: required(flags, 'app'), env: required(flags, 'env'), environment })
		emit(flags, result, () => `${result.appId}\t${result.env}\t${result.provider}`)
		return
	}
	throw new Error(`Unknown \`control apps environments\` verb: ${verb ?? '(missing)'}`)
}

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
		emit(flags, result, () => result.items.map((item) => `${item.env ?? '*'}\t${item.name}\t${item.value}`).join('\n'))
		return
	}
	if (verb === 'put') {
		const variable: PutAppVarRequest = {
			name: required(flags, 'name'),
			value: required(flags, 'value'),
			...(scope === undefined ? {} : { env: scope }),
		}
		const result = await client.apps.variables.put({ appId, variable })
		emit(flags, result, () => `${result.env ?? '*'}\t${result.name}\t${result.value}`)
		return
	}
	if (verb === 'delete') {
		const result = await client.apps.variables.delete({ appId, name: required(flags, 'name'), ...(scope === undefined ? {} : { env: scope }) })
		emit(flags, result, () => (result.ok ? 'deleted' : 'not deleted'))
		return
	}
	throw new Error(`Unknown \`control apps variables\` verb: ${verb ?? '(missing)'}`)
}

const runApps = async (
	verb: string | undefined,
	flags: Flags,
	provider: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
): Promise<void> => {
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
		emit(flags, result, () => result.items.map(appLine).join('\n'))
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
		emit(flags, result, () => result.items.map(runLine).join('\n'))
		return
	}
	if (verb === 'get') {
		const result = await client.runs.get({ runId: required(flags, 'run') })
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

const namespaceLine = (namespace: DeploymentNamespaceDto): string =>
	`${namespace.id}\t${namespace.env}\t${namespace.state}\t${namespace.exclusiveAppId ?? '-'}`

/** One line per host the placement serves: a `free` one is exactly what the next `--domain` accepts. */
const namespaceHostLines = (namespace: DeploymentNamespaceDetailDto): string[] =>
	(namespace.hosts ?? []).map((entry) =>
		`${entry.host}\t${entry.port}\t${entry.takenBy === undefined ? 'free' : `taken by ${entry.takenBy.appId}/${entry.takenBy.environment}`}`
	)

/** The failure is a DIAGNOSTIC, so it goes to stderr and leaves the data columns above untouched. */
const warnNamespaceFailure = (namespace: DeploymentNamespaceDto): void => {
	// Falsy, not `=== null`: a control plane that omits the field must not print an empty diagnostic.
	if (!namespace.lastError) return
	console.warn(`${namespace.lastErrorCode ?? 'unknown'}: ${namespace.lastError}`)
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
		emit(flags, result, () => result.items.map(namespaceLine).join('\n'))
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
		emit(flags, result, () => JSON.stringify(result.namespace.target.payload))
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

const runDeploy = async (flags: Flags, env: Readonly<Record<string, string | undefined>>): Promise<void> => {
	const ref = optional(flags, 'ref')
	const result = await controlClient(flags, env).deploy({
		appId: required(flags, 'app'),
		env: required(flags, 'env'),
		...(ref === undefined ? {} : { ref }),
	})
	emit(flags, result, () => runLine(result))
}

/**
 * `command` is the group (`key`, `apps`, `runs`, `register`, `deploy`); the verb, where a group has
 * one, is the first positional word after it. `provider` reaches here only to label an envelope.
 */
export const runControlCli = async (
	command: string | undefined,
	argv: readonly string[],
	provider?: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> => {
	const flags = parseControlFlags(argv)
	const verb = flags.positional[0]
	try {
		switch (command) {
			case undefined:
				console.info(USAGE)
				return
			case 'key':
				if (verb !== 'issue') throw new Error(`Unknown \`control key\` verb: ${verb ?? '(missing)'}`)
				await runKeyIssue(flags, env)
				return
			case 'apps':
				await runApps(verb, flags, provider, env)
				return
			case 'runs':
				await runRuns(verb, flags, env)
				return
			case 'namespaces':
				await runNamespaces(verb, flags, env)
				return
			case 'register':
				await runRegister(flags, provider, env)
				return
			case 'deploy':
				await runDeploy(flags, env)
				return
			default:
				throw new Error(`Unknown control command: ${command}\n\n${USAGE}`)
		}
	} catch (error) {
		// An RPC denial is an ANSWER, not a transport fault; keep its type so a caller can tell "the
		// control plane said no" from "the control plane was unreachable".
		throw error instanceof RpcError ? new Error(`${error.type}: ${error.message}`) : error
	}
}

export { USAGE as CONTROL_USAGE }
