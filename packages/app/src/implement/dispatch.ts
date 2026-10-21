// The per-request pipeline of a contract application (ADR-0012 §5): canonical path and endpoint selection, the
// endpoint the proxy applied (ADR-0022 rule 5), the token, the caller kind, the requirement, admission, strict input, the access form, the handler, output
// projection. The caller-kind, requirement and access checks are authorization; the same-origin and content-type
// checks are admission. Neither is the proxy's decision: the proxy has already decided that the request may reach us.
// The anonymous kinds (health, public, webhook, the share SPA) read no token and take their own fixed steps.

import type { IamMembership, MembershipRequestCaller } from '@fabrika/auth'
import {
	answersFile,
	type CapabilitiesRequirement,
	type CompiledEndpointTable,
	type CredentialedEndpoint,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	type EndpointPlan,
	type EndpointRow,
	type ExportDescription,
	FORM_URLENCODED_TYPE,
	isAttachmentShape,
	isFileShape,
	isRedirectShape,
	type LinkTokenClaims,
	parseEndpointHeader,
	type PermissionEntry,
	permits,
	planEndpoint,
	PROXY_SECRET_HEADER,
	PROXY_TOKEN_HEADER,
	rawRequestTarget,
	type RedirectShape,
	satisfies,
	type SchemaShape,
	type ScopeBinding,
	scopedValues,
	sha256Hex,
	type WebhookScheme,
} from '@fabrika/auth-core'
import { type CapabilityAuthority, type ContainerGrant, MAX_WITHIN_VALUES } from '@fabrika/db/capability'
import type { DataAccess, FileBinding, FrameworkTables } from '@fabrika/db/framework'
import type { DataKind } from '@fabrika/db/tables'
import type { TokenVerifier } from '@fabrika/jwks'
import { applyAnswerCache, withResponseHeaders } from '@fabrika/proxy-core/headers'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod/v4'
import { fileFieldsOf } from '../contract/build'
import {
	bodyDeadlineMs,
	BROWSER_CONFIG_FILE,
	CHALLENGE_FIELD,
	FILE_INPUT_PART,
	FORM_MULTIPART_TYPE,
	joinPath,
	PAGE_CALLER_FILE,
	PROCEDURE_LIMITS,
	WEBHOOK_BINDING_PARAMETER,
} from '../contract/defaults'
import type { Schema } from '../contract/define'
import {
	BadRequestError,
	ForbiddenError,
	HttpError,
	isStructuralError,
	jsonResponse,
	NotFoundError,
	toErrorResponse,
	UnauthorizedError,
} from '../errors'
import type { RequestExecutionContext } from '../fetch'
import { FileWork, type StoredFileKinds, storedFilesHandle } from '../files/kinds'
import { FileDownload, fileResponse, withFileTreatment } from '../files/treatment'
import { abortedBody, bootstrapPath, bootstrapResponse, readBoundedBody, withBootstrap } from './anonymous'
import { attachmentResponse } from './attachment'
import { boundedStream, handlerSignal, readBoundedBytes } from './bounded'
import type { BrowserConfig } from './browser-config'
import {
	type AppCapability,
	CapabilityLimitError,
	type CapabilityMint,
	CapabilityRefusedError,
	type Ref,
	RequestFrame,
	runInRequest,
	type Within,
} from './capability'
import type { ChallengeIssuer, ChallengeVerifier } from './challenge'
import { connectContext, type ImportWire } from './connect'
import { runAsSite } from './egress'
import type { FailureReports } from './failures'
import { ServerFault } from './faults'
import { type HeaderPolicy, withHeaderPolicy } from './headers'
import type { ContractDatabase } from './implement'
import { boundTo, boundWebhookApp, endpointData, Invocation, kickRecorder, siteData, type SiteDeclaration, undeclaredSql } from './invocation'
import {
	applicationDirectory,
	createScope,
	type IssuableLink,
	linkIssuing,
	memberDirectory,
	memberManagement,
	type MembershipRequest,
	type ReadDirectory,
} from './membership'
import { multipartBoundary, MultipartError, multipartParts, type MultipartReader } from './multipart'
import { paramsObject, urlParams } from './params'
import { pageCallerOf, presentedBy, type Principal } from './principal'
import { project, ProjectionRefusedError } from './project'
import { bucketsOf, DEFAULT_ADMISSION, type InFlightShare, type ProcedureAdmission, requestClient } from './public'
import type { SignedTokens } from './tokens'
import type { AppUrl } from './urls'
import { githubAccounts, verifyDelivery } from './verifiers'
import {
	APP_BINDING_SCOPE,
	type BindableWebhook,
	deliveryKey,
	WEBHOOK_CLAIM_GRACE_MS,
	WEBHOOK_REPLAY_RETENTION_MS,
	webhookBindings,
	type WebhookPrincipal,
	webhookSubject,
} from './webhook'
import type { WorkloadCredential } from './workload'

/** SHA-256 of a proxy secret: 32 bytes whatever the secret's length, as `timingSafeEqual` needs. */
export function proxySecretDigest(secret: string): Uint8Array {
	return createHash('sha256').update(secret).digest()
}

/** Serves the files of an SPA mount. The runtime adapter supplies it: Workers Assets, or the build output on disk. */
export interface SpaAssets {
	serve(mount: { readonly prefix: string; readonly dir: string }, request: Request): Promise<Response>
}

/** What a procedure's context carries beyond its access form, decided once from the artifact. */
export interface Facilities {
	/**
	 * `ctx.members`: management where the action is the dimension's `members.manage`; otherwise the member directory of the
	 * nearest dimension, the endpoint's own or one containing it, that declares members (`endpointDirectory`); for an
	 * `app` endpoint of the application's `members.list`, its own people (`endpointAppDirectory`).
	 */
	readonly members: 'manage' | ReadDirectory | 'application' | null
	/** The link mounts whose dimension and issuing action are the endpoint's. */
	readonly links: readonly IssuableLink[]
}

export const NO_FACILITIES: Facilities = Object.freeze({ members: null, links: Object.freeze([]) })

/** A staged-kit site: its handler reaches data through `ctx.db`, in the invocation's transaction. */
export interface ServedSite {
	/** A query and an export read only, in a `READ ONLY` transaction; a mutation also writes. */
	readonly kind: DataKind
	readonly declaration: SiteDeclaration
}

export type ServedEndpoint =
	| {
		readonly kind: 'procedure'
		readonly row: CredentialedEndpoint
		readonly input: Schema | null
		readonly output: Schema
		readonly handler: (args: { readonly input: Readonly<Record<string, unknown>>; readonly ctx: object; readonly query?: unknown }) => unknown
		readonly facilities: Facilities
		/** An export procedure: its request may only read. */
		readonly readOnly?: true
		/** `ctx.connect`, for an endpoint an import's `usedBy` names. */
		readonly connect?: readonly ImportWire[]
		/** A staged-kit site, which gets `ctx.db`; a handler `implement` bound has none. */
		readonly site?: ServedSite
		/** The origins a staged-kit site's `fetch` reaches while its handler runs; absent for a handler `implement` bound. */
		readonly egress?: readonly string[]
		/** Its buckets and time limit; without them (a generated endpoint) no bucket and the request budget. */
		readonly admission?: ProcedureAdmission
		/** A POST's `query`, parsed from the URL beside the body: its schema and its shape. */
		readonly query?: ProcedureQuery
		/** The webhook whose bindings `ctx.webhooks` creates and removes; absent without `binds`. */
		readonly binds?: BindableWebhook
	}
	/** What an export's consumer vendors, behind the export's own callers. */
	| { readonly kind: 'description'; readonly row: CredentialedEndpoint; readonly description: ExportDescription }
	| { readonly kind: 'spa'; readonly row: CredentialedEndpoint; readonly prefix: string; readonly dir: string; readonly config: BrowserConfig }
	/** An SPA mount's bare prefix (`/admin`): the proxy admitted it under the mount's access; it redirects to `/admin/`. */
	| { readonly kind: 'spa-prefix'; readonly row: EndpointRow; readonly prefix: string }
	/** An SPA anyone opens: anonymous, served without a token. */
	| { readonly kind: 'public-spa'; readonly row: EndpointRow; readonly prefix: string; readonly dir: string; readonly config: BrowserConfig }
	| { readonly kind: 'health'; readonly row: EndpointRow }
	/** The shell of a link mount's share SPA: anonymous, and served with the fragment bootstrap. */
	| { readonly kind: 'link-spa'; readonly row: EndpointRow; readonly prefix: string; readonly dir: string }
	| {
		/** A procedure anyone calls: its handler runs as the endpoint's own workload, holding `actions` only. */
		readonly kind: 'public'
		readonly row: EndpointRow
		readonly input: Schema | null
		readonly output: Schema
		readonly handler: (args: { readonly input: Readonly<Record<string, unknown>>; readonly ctx: object; readonly query?: unknown }) => unknown
		readonly actions: readonly string[]
		readonly query?: ProcedureQuery
		/** The endpoint's key: `ctx.app` mints only what IAM signs for it. */
		readonly credential: WorkloadCredential
		readonly admission: ProcedureAdmission
		readonly site: ServedSite
	}
	/** The framework's own `GET` that issues a public procedure's ALTCHA challenge, behind buckets of its own. */
	| { readonly kind: 'challenge'; readonly row: EndpointRow; readonly issuer: ChallengeIssuer; readonly admission: ProcedureAdmission }
	| {
		readonly kind: 'webhook'
		readonly row: EndpointRow
		readonly webhook: string
		readonly scheme: WebhookScheme
		readonly boundTo: ScopeBinding
		/** How long a delivery's handler runs after the last body byte; its claim's lease outlasts it. */
		readonly timeoutMs: number
		readonly actions: readonly string[]
		readonly input: Schema
		readonly handler: (args: { readonly input: unknown; readonly ctx: object }) => unknown
		/** The webhook's key: its refs carry only what IAM signs for it. */
		readonly credential: WorkloadCredential
		/** A staged-kit webhook's declaration: its delivery runs in one transaction, through `ctx.db`. */
		readonly site?: SiteDeclaration
	}

