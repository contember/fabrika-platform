// The compiled form of an application contract (ADR-0012). Types only: each reader parses the artifact with its
// own schema, as gate rules are parsed today.

import type { Locale } from './locale'
import type { MailTemplates } from './mail'

/**
 * The artifact format this release writes. A release that changes the artifact raises it, and Control upcasts every
 * older format of its window to this one (ADR-0062). The 0.5 artifact carries no `format`.
 */
export const CONTRACT_FORMAT = 2

/**
 * An application's whole access surface as plain JSON. `compileContract` produces it from the evaluated contract and
 * the static reader from source; both must produce the same value for the same contract. Every optional authored
 * field is normalized to `null`, `[]` or `{}`, so a field is always present. Key order and the order of `endpoints`
 * carry no meaning.
 */
export interface ContractArtifact extends EndpointTable {
	readonly format: typeof CONTRACT_FORMAT
	readonly app: string
	readonly dimensions: Readonly<Record<string, DimensionArtifact>>
	/** Action → description. Exact actions only; the artifact holds no wildcard. */
	readonly actions: Readonly<Record<string, string>>
	readonly roles: Readonly<Record<string, RoleArtifact>>
	readonly mounts: Readonly<Record<string, MountArtifact>>
	readonly files: Readonly<Record<string, FileCollectionArtifact>>
	/**
	 * The file kinds (`c.files({ types, maxBytes, scan? })`): classes of stored files a table's file column holds. A kind
	 * has no owner and no endpoint; the table that holds a file is its authority. Absent unless declared, so the digest stays.
	 */
	readonly fileKinds?: Readonly<Record<string, FileKindArtifact>>
	readonly jobs: Readonly<Record<string, JobArtifact>>
	readonly exports: Readonly<Record<string, ExportArtifact>>
	readonly imports: Readonly<Record<string, ImportArtifact>>
	readonly csp: CspExtensions
	readonly tables: Readonly<Record<string, TablePolicyArtifact>>
	/**
	 * The reach each site declares off the paved road, by site: an endpoint's id (a procedure or a webhook), or
	 * `job:<name>`; a site that declares nothing has no entry. Present for a contract of the staged kit, whose sites
	 * reach only what they declare; absent for a `defineContract` one, so its digest stays what it was.
	 */
	readonly declared?: Readonly<Record<string, DeclaredReach>>
	/**
	 * The member directory each endpoint reads (`ctx.members` without management), by endpoint id: derived from the
	 * dimensions by `directoryReach` and recorded so the approval sees and the digest covers it. Absent when no endpoint
	 * reads one, so the digest of such a contract stays.
	 */
	readonly directories?: Readonly<Record<string, { readonly dimension: string; readonly lists: boolean }>>
	/** The language IAM speaks to this application's people. Absent unless declared, so the digest stays. */
	readonly locale?: Locale
	/** The name IAM shows on its pages and e-mails for this application. Absent unless declared, so the digest stays. */
	readonly displayName?: string
	/** The application's wording of IAM's e-mails. Absent unless declared, so the digest stays. */
	readonly mail?: MailTemplates
	/**
	 * The application's own people, every holder of one of its roles: `manage` held globally administers its global roles in
	 * IAM's console, `list` held globally reads its member directory (`ctx.members` of an `app` endpoint of that action).
	 * Absent unless declared, so the digest stays.
	 */
	readonly members?: { readonly manage: string; readonly list: string }
	/** `labels`: the application's directory shows labels to `members.list` holders. Absent unless declared, so digests stay. */
	readonly directory?: 'labels'
	/**
	 * What each procedure of the staged kit admits and how long it runs, by endpoint id, with every default applied: the
	 * rules the application applies itself, beside the row the proxy applies. Absent for a contract with no such
	 * procedure (a `defineContract` one, an older release's), so its digest stays.
	 */
	readonly procedures?: Readonly<Record<string, ProcedureArtifact>>
}

/**
 * One procedure's own admission and time limit, effective values only. The body limit and codec are the row's
 * `admission`, the origin rule its `crossOrigin`.
 */
export interface ProcedureArtifact {
	readonly rate: AdmissionRate
	/** The challenge the framework verifies before the handler; a public procedure only. */
	readonly challenge: FormChallenge | null
	/** How long the handler may run after the last body byte, in ms. */
	readonly timeoutMs: number
	/** A POST's flat schema of the URL's parameters, the handler's `query`; absent without one, so digests stay. */
	readonly query?: SchemaShape
}