/** A POST procedure's `http.query`: the schema it is parsed with, and its described shape, which reads the parameters. */
export interface ProcedureQuery {
	readonly schema: Schema
	readonly shape: SchemaShape
}

export interface RuntimeParts {
	readonly table: CompiledEndpointTable
	readonly endpoints: ReadonlyMap<string, ServedEndpoint>
	/** Endpoint id → `requirementDigest` of its row: what the proxy's `X-Fabrika-Endpoint` must name. */
	readonly digests: ReadonlyMap<string, string>
	readonly verifier: TokenVerifier
	/** The token audience: this application's IAM id in this environment, `<app>@<env>`. */
	readonly audience: string
	/** `proxySecretDigest` of the proxy secret every request must carry; `null` where the hop is a service binding. */
	readonly proxySecretDigest: Uint8Array | null
	readonly policy: HeaderPolicy
	readonly database: ContractDatabase | null
	/** Dimensions a table owns, so `in` and `on` must find the object. */
	readonly ownedDimensions: ReadonlySet<string>
	/** Each dimension's containers, nearest first; a grant on one reaches every value inside it. */
	readonly containers: ReadonlyMap<string, readonly string[]>
	readonly assets: SpaAssets | null
	/** IAM's membership operations; `boot` refuses a contract that needs them when the adapter supplies none. */
	readonly membership: IamMembership | null
	/** The framework's own writes (admission buckets, webhook tables); `boot` refuses a webhook or a bucket without them. */
	readonly framework: FrameworkTables | null
	/** This runtime's capability mint, which `boot` alone holds, and the authority its stores are bound to. */
	readonly mint: CapabilityMint
	readonly capabilities: CapabilityAuthority
	/** The mini-ORM of the bound `scoped(tables)` layer; `boot` refuses a site without one. */
	readonly data: DataAccess | null
	/** The contract's file kinds: file fields, file outputs, `ctx.files.put` and `.open`; `null` when it declares none. */
	readonly fileKinds: StoredFileKinds | null
	/** Where a 5xx goes: the server log, and Operations when the application has a DSN. */
	readonly failures: FailureReports
	/** Kicks a contract job under its own key, in the background (`BoundJobs.kick`); it never rejects. */
	readonly kick: (job: string) => Promise<void>
	/** The contract's actions, sorted: what a caller document lists a pattern grant as. */
	readonly actions: readonly string[]
	/** The connections all public procedures of this instance hold at once, at most. */
	readonly publicShare: InFlightShare
	/** Whether the proxy's `X-Fabrika-Client-Ip` is the visitor's, so `ctx.client.ip` reads it. */
	readonly clientVouched: boolean
	/** The environment's signed tokens: verified in each input and query, signed by `ctx.tokens`. */
	readonly tokens: SignedTokens
	/** `ctx.url`: absolute links to the application's own procedures. */
	readonly url: AppUrl
	/** The environment's public origin (`FABRIKA_APP_ORIGIN`), which a Twilio signature covers; `null` where it has none. */
	readonly origin: string | null
}

interface Caller {
	readonly principal: Principal
	/** The principal id a capability is granted to: the token's subject. */
	readonly subject: string
	readonly perms: PermissionEntry[]
	/** The verified token, which IAM resolves the caller from on a membership request. */
	readonly token: string
	/** The mount and chain a share-link token is bound to. */
	readonly link: LinkTokenClaims | null
}

/** The proxy's id of this request (proxy-core's `REQUEST_ID_HEADER`); a delegation grant is bound to it. */
const REQUEST_ID_HEADER = 'X-Request-Id'
/** A binding id is a UUID; anything else names no binding and reaches no query. */
const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Access {
	readonly context: Readonly<Record<string, unknown>>
	readonly input: Readonly<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The media type of a `Content-Type` value, without parameters, lower-cased. */
function mediaType(header: string | null): string | null {
	const type = header?.split(';')[0]?.trim().toLowerCase()
	return type === undefined || type === '' ? null : type
}

function describeRequirement(row: CredentialedEndpoint): string {
	const { requirement } = row
	switch (requirement.kind) {
		case 'member':
			return 'a permission in this application'
		case 'action':
			return `'${requirement.action}' in some scope`
		case 'capabilities':
			return `each of ${Object.values(requirement.capabilities).map((capability) => `'${capability.action}'`).join(', ')} in some scope`
	}
}

export class ContractRuntime {
	readonly #parts: RuntimeParts

	constructor(parts: RuntimeParts) {
		this.#parts = parts
	}

	/**
	 * Every answer of a download endpoint, a denial included, carries the file treatment; every other one the policy.
	 * `exec` keeps a failure's report alive past the response, where the runtime would otherwise end it.
	 */
	async fetch(request: Request, exec?: RequestExecutionContext): Promise<Response> {
		const plan = planEndpoint(this.#parts.table, request.method, rawRequestTarget(request.url).pathname)
		const answer = await this.#answer(request, plan, exec)
		const answered = answer instanceof FileDownload
			? fileResponse(answer)
			: plan.outcome === 'endpoint' && answersFile(plan.endpoint)
			? withFileTreatment(answer)
			: withHeaderPolicy(answer, this.#parts.policy)
		if (plan.outcome !== 'endpoint' || plan.endpoint.cache === undefined) {
			return answered
		}
		const row = plan.endpoint
		return withResponseHeaders(answered, (headers) => applyAnswerCache(headers, row, answered.status))
	}

	async #answer(request: Request, plan: EndpointPlan, exec: RequestExecutionContext | undefined): Promise<Response | FileDownload> {
		let where = 'request'
		try {
			const served = plan.outcome === 'endpoint' ? this.#parts.endpoints.get(plan.endpoint.id) : undefined
			// Before any other answer: a direct dial learns nothing, not even whether its path exists.
			if (served?.kind !== 'health' && !this.#throughProxy(request)) {
				throw new ForbiddenError('This application answers only its proxy')
			}
			if (plan.outcome === 'non-canonical') {
				throw new BadRequestError('The request path is not canonical')
			}
			if (plan.outcome !== 'endpoint' || served === undefined) {
				throw new NotFoundError(`No endpoint serves ${request.method} ${rawRequestTarget(request.url).pathname}`)
			}
			where = served.row.id
			this.#checkEndpoint(served, request)
			switch (served.kind) {
				case 'health':
					return jsonResponse({ status: 'ok' }, 200)
				case 'spa': {
					const caller = await this.#authorize(served.row, request)
					return await this.#spaFile(served, request, caller)
				}
				case 'public-spa':
					return await this.#spaFile(served, request, null)
				case 'spa-prefix':
					return new Response(null, { status: 308, headers: { Location: `${served.prefix}/${new URL(request.url).search}` } })
				case 'link-spa':
					if (rawRequestTarget(request.url).pathname === bootstrapPath(served.prefix)) {
						return bootstrapResponse()
					}
					return await withBootstrap(await this.#asset(served, request), served.prefix)
				case 'procedure':
					return await this.#procedure(served, request, exec)
				case 'public':
					return await this.#public(served, request, exec)
				case 'challenge':
					return await this.#issueChallenge(served, request)
				case 'webhook':
					return await this.#webhook(served, request, plan.params, exec)
				case 'description':
					await this.#authorize(served.row, request)
					await readInput({ row: served.row, input: null }, request)
					return jsonResponse({ result: served.description }, 200)
			}
		} catch (error) {
			const response = errorResponse(error, where)
			if (response.status >= 500) {
				const failure = { endpoint: where, requestId: request.headers.get(REQUEST_ID_HEADER), status: response.status, error }
				const delivery = this.#parts.failures.record(failure)
				exec?.waitUntil(delivery)
			}
			return response
		}
	}

	/**
	 * An SPA mount's files, at `<prefix>/__fabrika-config.json` its browser config (`browser-config.ts`), and at
	 * `<prefix>/__fabrika-me.json` the caller document of the person the mount admitted. A public mount admits no one:
	 * the proxy forwards no token there, so it cannot say whether the visitor is signed in.
	 */
	async #spaFile(
		served: { readonly prefix: string; readonly dir: string; readonly config: BrowserConfig },
		request: Request,
		caller: Caller | null,
	): Promise<Response> {
		const path = rawRequestTarget(request.url).pathname
		if (path === joinPath(served.prefix, BROWSER_CONFIG_FILE)) {
			return jsonResponse(served.config, 200)
		}
		if (path === joinPath(served.prefix, PAGE_CALLER_FILE)) {
			if (caller === null || caller.principal.kind !== 'user') {
				throw new UnauthorizedError('A public page carries no caller')
			}
			return jsonResponse(pageCallerOf(caller.principal, caller.perms, this.#parts.actions), 200)
		}
		return await this.#asset(served, request)
	}

	/** A file of the mount's directory. A source map goes to Operations at build and is never served: it holds the source. */
	async #asset(served: { readonly prefix: string; readonly dir: string }, request: Request): Promise<Response> {
		if (rawRequestTarget(request.url).pathname.endsWith('.map')) {
			throw new NotFoundError('A source map is not served')
		}
		return await this.#assets().serve({ prefix: served.prefix, dir: served.dir }, request)
	}

	/**
	 * The proxy proves it sent the request with the secret of this application environment (ADR-0022 rule 5). The
	 * fixed-size digests are compared in constant time, so neither the length nor a prefix of the secret leaks.
	 */
	#throughProxy(request: Request): boolean {
		const expected = this.#parts.proxySecretDigest
		if (expected === null) {
			return true
		}
		const presented = request.headers.get(PROXY_SECRET_HEADER) ?? ''
		return presented !== '' && timingSafeEqual(proxySecretDigest(presented), expected)
	}

	/**
	 * The proxy names the endpoint it selected and the digest of the rules it applied. Any disagreement with this
	 * version's own selection or rules is a 503, so no request is served under rules the proxy did not apply. A
	 * health endpoint answers a constant and is what the platform's liveness probe dials directly, so it alone may
	 * arrive without the header.
	 */
	#checkEndpoint(served: ServedEndpoint, request: Request): void {
		const header = request.headers.get(ENDPOINT_HEADER)
		if (header === null && served.kind === 'health') {
			return
		}
		const named = header === null ? null : parseEndpointHeader(header)
		if (named === null) {
			throw new ServerFault('endpoint_decision_missing', `'${served.row.id}' was reached without the proxy's endpoint decision`, 503)
		}
		if (named.id !== served.row.id || named.digest !== this.#parts.digests.get(served.row.id)) {
			throw new ServerFault(
				'endpoint_decision_mismatch',
				`the proxy applied '${named.id}' with other rules than this version serves '${served.row.id}' with`,
				503,
			)
		}
	}

	#assets(): SpaAssets {
		const assets = this.#parts.assets
		if (assets === null) {
			throw new ServerFault('facility_unbound', 'no asset server serves the SPA')
		}
		return assets
	}

	/** Token, caller kind, requirement, then admission. */
	async #authorize(row: CredentialedEndpoint, request: Request): Promise<Caller> {
		const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
		if (token === '') {
			throw new UnauthorizedError('This endpoint needs a credential, and the request carries none')
		}
		const verified = await this.#parts.verifier.verify(token, this.#parts.audience)
		if (!verified.ok) {
			if (verified.reason === 'unavailable') {
				throw new ServerFault('key_set_unavailable', 'the IAM key set could not be fetched; nothing was checked', 503)
			}
			throw new UnauthorizedError('The credential does not verify')
		}
		const presented = presentedBy(verified.claims)
		if (presented === 'no_mailbox') {
			throw new UnauthorizedError('The credential names a person without an address')
		}
		if (presented === 'no_caller' || !row.callers.includes(presented.caller)) {
			const caller = presented === 'no_caller' ? 'resource' : presented.caller
			throw new ForbiddenError(`A ${caller} caller cannot call '${row.id}' (callers: ${row.callers.join(', ')})`)
		}
		if (!satisfies(row.requirement, verified.claims.perms)) {
			throw new ForbiddenError(`'${row.id}' needs ${describeRequirement(row)}, and the caller holds none`)
		}
		admit(row, request)
		return {
			principal: presented.principal,
			subject: verified.claims.sub,
			perms: verified.claims.perms,
			token,
			link: verified.claims.link ?? null,
		}
	}

	/**
	 * A staged-kit site runs in one transaction: its statements commit after the handler returned, the output passed
	 * validation and an attachment was encoded, and roll back on a throw, a refused output, a file over its limit or a
	 * cancelled request. So an audited export keeps its log row only when its file goes out. Only after that commit does
	 * `ctx.kick` send its jobs, which the answer neither waits for nor depends on.
	 */
	async #procedure(
		served: Extract<ServedEndpoint, { kind: 'procedure' }>,
		request: Request,
		exec: RequestExecutionContext | undefined,
	): Promise<Response | FileDownload> {
		const caller = await this.#authorize(served.row, request)
		const admission = served.admission ?? DEFAULT_ADMISSION
		await this.#admit(served.row, admission, request, caller.subject)
		const body = await procedureBody(served, request, this.#parts.fileKinds)
		// Signed tokens are verified as the input is parsed; the texts they carry are what the request may redirect to.
		const carried = new Set<string>()
		const fields = this.#parts.tokens.verifyFields(served.row.input, body.multipart === null ? body.input : body.multipart.json, carried)
		const query = this.#verifiedQuery(served.row, served.query, request, carried)
		const frame = new RequestFrame(crypto.randomUUID(), { readOnly: served.readOnly === true, endpoint: served.row.id })
		const work = new FileWork(frame, frame.id)
		const site = served.site
		const invocation = site === undefined ? null : new Invocation(frame, this.#data(), site.kind === 'query' || served.readOnly === true)
		const kicks = kickRecorder(`'${served.row.id}'`, site?.declaration.kicks ?? [])
		let outcome: 'open' | 'committing' = 'open'
		try {
			const input = body.multipart === null
				? fields
				: this.#parts.tokens.verifyFields(served.row.input, await this.#fileInput(served, body.multipart, work), carried)
			// The handler's time starts after the last body byte, so a slow upload does not eat it.
			const signal = handlerSignal(request, admission.timeoutMs)
			let result: unknown
			try {
				result = await runInRequest(frame, async () => {
					const membership = this.#membershipRequest(served.row, caller, request, frame)
					const access = await this.#access(served.row, caller, input, frame, membership)
					const binding = this.#parts.fileKinds?.binding(work)
					const ctx = Object.freeze({
						principal: caller.principal,
						requestId: frame.id,
						signal,
						client: requestClient(request, this.#parts.clientVouched),
						url: this.#parts.url,
						...access.context,
						...this.#facilities(served.facilities, served.row, membership, access.context['target'], {
							credential: caller.token,
							requestId: request.headers.get(REQUEST_ID_HEADER) ?? frame.id,
						}),
						...(served.connect === undefined ? {} : { connect: connectContext(served.connect, frame) }),
						...(site === undefined || invocation === null ? {} : siteContext(served.row, site, invocation, caller.subject, access.context, binding)),
						// An export's consumer reaches its rows only, never the files of their owners.
						...(site === undefined || invocation === null || served.readOnly === true
							? {}
							: { files: this.#files(served.row.id, invocation, site.kind, work) }),
						...(served.binds === undefined || invocation === null
							? {}
							: { webhooks: this.#webhookBindings(served.row.id, served.binds, invocation, caller.subject) }),
						...this.#signing(`'${served.row.id}'`, site?.declaration.signs ?? []),
						kick: kicks.kick,
					})
					const args = { input: access.input, ctx, ...(query === undefined ? {} : { query }) }
					const egress = served.egress
					return egress === undefined
						? await served.handler(args)
						: await runAsSite(`'${served.row.id}'`, egress, async () => await served.handler(args))
				})
			} finally {
				frame.end()
			}
			const answer = await this.#answerOf(served, result, request, work, carried)
			outcome = 'committing'
			await commitAnswer(invocation, signal, answer)
			this.#kickAll(kicks.kicked(), exec)
			return answer
		} finally {
			await invocation?.rollback()
			await body.multipart?.close()
			// Only a known rollback deletes what the request staged; after a commit that may have happened, the sweep decides.
			if (outcome === 'open') {
				await this.#parts.fileKinds?.release(work)
			}
		}
	}

	/** A multipart body's input: its JSON part with every file part staged for `work`, parsed strictly as one input. */
	async #fileInput(
		served: { readonly row: EndpointRow; readonly input: Schema | null },
		multipart: MultipartInput,
		work: FileWork,
	): Promise<Readonly<Record<string, unknown>>> {
		const files = await multipart.files(work)
		if (served.input === null) {
			throw new ServerFault('contract_inconsistent', `'${served.row.id}' takes files and declares no input`)
		}
		return strictInput(served.row, served.input, { ...multipart.json, ...files })
	}

	/**
	 * The output as JSON, projected and validated whole; an attachment's file, whose rows are projected, validated and
	 * encoded one at a time, so a result over a limit stops before it is copied; or the stored file the handler answered.
	 */
	async #answerOf(
		served: Extract<ServedEndpoint, { kind: 'procedure' }>,
		result: unknown,
		request: Request,
		work: FileWork,
		carried: ReadonlySet<string>,
	): Promise<Response | FileDownload> {
		const output = served.row.output
		if (output !== null && isFileShape(output)) {
			return await this.#fileKinds(served.row.id).download(work, served.row.id, output.kind, result)
		}
		const file = output !== null && isAttachmentShape(output) ? output : null
		if (file !== null) {
			return attachmentResponse(served.row.id, file, served.output, result)
		}
		return outputResponse(served.row, served.output, result, request, carried)
	}

	/** A POST's `query`, parsed from the URL, each signed token in it verified; `undefined` without one. */
	#verifiedQuery(
		row: EndpointRow,
		query: ProcedureQuery | undefined,
		request: Request,
		carried: Set<string>,
	): Readonly<Record<string, unknown>> | undefined {
		const read = readQuery(row, query?.schema, query?.shape, request)
		return read === undefined ? undefined : this.#parts.tokens.verifyFields(query?.shape ?? null, read, carried)
	}

	/** `ctx.tokens` of a site that declares `signs`; nothing for one that declares none, whose type has no such member. */
	#signing(site: string, signs: readonly string[]): { readonly tokens?: object } {
		return signs.length === 0 ? {} : { tokens: this.#parts.tokens.context(site, signs) }
	}

	#fileKinds(endpoint: string): StoredFileKinds {
		const kinds = this.#parts.fileKinds
		if (kinds === null) {
			throw new ServerFault('facility_unbound', `'${endpoint}' takes or answers a file, and boot bound no file kinds`)
		}
		return kinds
	}

	/** `ctx.webhooks` of a procedure that declares `binds`: its bindings are written in the invocation's transaction. */
	#webhookBindings(endpoint: string, webhook: BindableWebhook, invocation: Invocation, principal: string): (name: string) => object {
		return webhookBindings({
			site: `'${endpoint}'`,
			webhook,
			tables: () => this.#framework().webhooks,
			authority: this.#parts.capabilities,
			...invocation.frameworkSite('ctx.webhooks'),
			principal,
		})
	}

	/** `ctx.files` of a staged-kit site: `put` and `open` of the stored files, bound to the invocation and the request's work. */
	#files(endpoint: string, invocation: Invocation, kind: DataKind, work: FileWork): object {
		return storedFilesHandle(this.#parts.fileKinds, work, { where: `'${endpoint}'`, check: invocation.fileCheck(), writes: kind !== 'query' })
	}

	#data(): DataAccess {
		const data = this.#parts.data
		if (data === null) {
			throw new ServerFault('facility_unbound', 'a site reaches data through ctx.db, and boot bound no @fabrika/db layer')
		}
		return data
	}

	/** The caller's authority at IAM for this request, when the endpoint's access form names a dimension and an action. */
	#membershipRequest(row: CredentialedEndpoint, caller: Caller, request: Request, frame: RequestFrame): MembershipRequest | null {
		const iam = this.#parts.membership
		if (iam === null || row.requirement.kind !== 'action' || row.requirement.access.form === 'app') {
			return null
		}
		return {
			iam,
			caller: { credential: caller.token, requestId: request.headers.get(REQUEST_ID_HEADER) ?? frame.id },
			delegation: request.headers.get(DELEGATION_HEADER),
			dimension: row.requirement.access.dimension,
			action: row.requirement.action,
			capabilities: this.#parts.capabilities,
		}
	}

	/** `ctx.members` and `ctx.links`, for exactly the endpoints the artifact gives them. */
	#facilities(
		facilities: Facilities,
		row: CredentialedEndpoint,
		membership: MembershipRequest | null,
		target: unknown,
		caller: MembershipRequestCaller,
	): Readonly<Record<string, unknown>> {
		if (facilities.members === 'application') {
			return { members: applicationDirectory(this.#parts.membership, caller, row.id) }
		}
		const reads = facilities.members === null || facilities.members === 'manage' || row.requirement.kind !== 'action' ? null : facilities.members
		const directory = reads === null ? {} : { members: memberDirectory(membership, target, { endpoint: row.id, ...reads }) }
		if (facilities.members !== 'manage' && facilities.links.length === 0) {
			return directory
		}
		if (membership === null) {
			throw new ServerFault('facility_unbound', `'${row.id}' manages members or links, and boot bound no IAM membership transport`)
		}
		const members = facilities.members === 'manage' ? { members: memberManagement(membership) } : directory
		const links = facilities.links.length === 0
			? {}
			: { links: linkIssuing(membership, facilities.links, this.#parts.containers.get(membership.dimension) ?? []) }
		return { ...members, ...links }
	}

	async #access(
		row: CredentialedEndpoint,
		caller: Caller,
		input: Readonly<Record<string, unknown>>,
		frame: RequestFrame,
		membership: MembershipRequest | null,
	): Promise<Access> {
		if (row.requirement.kind === 'member') {
			return { context: {}, input }
		}
		if (row.requirement.kind === 'capabilities') {
			return await this.#capabilities(row.requirement, caller, input, frame)
		}
		const { action, access } = row.requirement
		switch (access.form) {
			case 'over':
				return { context: { within: this.#within(caller, action, access.dimension, frame) }, input }
			case 'in': {
				const { value, rest } = takeField(input, access.from)
				return { context: { target: await this.#inRef(caller, action, access.dimension, value, frame) }, input: rest }
			}
			case 'on': {
				if (access.from === null) {
					return await this.#linkTarget(row, caller, action, access.dimension, input, frame)
				}
				const { value, rest } = takeField(input, access.from)
				return { context: { target: await this.#onRef(caller, action, access.dimension, value, frame) }, input: rest }
			}
			case 'creates': {
				if (membership === null) {
					throw new ServerFault('facility_unbound', `'${row.id}' creates a scope, and boot bound no IAM membership transport`)
				}
				const value = await createScope(membership)
				return { context: { created: this.#parts.mint.ref(frame, access.dimension, action, caller.subject, value, new Map()) }, input }
			}
			case 'app': {
				// `#authorize` ran `satisfies`, which the app form meets only with a global grant of the action.
				return { context: { app: this.#parts.mint.app(frame, action, caller.subject) }, input }
			}
		}
	}

	/** The values of `dimension` in which the caller holds `action`, directly or through a container; all for a global grant. */
	#within(caller: Caller, action: string, dimension: string, frame: RequestFrame): Within<string, string> {
		const direct = scopedValues(caller.perms, action, dimension)
		if (direct === null) {
			return this.#parts.mint.within(frame, dimension, action, caller.subject, 'all')
		}
		const held = this.#heldContainers(caller.perms, action, dimension)
		if (direct.length === 0 && held.length === 0) {
			throw new ForbiddenError(`The caller holds '${action}' in no ${dimension}`)
		}
		return this.#parts.mint.within(frame, dimension, action, caller.subject, direct, held)
	}

	/** A scope value the caller acts in: without a grant on it or on a container of it, 403 whether it exists or not. */
	async #inRef(caller: Caller, action: string, dimension: string, value: string, frame: RequestFrame): Promise<Ref<string, string>> {
		const direct = permits(caller.perms, action, { type: dimension, value })
		if (!direct && this.#heldContainers(caller.perms, action, dimension).length === 0) {
			throw new ForbiddenError(`The caller does not hold '${action}' in this ${dimension}`)
		}
		const chain = await this.#chain(dimension, value)
		if (!holdsOnChain(caller.perms, action, dimension, value, chain ?? new Map())) {
			throw new ForbiddenError(`The caller does not hold '${action}' in this ${dimension}`)
		}
		if (chain === null) {
			throw new NotFoundError('Not found')
		}
		return this.#parts.mint.ref(frame, dimension, action, caller.subject, value, chain)
	}

	/** An object the caller acts on; one it may not act on is indistinguishable from a missing one. */
	async #onRef(caller: Caller, action: string, dimension: string, value: string, frame: RequestFrame): Promise<Ref<string, string>> {
		const chain = await this.#chain(dimension, value)
		if (chain === null || !holdsOnChain(caller.perms, action, dimension, value, chain)) {
			throw new NotFoundError('Not found')
		}
		return this.#parts.mint.ref(frame, dimension, action, caller.subject, value, chain)
	}

	/**
	 * Several capabilities, each minted as its single access form mints it, in their declared order, so the first one
	 * refused answers. Each reads its value from the input as the caller sent it; the fields they read are removed after.
	 */
	async #capabilities(
		requirement: CapabilitiesRequirement,
		caller: Caller,
		input: Readonly<Record<string, unknown>>,
		frame: RequestFrame,
	): Promise<Access> {
		const minted: Record<string, unknown> = {}
		const read = new Set<string>()
		for (const [name, { action, access }] of Object.entries(requirement.capabilities)) {
			if (access.form === 'over') {
				minted[name] = this.#within(caller, action, access.dimension, frame)
				continue
			}
			const { value } = takeField(input, access.from)
			read.add(access.from)
			minted[name] = access.form === 'in'
				? await this.#inRef(caller, action, access.dimension, value, frame)
				: await this.#onRef(caller, action, access.dimension, value, frame)
		}
		const rest = Object.freeze(Object.fromEntries(Object.entries(input).filter(([field]) => !read.has(field))))
		return { context: { capabilities: Object.freeze(minted) }, input: rest }
	}

	/**
	 * A link procedure acts on the object its key is bound to. The key's mount must be this endpoint's, and the chain
	 * it was issued for must still be where the object lies: a link for a note moved since stops working.
	 */
	async #linkTarget(
		row: CredentialedEndpoint,
		caller: Caller,
		action: string,
		dimension: string,
		input: Readonly<Record<string, unknown>>,
		frame: RequestFrame,
	): Promise<Access> {
		const link = caller.link
		if (link === null || link.mount !== row.source.name) {
			throw new ForbiddenError(`'${row.id}' admits only a key of the link mount '${row.source.name}'`)
		}
		const [object, ...containers] = link.chain
		if (object === undefined || object.type !== dimension || !permits(caller.perms, action, object)) {
			throw new ForbiddenError(`The link does not grant '${action}' on a ${dimension}`)
		}
		const chain = await this.#chain(dimension, object.value)
		const unchanged = chain !== null && chain.size === containers.length && containers.every((scope) => chain.get(scope.type) === scope.value)
		if (chain === null || !unchanged) {
			throw new NotFoundError('This link no longer reaches its object')
		}
		return { context: { target: this.#parts.mint.ref(frame, dimension, action, caller.subject, object.value, chain) }, input }
	}

	/**
	 * The token verifies for this host and this action, and was not accepted before unless it is the `repeatable` one: a
	 * failure is 400, as a 0.5 form answered, an unreachable provider 503.
	 */
	async #challenge(action: string, verifier: ChallengeVerifier, token: string | null, request: Request, repeatable: string | null): Promise<void> {
		const verdict = token === null ? null : await verifier.verify({ token, hostname: new URL(request.url).hostname, action })
		if (verdict?.outcome === 'unavailable') {
			throw new ServerFault('challenge_unavailable', `the ${verifier.provider} challenge of '${action}' could not be verified`, 503)
		}
		if (verdict?.outcome === 'misconfigured') {
			throw new ServerFault('challenge_misconfigured', `the ${verifier.provider} challenge of '${action}' refused the application's secret`, 503)
		}
		const refused = verdict?.outcome !== 'passed'
			|| (token !== repeatable
				&& !(await this.#framework().admissions.recordChallenge(action, sha256Hex(verdict.replayKey), verdict.recordMs)))
		if (refused) {
			throw new HttpError(400, 'challenge_failed', 'The challenge did not verify; solve it again')
		}
	}

	/**
	 * A public procedure, in the order of ADR-0063's public request: the in-flight share (503), then every bucket in the
	 * order of `bucketsOf` (429), each charged before the body is read and kept whatever follows; the bounded body and the
	 * strict input (413, 400); the workload token, before a challenge spends its token (503); the challenge (400); then
	 * the handler in one transaction, the output and the commit. The handler's time starts after the last body byte.
	 */
	async #public(
		served: Extract<ServedEndpoint, { kind: 'public' }>,
		request: Request,
		exec: RequestExecutionContext | undefined,
	): Promise<Response | FileDownload> {
		admitContentType(served.row, request)
		const release = this.#parts.publicShare.enter()
		if (release === null) {
			throw new HttpError(503, 'public_share_full', 'Too many anonymous requests at once; try again shortly')
		}
		let multipart: MultipartInput | null = null
		try {
			const { admission } = served
			await this.#admit(served.row, admission, request, null)
			const body = await procedureBody({ row: served.row, input: served.input }, request, this.#parts.fileKinds)
			multipart = body.multipart
			// Signed tokens are verified as the input is parsed, before the workload token and the challenge.
			const carried = new Set<string>()
			const fields = this.#parts.tokens.verifyFields(served.row.input, body.multipart === null ? body.input : body.multipart.json, carried)
			const query = this.#verifiedQuery(served.row, served.query, request, carried)
			const authority = await served.credential.authority()
			if (!authority.ok) {
				throw new ServerFault('workload_unauthorized', `the key of public procedure '${served.row.id}' gives it no authority: ${authority.reason}`, 503)
			}
			if (admission.challenge !== null) {
				const token = fields[CHALLENGE_FIELD]
				await this.#challenge(
					admission.challenge.action,
					admission.challenge.verifier,
					typeof token === 'string' ? token : null,
					request,
					admission.repeatableToken,
				)
			}
			return await this.#publicInvocation(served, request, body, fields, query, carried, authority.perms, exec)
		} finally {
			await multipart?.close()
			release()
		}
	}

	/**
	 * A fresh ALTCHA challenge for this host: within the anonymous share and after the endpoint's buckets, as a public
	 * procedure is admitted. It reads no body and writes nothing but the buckets.
	 */
	async #issueChallenge(served: Extract<ServedEndpoint, { kind: 'challenge' }>, request: Request): Promise<Response> {
		const release = this.#parts.publicShare.enter()
		if (release === null) {
			throw new HttpError(503, 'public_share_full', 'Too many anonymous requests at once; try again shortly')
		}
		try {
			await this.#admit(served.row, served.admission, request, null)
			return jsonResponse(await served.issuer.issue(new URL(request.url).hostname), 200)
		} finally {
			release()
		}
	}

	/**
	 * Sends each job once, after the commit: in the background, never awaited and never rejecting. Without an execution
	 * context a kick runs detached.
	 */
	#kickAll(jobs: readonly string[], exec: RequestExecutionContext | undefined): void {
		for (const job of new Set(jobs)) {
			const kicked = this.#parts.kick(job)
			exec?.waitUntil(kicked)
		}
	}

	/**
	 * Takes one from each bucket of the endpoint, in order, before the body is read; a full one is a 429, and a take
	 * stays taken whatever the request does next. `caller` is the principal a `perCaller` bucket counts. A
	 * `bytesPerHour` budget is charged the body's declared length, at most the endpoint's body limit, or that limit when
	 * the body declares none.
	 */
	async #admit(row: EndpointRow, admission: ProcedureAdmission, request: Request, caller: string | null): Promise<void> {
		const endpoint = row.id
		for (const { bucket, limit } of bucketsOf(admission.rate, request, caller)) {
			if (!(await this.#framework().admissions.take(endpoint, bucket, limit))) {
				throw new HttpError(429, 'rate_limited', `'${endpoint}' admits no more calls this minute; try again later`)
			}
		}
		const bytesPerHour = admission.rate.bytesPerHour
		if (bytesPerHour === null) {
			return
		}
		const declared = Number(request.headers.get('Content-Length') ?? '')
		const charged = Math.min(Number.isSafeInteger(declared) && declared > 0 ? declared : maxBytesOf(row), maxBytesOf(row))
		if (charged > 0 && !(await this.#framework().admissions.reserveBytes(endpoint, charged, bytesPerHour))) {
			throw new HttpError(429, 'rate_limited', `'${endpoint}' admits no more bytes this hour; try again later`)
		}
	}

	async #publicInvocation(
		served: Extract<ServedEndpoint, { kind: 'public' }>,
		request: Request,
		body: Awaited<ReturnType<typeof procedureBody>>,
		fields: Readonly<Record<string, unknown>>,
		query: Readonly<Record<string, unknown>> | undefined,
		carried: Set<string>,
		perms: readonly PermissionEntry[],
		exec: RequestExecutionContext | undefined,
	): Promise<Response | FileDownload> {
		const kicks = kickRecorder(`'${served.row.id}'`, served.site.declaration.kicks)
		const frame = new RequestFrame(crypto.randomUUID(), { readOnly: served.site.kind === 'query', endpoint: served.row.id })
		const work = new FileWork(frame, frame.id)
		const invocation = new Invocation(frame, this.#data(), served.site.kind === 'query')
		const subject = publicSubject(served.row.id)
		const app = (action: string): AppCapability<string> => {
			if (frame.ended) {
				throw new CapabilityRefusedError('ended', `request ${frame.id} has ended; it mints no capability`)
			}
			if (!served.actions.includes(action)) {
				throw new CapabilityRefusedError('undeclared_action', `public procedure '${served.row.id}' does not declare this action`)
			}
			if (!permits([...perms], action)) {
				throw new CapabilityRefusedError('undeclared_action', `the token IAM signed for the key of '${served.row.id}' does not carry this action`)
			}
			return this.#parts.mint.app(frame, action, subject)
		}
		let outcome: 'open' | 'committing' = 'open'
		try {
			// The file parts come after the challenge, so a refused visitor stores nothing.
			const input = body.multipart === null
				? fields
				: this.#parts.tokens.verifyFields(served.row.input, await this.#fileInput(served, body.multipart, work), carried)
			// The handler's time starts after the last body byte, so a slow upload does not eat it.
			const signal = handlerSignal(request, served.admission.timeoutMs)
			let result: unknown
			try {
				result = await runInRequest(frame, async () => {
					const handles = invocation.handles(
						served.site.kind,
						served.site.declaration,
						subject,
						{ carried },
						this.#parts.fileKinds?.binding(work),
					)
					const where = `'${served.row.id}'`
					const ctx = Object.freeze({
						principal: Object.freeze({ kind: 'public', endpoint: served.row.id }),
						requestId: frame.id,
						signal,
						client: requestClient(request, this.#parts.clientVouched),
						url: this.#parts.url,
						app,
						db: Object.freeze({ app: (action: string) => handles.app(app(action)) }),
						...this.#signing(`'${served.row.id}'`, served.site.declaration.signs),
						files: storedFilesHandle(this.#parts.fileKinds, work, {
							where,
							check: boundTo(frame, () => false, 'ctx.files'),
							writes: served.site.kind !== 'query',
						}),
						kick: kicks.kick,
					})
					const args = { input, ctx, ...(query === undefined ? {} : { query }) }
					return await runAsSite(`'${served.row.id}'`, served.site.declaration.egress, async () => await served.handler(args))
				})
			} finally {
				frame.end()
			}
			const output = served.row.output
			const answer = output !== null && isFileShape(output)
				? await this.#fileKinds(served.row.id).download(work, served.row.id, output.kind, result)
				: outputResponse(served.row, served.output, result, request, carried)
			outcome = 'committing'
			await commitAnswer(invocation, signal, answer)
			this.#kickAll(kicks.kicked(), exec)
			return answer
		} finally {
			await invocation.rollback()
			if (outcome === 'open') {
				await this.#parts.fileKinds?.release(work)
			}
		}
	}

	/**
	 * A webhook delivery, in order: the binding the path names, the signature over the raw body with that binding's
	 * secret, the account a GitHub payload names, the input, then the delivery key — the hash of the binding and the
	 * signed body, so a replay is ignored whatever its unsigned headers say. The handler gets a `Ref` of the bound
	 * value for each declared action, or mints application-wide ones when the webhook is bound to `'app'`, and the
	 * key; it runs at least once: a failed run is forgotten and redelivered.
	 */
	async #webhook(
		served: Extract<ServedEndpoint, { kind: 'webhook' }>,
		request: Request,
		params: Readonly<Record<string, string>>,
		exec: RequestExecutionContext | undefined,
	): Promise<Response> {
		admitContentType(served.row, request)
		const limit = maxBytesOf(served.row)
		const body = await readBoundedBody(request, limit, AbortSignal.timeout(bodyDeadlineMs(limit)))
		const tables = this.#framework().webhooks
		const bindingId = params[WEBHOOK_BINDING_PARAMETER] ?? ''
		const binding = BINDING_ID.test(bindingId) ? await tables.binding(served.webhook, bindingId) : null
		if (binding === null) {
			throw new NotFoundError('Not found')
		}
		if (served.scheme === 'twilio' && this.#parts.origin === null) {
			throw new ServerFault(
				'webhook_unverifiable',
				`webhook '${served.webhook}' checks Twilio's signature over its public URL, and the environment has no FABRIKA_APP_ORIGIN`,
			)
		}
		const target = rawRequestTarget(request.url)
		const url = this.#parts.origin === null ? null : `${this.#parts.origin}${target.pathname}${target.search}`
		if (!(await verifyDelivery(served.scheme, { headers: request.headers, body, url }, binding.secret, Date.now()))) {
			throw new UnauthorizedError('The delivery signature does not verify with this binding')
		}
		const payload = mediaType(request.headers.get('Content-Type')) === FORM_URLENCODED_TYPE
			? paramsObject(new URLSearchParams(utf8Body(body)), served.row.input)
			: parseJson(body)
		// Slack confirms a new events URL by asking it to echo a challenge, signed like every delivery; no handler runs.
		const challenge = served.scheme === 'slack' ? slackChallenge(payload) : null
		if (challenge !== null) {
			return jsonResponse({ challenge }, 200)
		}
		// Only GitHub names the account in its payload; another provider's binding is its own secret.
		if (served.scheme === 'github-sha256' && !githubAccounts(payload).includes(binding.account)) {
			throw new ForbiddenError('The delivery names another account than its binding accepts')
		}
		const input = strictInput(served.row, served.input, stripped(served, payload))
		const bound = served.boundTo.kind === 'app' ? APP_BINDING_SCOPE.type : served.boundTo.dimension
		if (binding.scope.type !== bound) {
			throw new ServerFault(
				'webhook_binding_mismatch',
				`binding '${binding.id}' reaches a '${binding.scope.type}', and '${served.webhook}' is bound to '${bound}'`,
			)
		}
		const chain = served.boundTo.kind === 'app' ? new Map<string, string>() : await this.#chain(binding.scope.type, binding.scope.value)
		if (chain === null) {
			throw new NotFoundError('The bound value no longer exists')
		}
		// Asked before the delivery is claimed: a delivery that cannot run is one the provider must redeliver.
		const authority = await served.credential.authority()
		if (!authority.ok) {
			throw new ServerFault('workload_unauthorized', `the key of webhook '${served.webhook}' gives it no authority: ${authority.reason}`, 503)
		}
		const unheld = served.actions.find((action) => !permits([...authority.perms], action))
		if (unheld !== undefined) {
			throw new ServerFault('workload_unauthorized', `the token IAM signed for the key of webhook '${served.webhook}' does not carry '${unheld}'`, 503)
		}
		const key = await deliveryKey(binding.id, body)
		const budgetMs = served.timeoutMs
		const now = Date.now()
		const claim = await tables.claimDelivery(binding.id, key, now, budgetMs + WEBHOOK_CLAIM_GRACE_MS, now - WEBHOOK_REPLAY_RETENTION_MS)
		if (claim === null) {
			return jsonResponse({ result: { received: true } }, 200)
		}
		const frame = new RequestFrame(crypto.randomUUID())
		const work = new FileWork(frame, frame.id)
		const site = served.site
		// The claim stays outside the delivery's transaction, and its completion commits inside it, with the work.
		const invocation = site === undefined ? null : new Invocation(frame, this.#data(), false)
		const kicks = kickRecorder(`webhook '${served.webhook}'`, site?.kicks ?? [])
		const signal = handlerSignal(request, budgetMs)
		let committing = false
		try {
			try {
				await runInRequest(frame, async () => {
					const subject = webhookSubject(binding.id)
					const reach = this.#webhookReach(served, frame, subject, binding.scope.value, chain)
					const principal: WebhookPrincipal = Object.freeze({ kind: 'webhook', bindingId: binding.id })
					const delivery = Object.freeze({ key })
					const handles = site === undefined || invocation === null
						? null
						: invocation.handles('mutation', site, subject, 'declared', this.#parts.fileKinds?.binding(work))
					const data = site === undefined || invocation === null || handles === null
						? {}
						: {
							db: siteData(handles, (action) => handles.app(reach.app(action))),
							sql: site.sql === null ? undeclaredSql(served.row.id, 'mutation') : invocation.sql(site.sql),
						}
					const client = requestClient(request, this.#parts.clientVouched)
					const args = {
						input,
						ctx: Object.freeze({
							principal,
							requestId: frame.id,
							signal,
							client,
							url: this.#parts.url,
							...reach.context,
							delivery,
							files: storedFilesHandle(this.#parts.fileKinds, work, {
								where: `webhook '${served.webhook}'`,
								check: boundTo(frame, () => false, 'ctx.files'),
								writes: true,
							}),
							...this.#signing(`webhook '${served.webhook}'`, site?.signs ?? []),
							kick: kicks.kick,
							...data,
						}),
					}
					if (site === undefined) {
						await served.handler(args)
					} else {
						await runAsSite(`webhook '${served.webhook}'`, site.egress, async () => await served.handler(args))
					}
				})
			} finally {
				frame.end()
			}
			const using = invocation === null ? undefined : await invocation.frameworkSite('the delivery claim').session()
			if (!(await tables.completeDelivery(claim, using))) {
				throw new ServerFault('webhook_claim_lost', `the claim of a delivery to '${served.webhook}' expired and another copy took it over`)
			}
			committing = true
			await invocation?.commit(signal)
			this.#kickAll(kicks.kicked(), exec)
		} catch (error) {
			await invocation?.rollback()
			// Only a known rollback deletes what the delivery staged; after a commit that may have happened, the sweep decides.
			if (!committing) {
				await this.#parts.fileKinds?.release(work)
			}
			// The provider redelivers a failed delivery; giving the claim back lets the redelivery run at once. The unsigned
			// delivery header is the caller's word, so the log names only the endpoint.
			console.error(`fabrika: ${served.row.id}: delivery_failed; the provider's redelivery runs it again`)
			await tables.releaseDelivery(claim)
			throw error
		}
		return jsonResponse({ result: { received: true } }, 200)
	}

	/**
	 * What a delivery's handler acts with: a `Ref` of the bound value for each declared action, or, for a webhook bound to
	 * `'app'`, `ctx.app(<action>)`, which mints a declared action the webhook's token carries; `ctx.db.app` binds its
	 * handles to what `app` mints, and a webhook bound to a dimension refuses both.
	 */
	#webhookReach(
		served: Extract<ServedEndpoint, { kind: 'webhook' }>,
		frame: RequestFrame,
		subject: string,
		value: string,
		chain: ReadonlyMap<string, string>,
	): { readonly context: Readonly<Record<string, unknown>>; readonly app: (action: string) => AppCapability<string> } {
		const boundTo = served.boundTo
		if (boundTo.kind === 'dimension') {
			const refs = Object.freeze(
				Object.fromEntries(served.actions.map((action) => [action, this.#parts.mint.ref(frame, boundTo.dimension, action, subject, value, chain)])),
			)
			const app = boundWebhookApp(served.webhook)
			return { context: { refs, app }, app }
		}
		// The delivery checked once that the token carries every declared action, before it was recorded.
		const app = (action: string): AppCapability<string> => {
			if (frame.ended) {
				throw new CapabilityRefusedError('ended', `delivery ${frame.id} has ended; it mints no capability`)
			}
			if (!served.actions.includes(action)) {
				throw new CapabilityRefusedError('undeclared_action', `webhook '${served.webhook}' does not declare this action`)
			}
			return this.#parts.mint.app(frame, action, subject)
		}
		return { context: { app }, app }
	}

	#framework(): FrameworkTables {
		const framework = this.#parts.framework
		if (framework === null) {
			throw new ServerFault('facility_unbound', 'no data layer serves the framework tables')
		}
		return framework
	}

	/** The object's containers, read now, so a Ref carries where it lies today; `null` for a missing object a table owns. */
	async #chain(dimension: string, value: string): Promise<ReadonlyMap<string, string> | null> {
		const database = this.#parts.database
		if (database === null || !this.#parts.ownedDimensions.has(dimension)) {
			return new Map()
		}
		return await database.locate(dimension, value)
	}

	/** The container values of `dimension` in which the caller holds `action`. */
	#heldContainers(perms: PermissionEntry[], action: string, dimension: string): ContainerGrant[] {
		return (this.#parts.containers.get(dimension) ?? []).flatMap((container) => {
			const values = scopedValues(perms, action, container) ?? []
			return values.length === 0 ? [] : [{ dimension: container, values }]
		})
	}
}

/** `ctx.db` (by the access form) and `ctx.sql` of a staged-kit endpoint: the declared tag, or one that refuses. */
function siteContext(
	row: CredentialedEndpoint,
	site: ServedSite,
	invocation: Invocation,
	principal: string,
	access: Readonly<Record<string, unknown>>,
	files: FileBinding | undefined,
): Readonly<Record<string, unknown>> {
	const form = row.requirement.kind === 'member' ? 'member' : row.requirement.kind === 'capabilities' ? 'capabilities' : row.requirement.access.form
	const db = endpointData(invocation.handles(site.kind, site.declaration, principal, 'declared', files), form, {
		target: access['target'],
		within: access['within'],
		created: access['created'],
		app: access['app'],
	})
	return { db, sql: site.declaration.sql === null ? undeclaredSql(row.id, site.kind) : invocation.sql(site.declaration.sql) }
}

/** Whether the caller holds `action` on the value or on any container of its chain; IAM evaluates each as a flat scope. */
function holdsOnChain(perms: PermissionEntry[], action: string, dimension: string, value: string, chain: ReadonlyMap<string, string>): boolean {
	const scopes: (readonly [string, string])[] = [[dimension, value], ...chain]
	return scopes.some(([type, scope]) => permits(perms, action, { type, value: scope }))
}

/**
 * The output, projected and validated whole: JSON, or a redirect to its validated target. `carried` are the texts the
 * request's verified tokens carry: a URL among them is a target the application signed.
 */
function outputResponse(row: EndpointRow, schema: Schema, result: unknown, request: Request, carried: ReadonlySet<string>): Response {
	const output = z.safeParse(schema, projectSchema(row.id, schema, result))
	if (!output.success) {
		throw new ServerFault('output_refused', `'${row.id}' returned a value its output schema refuses`)
	}
	if (row.output !== null && isRedirectShape(row.output)) {
		return redirectResponse(row, row.output, output.data, request, carried)
	}
	return jsonResponse({ result: output.data }, 200)
}

function projectSchema(endpoint: string, output: Schema, result: unknown): unknown {
	try {
		return project(output, result)
	} catch (error) {
		if (error instanceof ProjectionRefusedError) {
			throw new ServerFault('output_refused', `'${endpoint}' returned a value no branch of its output union accepts`)
		}
		throw error
	}
}

/** The principal a public procedure's capabilities are granted to: its workload, never a visitor. */
function publicSubject(endpoint: string): string {
	return `public:${endpoint}`
}

/**
 * Admission. A request that carries no `Authorization` header is authenticated by the session cookie the proxy
 * redeemed; when it is not a `GET`, it must come from this origin. A cross-site page cannot add the header: it is
 * not CORS-safelisted, and the application answers no preflight.
 */
function admit(row: CredentialedEndpoint, request: Request): void {
	if (request.method !== 'GET' && !request.headers.has('Authorization') && request.headers.get('Sec-Fetch-Site') !== 'same-origin') {
		throw new HttpError(403, 'admission', 'A session request that is not a GET must be same-origin (Sec-Fetch-Site: same-origin)')
	}
	admitContentType(row, request)
}

/** What one part adds to a multipart body beside its bytes: its delimiter and its headers, at most. */
const MULTIPART_PART_OVERHEAD = PROCEDURE_LIMITS.maxPartHeaderBytes + 128

/**
 * What a failed multipart submission answers: a body that broke the format 400, one that did not arrive in time 408,
 * and otherwise the failure itself, whichever step met the broken stream first.
 */
function multipartFailure(error: unknown, parts: MultipartReader, deadline: AbortSignal, request: Request): unknown {
	if (isStructuralError(error) && error.httpStatus < 500) {
		return error
	}
	if (request.signal.aborted) {
		return abortedBody()
	}
	if (deadline.aborted) {
		return new HttpError(408, 'timeout', 'The submission did not arrive in time')
	}
	const broken = error instanceof MultipartError ? error : parts.failure()
	if (broken?.reason === 'interrupted') {
		return abortedBody()
	}
	if (broken !== null) {
		return new HttpError(400, 'multipart', `The body is not the multipart/form-data the form reads: ${broken.message}`)
	}
	return error
}

/** The content types an endpoint admits; an anonymous endpoint has no session, so this is its whole admission. */
function admitContentType(row: EndpointRow, request: Request): void {
	if (row.admission !== null) {
		const type = mediaType(request.headers.get('Content-Type'))
		if (type === null || !row.admission.contentTypes.includes(type)) {
			throw new HttpError(400, 'admission', `'${row.id}' admits Content-Type ${row.admission.contentTypes.join(' or ')}`)
		}
	}
}

/** An anonymous endpoint's body limit: the framework's, because the proxy never sees the body. */
function maxBytesOf(row: EndpointRow): number {
	const limit = row.admission?.maxBytes
	if (limit === null || limit === undefined) {
		throw new ServerFault('contract_inconsistent', `'${row.id}' declares no body limit`)
	}
	return limit
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(utf8Body(body))
	} catch {
		throw new BadRequestError('The body is not JSON')
	}
}

function utf8Body(body: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(body)
	} catch {
		throw new BadRequestError('The body is not UTF-8')
	}
}

/** The challenge of Slack's `url_verification` request, which the URL answers as `{ challenge }`; `null` for any other. */
function slackChallenge(payload: unknown): string | null {
	if (!isRecord(payload) || payload['type'] !== 'url_verification') {
		return null
	}
	const challenge = payload['challenge']
	return typeof challenge === 'string' ? challenge : null
}

/** A webhook input keeps only the fields it declares: a provider sends many more, and none reaches the handler. */
function stripped(served: Extract<ServedEndpoint, { kind: 'webhook' }>, payload: unknown): unknown {
	try {
		return project(served.input, payload)
	} catch (error) {
		if (error instanceof ProjectionRefusedError) {
			throw new BadRequestError(`'${served.row.id}': the delivery matches no branch of the declared input`)
		}
		throw error
	}
}

/** `value` parsed with the endpoint's strict input schema; a refusal is a 400 naming each issue. */
function strictInput(row: EndpointRow, schema: Schema, value: unknown): Readonly<Record<string, unknown>> {
	const parsed = z.safeParse(schema, value)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message }))
		const first = issues[0]
		throw new HttpError(400, 'validation', first === undefined ? 'Invalid input' : `${first.path || 'input'}: ${first.message}`, { issues })
	}
	if (!isRecord(parsed.data)) {
		throw new BadRequestError(`'${row.id}': the input is not an object`)
	}
	const unstorable = nulAt(parsed.data, [])
	if (unstorable !== null) {
		const path = unstorable.join('.')
		throw new HttpError(400, 'validation', `${path || 'input'}: a string may not contain U+0000`, {
			issues: [{ path, code: 'invalid_format', message: 'a string may not contain U+0000' }],
		})
	}
	return parsed.data
}

/**
 * The path of the first string, or record key, holding U+0000. Postgres `text` cannot store one, so a value the schema
 * admits would otherwise fail its statement as a 500 after the request was admitted.
 */
function nulAt(value: unknown, path: readonly string[]): readonly string[] | null {
	if (typeof value === 'string') {
		return value.includes('\u0000') ? path : null
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const found = nulAt(item, [...path, String(index)])
			if (found !== null) {
				return found
			}
		}
		return null
	}
	if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			const found = key.includes('\u0000') ? [...path, key] : nulAt(item, [...path, key])
			if (found !== null) {
				return found
			}
		}
	}
	return null
}