/**
 * A procedure's buckets, per minute and shared by every instance; `null` is no bucket. `perClient` counts by the client
 * address (public only), `perCaller` by the principal or link key (credentialed and link only), `perEndpoint` every
 * call. Every bucket is charged before the body is read and stays charged whatever the handler does.
 */
export interface AdmissionRate {
	readonly perClient: number | null
	readonly perCaller: number | null
	readonly perEndpoint: number | null
	/** The bytes the procedure's file fields may write per hour, all calls together. */
	readonly bytesPerHour: number | null
}

// ── The endpoint table ──────────────────────────────────────────────────────────────────────────

/** What `planEndpoint` selects from: the endpoint rows and the prefixes reserved for procedures. */
export interface EndpointTable {
	readonly endpoints: readonly EndpointRow[]
	/**
	 * Literal path prefixes of procedure mounts (`/api`). A path under one (`/api/…`) is served only by an endpoint
	 * declared under it, so an unknown procedure never reaches a broader endpoint such as the SPA.
	 */
	readonly reservedPrefixes: readonly string[]
}

/** Who may call a credentialed endpoint. There is no public caller: anonymous traffic is a fixed endpoint kind. */
export type Caller = 'human' | 'machine' | 'link' | `app:${string}`

/** `app:<id>`: the connector of the consuming application `<id>`. */
export const APP_CALLER_PREFIX = 'app:'

/** Every export procedure and description is served under this prefix; an `app:<id>` caller reaches nothing else. */
export const CONNECT_PREFIX = '/__fabrika/connect'

/** An RPC mount's callers: a link holder reaches only its own link mount, and an `app:<id>` only an export. */
export type RpcCaller = 'human' | 'machine'

export type EndpointMethod = 'GET' | 'POST'

/** Kinds that verify a credential, check the caller kind and the requirement. */
export type CredentialedEndpointKind = 'query' | 'mutation' | 'spa' | 'upload' | 'download'

/**
 * Fixed anonymous kinds: no caller, no requirement, no token. `link-spa` is the shell of a link mount's SPA;
 * `public-spa` is an SPA anyone opens (`access: { public: true }`); `public` is a procedure anyone calls, whose handler
 * runs as the endpoint's own workload. A proxy that does not know `public` refuses the manifest that holds one, so no
 * proxy serves a public procedure without its admission rules.
 */
export type AnonymousEndpointKind = 'health' | 'form' | 'webhook' | 'link-spa' | 'public-spa' | 'public'

export type EndpointKind = CredentialedEndpointKind | AnonymousEndpointKind

/** The contract entry that declared an endpoint. */
export interface EndpointSource {
	readonly kind: 'mount' | 'export' | 'files'
	readonly name: string
}

interface EndpointRowBase {
	/** Unique in the table: the framework dispatches by it and the proxy names it in `X-Fabrika-Endpoint`. */
	readonly id: string
	readonly source: EndpointSource
	readonly method: EndpointMethod
	/**
	 * Matched against the raw path, case-sensitively. Segments are literals, `:name` (one non-empty segment) or a
	 * terminal `*`. A non-root `*` needs the slash before it, and a trailing `/` is a literal empty segment.
	 */
	readonly path: string
	/** The request body the endpoint admits; `null` admits none. */
	readonly admission: BodyAdmission | null
	readonly input: SchemaShape | null
	readonly output: OutputShape | null
	/**
	 * Whether a page on another origin may call the endpoint (ADR-0022 "Cross-origin endpoints"): `environment` from
	 * the origins its environment lists, `any` (a form or a public procedure only) from every origin. Absent unless
	 * declared, so every other row keeps its digest. Only an RPC procedure, a public procedure and a form may carry it.
	 */
	readonly crossOrigin?: CrossOriginForm
	/**
	 * `file`: the procedure answers a stored file (an output `file('<kind>')`), so the proxy and the application give every
	 * answer of it, a denial included, ADR-0022's file treatment. Absent otherwise, so every other row keeps its digest.
	 */
	readonly response?: EndpointResponse
}

/** The answer profile of a row that answers a stored file. */
export type EndpointResponse = 'file'