/** The strictly parsed input; a procedure without input takes an empty body or `{}`. */
/**
 * A procedure's input: a GET's from the URL's flat parameters; a POST's from its body, JSON or a native form's
 * urlencoded fields, within the row's body limit and deadline.
 */
async function readInput(
	served: { readonly row: EndpointRow; readonly input: Schema | null },
	request: Request,
): Promise<Readonly<Record<string, unknown>>> {
	let body: unknown = {}
	if (served.row.method === 'GET') {
		body = paramsObject(urlParams(request), served.row.input)
	} else {
		const limit = served.row.admission?.maxBytes ?? null
		const text = limit === null
			? await request.text()
			: new TextDecoder().decode(await readBoundedBody(request, limit, AbortSignal.timeout(bodyDeadlineMs(limit))))
		if (mediaType(request.headers.get('Content-Type')) === FORM_URLENCODED_TYPE) {
			body = paramsObject(new URLSearchParams(text), served.row.input)
		} else if (text.trim() !== '') {
			try {
				body = JSON.parse(text)
			} catch {
				throw new BadRequestError('The body is not JSON')
			}
		}
	}
	if (served.input === null) {
		if (!isRecord(body) || Object.keys(body).length > 0) {
			throw new BadRequestError(`'${served.row.id}' takes no input; send {} or an empty body`)
		}
		return {}
	}
	return strictInput(served.row, served.input, body)
}