/** The endpoint kinds whose row may answer a stored file: a procedure's. */
export const FILE_RESPONSE_KINDS: readonly EndpointKind[] = ['query', 'mutation', 'public']

/** Whether every answer of a row gets the file treatment: a collection's download, or a procedure that answers a file. */
export function answersFile(row: { readonly kind: string; readonly response?: EndpointResponse }): boolean {
	return row.kind === 'download' || row.response === 'file'
}

/** How an endpoint admits another origin: from the environment's list, or (a form or a public procedure) from any origin. */
export type CrossOriginForm = 'environment' | 'any'

/** The endpoint kinds that may declare `crossOrigin`, and those of them that may admit any origin. */
export const CROSS_ORIGIN_KINDS: readonly EndpointKind[] = ['query', 'mutation', 'form', 'public']
export const ANY_ORIGIN_KINDS: readonly EndpointKind[] = ['form', 'public']

export interface CredentialedEndpoint extends EndpointRowBase {
	readonly kind: CredentialedEndpointKind
	readonly callers: readonly [Caller, ...Caller[]]
	readonly requirement: EndpointRequirement
}

export interface AnonymousEndpoint extends EndpointRowBase {
	readonly kind: AnonymousEndpointKind
	readonly callers: readonly []
	readonly requirement: null
}

export type EndpointRow = CredentialedEndpoint | AnonymousEndpoint

export interface BodyAdmission {
	readonly contentTypes: readonly [string, ...string[]]
	readonly maxBytes: number | null
}

/**
 * What the token must carry before the request reaches a handler. `member` is any permission of this application;
 * `action` is that action in some scope, global included, and only globally under the `app` form. The access form is
 * what the framework then resolves.
 */
export type EndpointRequirement = MemberRequirement | ActionRequirement | CapabilitiesRequirement

export interface MemberRequirement {
	readonly kind: 'member'
}

export interface ActionRequirement {
	readonly kind: 'action'
	readonly action: string
	readonly access: AccessForm
}

/**
 * Several capabilities (`access: { capabilities }`), by the name the handler reads each under (`ctx.capabilities.<name>`):
 * the token must carry every action, and the access form of each narrows it as it narrows a single one. At least two.
 */
export interface CapabilitiesRequirement {
	readonly kind: 'capabilities'
	readonly capabilities: Readonly<Record<string, CapabilityRequirement>>
}

/** One capability of several: an action in a dimension, its value read from an input field or listed `over` it. */
export interface CapabilityRequirement {
	readonly action: string
	readonly access: CapabilityAccessForm
}

export type CapabilityAccessForm =
	| { readonly form: 'over'; readonly dimension: string }
	| { readonly form: 'in'; readonly dimension: string; readonly from: string }
	| { readonly form: 'on'; readonly dimension: string; readonly from: string }

/** `from` names an input field or a path parameter of the endpoint. */
export type AccessForm =
	| { readonly form: 'over'; readonly dimension: string }
	| { readonly form: 'in'; readonly dimension: string; readonly from: string }
	/** `from: null` is the object a link key is bound to. */
	| { readonly form: 'on'; readonly dimension: string; readonly from: string | null }
	| { readonly form: 'creates'; readonly dimension: string }
	/** The action held as a global grant: data of the whole application, in no dimension. */
	| { readonly form: 'app' }

/**
 * The structure and constraints of an input or output schema. Objects are always strict: a contract admits no other.
 * The union is closed; a schema form it cannot represent is refused where the contract is compiled or read. A
 * default makes a value optional to the caller, so it is `optional`; a discriminated union is a `union`.
 */
export type SchemaShape =
	| StringShape
	| NumberShape
	| { readonly type: 'boolean' | 'null' }
	| { readonly type: 'literal'; readonly value: string | number | boolean | null }
	| { readonly type: 'enum'; readonly values: readonly string[] }
	| ArrayShape
	| TupleShape
	| RecordShape
	| { readonly type: 'object'; readonly fields: Readonly<Record<string, SchemaShape>> }
	| { readonly type: 'optional'; readonly inner: SchemaShape }
	| { readonly type: 'nullable'; readonly inner: SchemaShape }
	| { readonly type: 'union'; readonly options: readonly SchemaShape[] }
	| FileShape

/**
 * A stored file of a declared kind (`file('<kind>')`). In an input it is a top-level field, optional, or a bounded
 * array of them: a multipart part of its own beside the JSON input. As an output it is the file the procedure answers.
 */