/**
 * A procedure's body: its input read whole (JSON, urlencoded, or a GET's URL parameters), or a multipart body whose JSON
 * part was read and whose file parts follow. Only a procedure with file fields reads multipart.
 */
async function procedureBody(
	served: { readonly row: EndpointRow; readonly input: Schema | null },
	request: Request,
	kinds: StoredFileKinds | null,
): Promise<
	{ readonly input: Readonly<Record<string, unknown>>; readonly multipart: null } | { readonly input: null; readonly multipart: MultipartInput }
> {
	const fields = fileFieldsOf(served.row.input)
	if (served.row.method === 'POST' && fields.size > 0 && mediaType(request.headers.get('Content-Type')) === FORM_MULTIPART_TYPE) {
		return { input: null, multipart: await openMultipart(served.row, fields, request, kinds) }
	}
	return { input: await readInput(served, request), multipart: null }
}

/** A multipart body being read: its JSON input part, read first, and its file parts, read by `files`. */
interface MultipartInput {
	/** The input part's fields: no file field among them; the challenge reads its token from here. */
	readonly json: Readonly<Record<string, unknown>>
	/** Reads every file part as the body streams, staging each for `work`: the file fields' references by name. */
	files(work: FileWork): Promise<Readonly<Record<string, unknown>>>
	/** Ends the read and the body deadline, whatever happened. */
	close(): Promise<void>
}

/**
 * Opens a procedure's `multipart/form-data` body: its first part is the input as JSON (named `input`, at most the
 * procedure's `maxBytes`), and each later part a file of a file field, under the field's name. The whole body arrives
 * within the deadline its `maxBytes` derives and holds at most `maxBytes` and each part's overhead: a declared length
 * past that is refused unread, and a body without one is cut off once it passes it.
 */
async function openMultipart(
	row: EndpointRow,
	fields: ReturnType<typeof fileFieldsOf>,
	request: Request,
	kinds: StoredFileKinds | null,
): Promise<MultipartInput> {
	const boundary = multipartBoundary(request.headers.get('Content-Type'))
	if (boundary === null) {
		throw new HttpError(400, 'admission', `'${row.id}' takes multipart/form-data with a boundary`)
	}
	const maxBytes = maxBytesOf(row)
	const files = [...fields.values()].reduce((sum, field) => sum + field.max, 0)
	const tooLarge = () => new HttpError(413, 'too_large', `The body is larger than the ${maxBytes} bytes '${row.id}' admits`)
	const bodyBytes = maxBytes + (files + 1) * MULTIPART_PART_OVERHEAD
	const declared = Number(request.headers.get('Content-Length') ?? '')
	if (Number.isFinite(declared) && declared > bodyBytes) {
		throw tooLarge()
	}
	const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(bodyDeadlineMs(maxBytes))])
	const body = boundedStream(request.body ?? new Blob([]).stream(), bodyBytes)
	const parts = multipartParts(body.stream, boundary, { maxHeaderBytes: PROCEDURE_LIMITS.maxPartHeaderBytes })
	const failure = (error: unknown) => (body.exceeded() ? tooLarge() : multipartFailure(error, parts, deadline, request))
	const stop = () => {
		parts.cancel().catch(() => {})
	}
	deadline.addEventListener('abort', stop, { once: true })
	const close = async () => {
		deadline.removeEventListener('abort', stop)
		await parts.cancel()
	}
	let json: Readonly<Record<string, unknown>>
	try {
		const first = await parts.next()
		if (first === null || first.name !== FILE_INPUT_PART || first.filename !== null) {
			await first?.body.cancel()
			throw new HttpError(400, 'multipart', `'${row.id}': the first part is the input as JSON, named '${FILE_INPUT_PART}', without a filename`)
		}
		const bytes = await readBoundedBytes(first.body, { maxBytes })
		if (bytes === null) {
			throw tooLarge()
		}
		const parsed = parseJson(bytes)
		if (!isRecord(parsed) || Object.keys(parsed).some((name) => fields.has(name))) {
			throw new HttpError(400, 'multipart', `'${row.id}': the input part is an object, and each file field arrives as a part of its own`)
		}
		json = parsed
	} catch (error) {
		const refused = failure(error)
		await close()
		throw refused
	}
	return {
		json,
		close,
		files: async (work) => {
			if (kinds === null) {
				throw new ServerFault('facility_unbound', `'${row.id}' takes files, and boot bound no file kinds`)
			}
			const values: Record<string, unknown> = {}
			const counts = new Map<string, number>()
			try {
				for (let part = await parts.next(); part !== null; part = await parts.next()) {
					const field = fields.get(part.name)
					const count = counts.get(part.name) ?? 0
					if (field === undefined || count >= field.max || part.filename === null) {
						await part.body.cancel()
						throw new HttpError(
							400,
							'multipart',
							`'${row.id}': a part is no file field of the input, a field carries more files than it admits, or a file has no filename`,
						)
					}
					counts.set(part.name, count + 1)
					const file = await kinds.receive(work, field.kind, part)
					if (file === null) {
						continue
					}
					const taken = values[part.name]
					values[part.name] = field.many ? [...(Array.isArray(taken) ? taken : []), file] : file
				}
			} catch (error) {
				throw failure(error)
			}
			return values
		},
	}
}