export interface FileShape {
	readonly type: 'file'
	readonly kind: string
}

export function isFileShape(shape: OutputShape): shape is FileShape {
	return shape.type === 'file'
}

/**
 * What a procedure answers: a JSON value of a schema, a file of rows (`attachment()` of `@fabrika/app/contract`), or a
 * redirect (`redirect()`).
 */
export type OutputShape = SchemaShape | AttachmentShape | RedirectShape

/**
 * A procedure whose handler returns `{ to }` and whose answer is a redirect there: 303 after a POST, 302 after a GET.
 * A target is a path of the application's own origin or a URL of one of `origins`; anything else fails the invocation.
 */
export interface RedirectShape {
	readonly type: 'redirect'
	/** Exact `https://` origins a target may name, besides the application's own. */
	readonly origins: readonly string[]
}

export function isRedirectShape(shape: OutputShape): shape is RedirectShape {
	return shape.type === 'redirect'
}

/** An output answered as JSON of a schema: neither a file nor a redirect. */
export function isSchemaOutput(shape: OutputShape): shape is SchemaShape {
	return shape.type !== 'attachment' && shape.type !== 'redirect' && shape.type !== 'file'
}

/**
 * A procedure whose handler returns rows and whose answer is a file the framework encodes from them. The columns are
 * the row schema's fields in their declared order, which is the file's column order; each is a scalar cell.
 */
export interface AttachmentShape {
	readonly type: 'attachment'
	/** `csv`: RFC 4180 text; `xlsx`: one sheet of typed cells. */
	readonly format: AttachmentFormat
	/** The `Content-Disposition` file name: a fixed name the contract declares, never one a request sends. */
	readonly filename: string
	/** The encoded file's limit, in bytes: an encoding over it fails the invocation and sends no body. */
	readonly maxBytes: number
	readonly maxRows: number
	readonly columns: readonly AttachmentColumn[]
}

export type AttachmentFormat = 'csv' | 'xlsx'

export interface AttachmentColumn {
	readonly name: string
	readonly shape: SchemaShape
}

export function isAttachmentShape(shape: OutputShape): shape is AttachmentShape {
	return shape.type === 'attachment'
}

export interface StringShape {
	readonly type: 'string'
	/** `datetime`, `date`, `time` and `duration` are the ISO 8601 forms of `z.iso`. */
	readonly format: 'uuid' | 'email' | 'url' | 'datetime' | 'date' | 'time' | 'duration' | null
	readonly minLength: number | null
	readonly maxLength: number | null
	/** The regular expression's source, without flags. */
	readonly pattern: string | null
	readonly startsWith: string | null
	readonly endsWith: string | null
	readonly includes: string | null
}

/** `exclusiveMin` and `exclusiveMax` are `false` when their bound is `null`. */
export interface NumberShape {
	readonly type: 'number'
	readonly int: boolean
	readonly min: number | null
	readonly exclusiveMin: boolean
	readonly max: number | null
	readonly exclusiveMax: boolean
	readonly multipleOf: number | null
}

/** Fixed positions, then any number of `rest` values when it is not `null`. */
export interface TupleShape {
	readonly type: 'tuple'
	readonly items: readonly SchemaShape[]
	readonly rest: SchemaShape | null
}

export interface RecordShape {
	readonly type: 'record'
	readonly key: SchemaShape
	readonly value: SchemaShape
}

export interface ArrayShape {
	readonly type: 'array'
	readonly items: SchemaShape
	readonly minItems: number | null
	readonly maxItems: number | null
}

// ── The vocabulary ──────────────────────────────────────────────────────────────────────────────

export interface DimensionArtifact {
	/** The dimension that contains every value of this one (`note` is in `workspace`). */
	readonly in: string | null
	/** The role `creates` grants the caller in a new value of this dimension. */
	readonly creator: string | null
	readonly members: { readonly manage: string; readonly list: string } | null
	/** `labels`: the member directory shows labels to `members.list` holders. Absent unless declared, so digests stay. */
	readonly directory?: 'labels'
}

export interface RoleArtifact {
	readonly grants: readonly string[]
	/**
	 * A membership role is granted only in a value of `scope`, by a holder of one of the `assignableBy` roles: there,
	 * or globally for an application-wide role (one with no `member`).
	 */
	readonly member: { readonly scope: string; readonly assignableBy: readonly string[] } | null
	/** An external principal may hold this membership role (ADR-0051). Absent unless declared, so digests stay. */
	readonly external?: true
}

// ── Mounts and companions ───────────────────────────────────────────────────────────────────────

export type MountArtifact =
	| RpcMountArtifact
	| LinkMountArtifact
	| SpaMountArtifact
	| HealthMountArtifact
	| FormMountArtifact
	| WebhookMountArtifact

export interface RpcMountArtifact {
	readonly kind: 'rpc'
	readonly prefix: string
	/** The callers of its credentialed procedures; none when every procedure it mounts is public. */
	readonly callers: readonly RpcCaller[]
}

export interface LinkMountArtifact {
	readonly kind: 'link'
	readonly prefix: string
	/** The directory of the share SPA. */
	readonly spa: string
	readonly dimension: string
	/** Frozen into every key the mount issues. */
	readonly grants: readonly string[]
	/** The action a `Ref` must carry to issue a link. */
	readonly issuedBy: string
	readonly maxDays: number
}

export interface SpaMountArtifact {
	readonly kind: 'spa'
	readonly prefix: string
	readonly dir: string
	/** The application variables whose values the mount's pages read from its browser config; present only when declared. */
	readonly public?: readonly string[]
}

export interface HealthMountArtifact {
	readonly kind: 'health'
	readonly path: string
}

export interface FormMountArtifact {
	readonly kind: 'form'
	readonly path: string
	/** The inbox table the form appends to. */
	readonly appendTo: string
	/** Submissions per minute it admits from one client and accepts in all; each is present only when declared. */
	readonly rate?: FormRate
	/** The input field that must stay empty; a filled one is answered as accepted and writes nothing. */
	readonly honeypot?: string
	/** The challenge the framework verifies on the server before it writes the row. */
	readonly challenge?: FormChallenge
	/** The cron job each accepted submission kicks: one run in the background, coalesced on the job's lease. */
	readonly then?: string
	/**
	 * The files a submission carries beside its input, by field: each lands in its collection owned by nobody, and its
	 * id in the inbox column of the field's name, until the job that drains the inbox attaches it to its owner. Present
	 * only when declared, so every other form keeps its digest; such a form is `multipart/form-data` and challenged.
	 */
	readonly files?: Readonly<Record<string, FormFileArtifact>>
}

/**
 * The media type of a form that takes files. A browser sends it from any page without a CORS preflight, so the proxy
 * refuses such a form's request from an origin its row does not admit (ADR-0061).
 */
export const FORM_MULTIPART_TYPE = 'multipart/form-data'

/** The media type of a public procedure that declares `http: { body: 'urlencoded' }`: flat scalar fields, as a native form posts them. */
export const FORM_URLENCODED_TYPE = 'application/x-www-form-urlencoded'

/** One file field of a form: the collection the file lands in, and whether a submission must carry it. */
export interface FormFileArtifact {
	readonly collection: string
	readonly required: boolean
}

export interface FormRate {
	readonly perClient?: number
	readonly perForm?: number
	/** The bytes a form that takes files may write per hour, all its submissions together. */
	readonly bytesPerHour?: number
}

/** The closed list of challenge providers; each one's verification endpoint and browser origins are fixed. */
export type ChallengeProvider = 'turnstile'

export interface FormChallenge {
	readonly provider: ChallengeProvider
	/** The application variable holding the provider's secret: a name, never the value. */
	readonly secret: string
	/** The application variable holding the widget's public site key, which every SPA mount's browser config serves. */
	readonly siteKey?: string
}

export interface WebhookMountArtifact {
	readonly kind: 'webhook'
	readonly path: string
	readonly scheme: WebhookScheme
	readonly boundTo: ScopeBinding
	readonly actions: readonly string[]
	/** How long a delivery's handler may run after the last body byte, in ms; its body limit is its row's `admission`. */
	readonly timeoutMs: number
}

/** The providers whose signature the framework checks by name; every one signs the raw body with the binding's secret. */
export const WEBHOOK_PRESETS = ['github-sha256', 'standard-webhooks', 'stripe'] as const

export type WebhookPreset = (typeof WEBHOOK_PRESETS)[number]