/**
 * Commits the invocation of an answer that is ready: a file's object stream was opened before the commit, so a failed
 * commit cancels it and nothing of it is sent.
 */
async function commitAnswer(invocation: Invocation | null, signal: AbortSignal, answer: Response | FileDownload): Promise<void> {
	try {
		await invocation?.commit(signal)
	} catch (error) {
		if (answer instanceof FileDownload) {
			await answer.body.cancel()
		}
		throw error
	}
}

/** A POST's `query`: the URL's flat parameters, parsed strictly by the declared schema; `undefined` without one. */
function readQuery(
	row: EndpointRow,
	query: Schema | undefined,
	shape: SchemaShape | undefined,
	request: Request,
): Readonly<Record<string, unknown>> | undefined {
	return query === undefined ? undefined : strictInput(row, query, paramsObject(urlParams(request), shape ?? null))
}

/**
 * A redirect's answer: 303 after a POST, 302 after a GET, to a path of the application's own origin, a URL of an origin
 * the output lists, or an http(s) URL a verified token of this request carries as it is. Any other target fails the
 * invocation, so the procedure is never an open redirect.
 */
function redirectResponse(row: EndpointRow, shape: RedirectShape, output: unknown, request: Request, carried: ReadonlySet<string>): Response {
	const to = isRecord(output) && typeof output['to'] === 'string' ? output['to'] : ''
	const own = to.startsWith('/') && !to.startsWith('//') && !to.includes('\\')
	let listed = false
	if (!own) {
		try {
			const url = new URL(to)
			listed = (url.protocol === 'https:' && shape.origins.includes(url.origin))
				|| ((url.protocol === 'https:' || url.protocol === 'http:') && carried.has(to))
		} catch {
			listed = false
		}
	}
	if (!own && !listed) {
		throw new ServerFault(
			'redirect_refused',
			`'${row.id}' redirected to a target that is neither its own origin's path, a listed origin's URL nor a URL a verified token carries`,
		)
	}
	// The typed client reads the target and decides whether to navigate; a browser's form or link follows the redirect.
	if (asksForJson(request)) {
		return jsonResponse({ result: { to } }, 200)
	}
	return new Response(null, { status: request.method === 'GET' ? 302 : 303, headers: { Location: to } })
}

/** A request whose `Accept` names JSON and not HTML: the typed client's, never a browser navigation's. */
function asksForJson(request: Request): boolean {
	const accept = (request.headers.get('Accept') ?? '').toLowerCase()
	return accept.includes('application/json') && !accept.includes('text/html')
}

/** Removes the `from` field: the only copy of that id the handler gets is the checked capability. */
function takeField(
	input: Readonly<Record<string, unknown>>,
	field: string,
): { readonly value: string; readonly rest: Readonly<Record<string, unknown>> } {
	const value = input[field]
	if (typeof value !== 'string') {
		throw new BadRequestError(`${field}: a string is required`)
	}
	const rest = Object.fromEntries(Object.entries(input).filter(([name]) => name !== field))
	return { value, rest: Object.freeze(rest) }
}

/** The only body a 5xx carries: what failed stays on the server, because it may quote a credential. */
function serverError(status: number): Response {
	return status === 503
		? jsonResponse({ error: { type: 'unavailable', message: 'Service unavailable' } }, 503)
		: jsonResponse({ error: { type: 'internal', message: 'Internal error' } }, status)
}

/**
 * One envelope, `{ error: { type, message, issues? } }`. A client error keeps its own message and issues; every
 * 5xx and every refused capability answers a fixed message; what made a 5xx reaches only `FailureReports`, as a code.
 */
export function errorResponse(error: unknown, where: string): Response {
	if (isStructuralError(error) && error.httpStatus < 500) {
		return toErrorResponse(error)
	}
	if (error instanceof CapabilityLimitError) {
		console.error(`fabrika: ${where}: capability_limit: the caller holds the action in more scope values than one list may carry`)
		return toErrorResponse(new ForbiddenError(`The caller holds the action in more scope values than one list may carry (${MAX_WITHIN_VALUES})`))
	}
	const name = error instanceof Error ? error.name : ''
	// `@fabrika/db` errors carry no status; they are read by name, never by a cross-package `instanceof`.
	if (name === 'NotFoundError') {
		return toErrorResponse(new NotFoundError('Not found'))
	}
	if (name === 'ConflictError') {
		return toErrorResponse(new HttpError(409, 'conflict', 'The object changed since it was read'))
	}
	if (error instanceof ServerFault) {
		return serverError(error.status)
	}
	return serverError(isStructuralError(error) ? error.httpStatus : 500)
}