/**
 * How a delivery proves it holds its binding's secret: a preset, an HMAC the framework computes in a declared shape,
 * or the secret itself as a Basic password or a bearer token. A verifier is framework code, never the application's.
 * `basic` and `bearer` read `Authorization`, which the proxy removes from an anonymous endpoint's request (ADR-0022
 * rule 3), so `buildArtifact` refuses them while it does.
 */
export type WebhookScheme =
	| WebhookPreset
	| { readonly hmac: HmacScheme }
	| { readonly basic: true }
	| { readonly bearer: true }

export type HmacAlgorithm = 'sha1' | 'sha256' | 'sha512'

/**
 * An HMAC of the binding's secret over the signed content, read from `header` as `prefix` and the encoded digest.
 * `'timestamp.body'` signs `<timestamp>.<body>` with the `timestamp` header's Unix seconds, which must be within five
 * minutes of now; `id` names a header whose value the signed content starts with, as `<id>.`.
 */
export interface HmacScheme {
	readonly header: string
	readonly algorithm: HmacAlgorithm
	readonly encoding: 'hex' | 'base64'
	readonly prefix?: string
	readonly timestamp?: string
	readonly signed: 'body' | 'timestamp.body'
	readonly id?: string
}

/** Where a workload's authority applies: the whole application, or one value of a dimension per binding. */
export type ScopeBinding = { readonly kind: 'app' } | { readonly kind: 'dimension'; readonly dimension: string }

export interface FileCollectionArtifact {
	/** The table whose rows own the files; a file inherits its owner's access. */
	readonly owner: string
	readonly read: string
	readonly write: string
	readonly delete: string
	readonly maxBytes: number
	readonly types: readonly string[]
	readonly maxPerOwner: number | null
	/**
	 * Whether a share link to the owner reaches the files: `true` through every link mount bound to the owner's
	 * dimension, a list through the named link mounts only.
	 */
	readonly link: boolean | readonly string[]
	/**
	 * Present when every upload waits `quarantined` for a clean malware verdict before it is served. Absent otherwise,
	 * so the digest of a contract that does not scan is what it was before the field existed.
	 */
	readonly scan?: true
}

/** One file kind: the media types its files may be, the largest file, and whether each waits for a clean scan. */
export interface FileKindArtifact {
	readonly types: readonly string[]
	readonly maxBytes: number
	/** Present when every file of the kind waits `quarantined` for a clean malware verdict before it is served. */
	readonly scan?: true
}

export interface JobArtifact {
	readonly schedule: string
	readonly actions: readonly string[]
	readonly scope: ScopeBinding
	/** How long one attempt may run, in ms, every default applied. */
	readonly timeoutMs: number
	readonly retries: number
}

/** An export's procedures are endpoint rows whose source is this export. */
export interface ExportArtifact {
	readonly version: number
	readonly consumers: readonly string[]
	readonly audience: string
}

/**
 * What an export's consumer vendors (`fabrika connect add`): the export's identity and each procedure's schemas, by
 * the procedure's dotted path in the export. `digest` is `exportDigest` of the rest, and the consumer's import names it.
 */
export interface ExportDescription {
	readonly app: string
	readonly export: string
	readonly version: number
	readonly audience: string
	readonly procedures: Readonly<Record<string, ExportProcedureDescription>>
	readonly digest: string
}

export interface ExportProcedureDescription {
	readonly input: SchemaShape | null
	readonly output: SchemaShape
}

export interface ImportArtifact {
	readonly app: string
	readonly export: string
	readonly version: number
	/** The digest of the vendored export snapshot. */
	readonly digest: string
	readonly procedures: readonly string[]
	/** The endpoint ids whose handlers may call the import. */
	readonly usedBy: readonly string[]
	readonly timeoutMs: number | null
}

/** `job:<name>`: a job's key in `ContractArtifact.declared`; an endpoint is keyed by its id. */
export const JOB_SITE_PREFIX = 'job:'

/**
 * What one site declares beyond its capability: `ctx.sql` in a mode, tables it reaches unscoped and in which mode, the
 * imports it calls, the link mount it issues. A review signal for the approver, never an enforcement decision.
 */
export interface DeclaredReach {
	readonly sql: 'read' | 'write' | null
	readonly unscoped: Readonly<Record<string, 'read' | 'write'>>
	readonly connect: readonly string[]
	readonly issues: string | null
	/** The cron job this mutation kicks after its commit (an older release's form); absent unless declared, so the digest stays. */
	readonly then?: string
	/**
	 * The cron jobs this site may kick (`ctx.kick`), sorted: a mutation, a webhook or a job. Absent unless declared, so
	 * the digest stays. A contract's kick edges between jobs are acyclic.
	 */
	readonly kicks?: readonly string[]
	/** The mail transport this job reaches: the installation's or its own; absent unless declared. */
	readonly mailer?: JobMailer
	/**
	 * The webhook whose bindings this mutation creates and removes (`ctx.webhooks('<name>')`), seeing each new binding's
	 * secret once. Absent unless declared, so the digest stays.
	 */
	readonly binds?: string
	/**
	 * A public procedure's workload actions, sorted: all its handler holds, through the key Control issues for the
	 * endpoint (`contractWorkloads`). Present only on a public procedure's entry, so every other digest stays.
	 */
	readonly actions?: readonly string[]
}

/** The mail transports a job may declare: the installation's default, or the application's own. */
export const JOB_MAILERS = ['installation', 'own'] as const

export type JobMailer = (typeof JOB_MAILERS)[number]

export interface CspExtensions {
	readonly connectSrc: readonly CspSource[]
	readonly imgSrc: readonly CspSource[]
	readonly frameAncestors: readonly CspSource[]
	/** Present only when the contract names a script origin (or a challenge provider needs one). */
	readonly scriptSrc?: readonly CspSource[]
	/** Present only when the contract names a frame origin; `frame-src` is emitted only then. */
	readonly frameSrc?: readonly CspSource[]
	/** Present only when the contract names a stylesheet origin, such as a hosted font's stylesheet. */
	readonly styleSrc?: readonly CspSource[]
	/** Present only when the contract names a font origin. */
	readonly fontSrc?: readonly CspSource[]
}

export interface CspSource {
	readonly origin: string
	readonly purpose: string
}

// ── Table policies ──────────────────────────────────────────────────────────────────────────────

/**
 * The actions of one table operation, any one of which allows it: one action as its text, several as a list of at least
 * two. A single action stays text, so the artifact of a policy that names one keeps its shape and digest.
 */
export type TableActionArtifact = string | readonly string[]

export interface TablePolicyArtifact {
	readonly scope: TableScope
	/** An inbox's read action is `read`; it has no write action, because only its form appends. */
	readonly actions: {
		readonly read: TableActionArtifact
		readonly insert: TableActionArtifact | null
		readonly update: TableActionArtifact | null
		readonly delete: TableActionArtifact | null
		/**
		 * A dimension or child table's actions besides `read` with which an `app` endpoint reads every row, read-only;
		 * present only when the policy names one.
		 */
		readonly appRead?: readonly string[]
		/** The actions with which an `app` endpoint counts and aggregates every row and reads none; present only when named. */
		readonly appCount?: readonly string[]
	}
	readonly insert: readonly string[]
	readonly update: readonly string[]
	readonly version: string | null
	readonly createdBy: string | null
	/**
	 * Column → its own actions. A column without a read action falls back to the table's; a column with a write action
	 * is updated by that action only, never by the table's update action.
	 */
	readonly columns: Readonly<Record<string, ColumnPolicyArtifact>>
	/**
	 * Column → the file kind it holds: a foreign key to `fabrika_files`, written only with a file reference. The table's
	 * actions are the file's authority. Absent unless declared, so the digest stays.
	 */
	readonly files?: Readonly<Record<string, string>>
}

/** A column's own read action, its own write action, or both; an absent one is left out. */
export interface ColumnPolicyArtifact {
	readonly read?: string
	readonly write?: string
}

export type TableScope =
	| {
		readonly mode: 'dimension'
		readonly dimension: string
		readonly key: string
		readonly container: { readonly dimension: string; readonly column: string } | null
	}
	| { readonly mode: 'child'; readonly parent: string; readonly key: string; readonly column: string; readonly inherit: readonly string[] }
	| { readonly mode: 'inbox'; readonly form: string }
	| { readonly mode: 'reference'; readonly reason: string }
	/** Rows of the whole application, in no dimension: an `app` endpoint reads and writes them. */
	| { readonly mode: 'app'; readonly reason: string; readonly key: string }
