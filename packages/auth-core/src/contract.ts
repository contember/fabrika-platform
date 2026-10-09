// The compiled form of an application contract (ADR-0012). Types only: each reader parses the artifact with its
// own schema, as gate rules are parsed today.

/**
 * An application's whole access surface as plain JSON. `compileContract` produces it from the evaluated contract and
 * the static reader from source; both must produce the same value for the same contract. Every optional authored
 * field is normalized to `null`, `[]` or `{}`, so a field is always present. Key order and the order of `endpoints`
 * carry no meaning.
 */
export interface ContractArtifact extends EndpointTable {
	readonly app: string
	readonly dimensions: Readonly<Record<string, DimensionArtifact>>
	/** Action → description. Exact actions only; the artifact holds no wildcard. */
	readonly actions: Readonly<Record<string, string>>
	readonly roles: Readonly<Record<string, RoleArtifact>>
	readonly mounts: Readonly<Record<string, MountArtifact>>
	readonly files: Readonly<Record<string, FileCollectionArtifact>>
	readonly jobs: Readonly<Record<string, JobArtifact>>
	readonly exports: Readonly<Record<string, ExportArtifact>>
	readonly imports: Readonly<Record<string, ImportArtifact>>
	readonly csp: CspExtensions
	readonly tables: Readonly<Record<string, TablePolicyArtifact>>
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

/** A link holder reaches only its own link mount, never an RPC mount. */
export type RpcCaller = Exclude<Caller, 'link'>

export type EndpointMethod = 'GET' | 'POST'

/** Kinds that verify a credential, check the caller kind and the requirement. */
export type CredentialedEndpointKind = 'query' | 'mutation' | 'spa' | 'upload' | 'download'

/** Fixed anonymous kinds: no caller, no requirement, no token. `link-spa` is the shell of a link mount's SPA. */
export type AnonymousEndpointKind = 'health' | 'form' | 'webhook' | 'link-spa'

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
	readonly output: SchemaShape | null
}

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
 * `action` is that action in some scope, global included. The access form is what the framework then resolves.
 */
export type EndpointRequirement = MemberRequirement | ActionRequirement

export interface MemberRequirement {
	readonly kind: 'member'
}

export interface ActionRequirement {
	readonly kind: 'action'
	readonly action: string
	readonly access: AccessForm
}

/** `from` names an input field or a path parameter of the endpoint. */
export type AccessForm =
	| { readonly form: 'over'; readonly dimension: string }
	| { readonly form: 'in'; readonly dimension: string; readonly from: string }
	/** `from: null` is the object a link key is bound to. */
	| { readonly form: 'on'; readonly dimension: string; readonly from: string | null }
	| { readonly form: 'creates'; readonly dimension: string }

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
}

export interface RoleArtifact {
	readonly grants: readonly string[]
	/** A membership role is granted only in a value of `scope`, by a holder of one of the `assignableBy` roles there. */
	readonly member: { readonly scope: string; readonly assignableBy: readonly string[] } | null
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
	readonly callers: readonly [RpcCaller, ...RpcCaller[]]
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
}

export interface WebhookMountArtifact {
	readonly kind: 'webhook'
	readonly path: string
	readonly scheme: 'github-sha256'
	readonly boundTo: ScopeBinding
	readonly actions: readonly string[]
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
	/** Whether a share link to the owner reaches the files. */
	readonly link: boolean
}

export interface JobArtifact {
	readonly schedule: string
	readonly actions: readonly string[]
	readonly scope: ScopeBinding
	readonly timeout: string | null
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

export interface CspExtensions {
	readonly connectSrc: readonly CspSource[]
	readonly imgSrc: readonly CspSource[]
	readonly frameAncestors: readonly CspSource[]
}

export interface CspSource {
	readonly origin: string
	readonly purpose: string
}

// ── Table policies ──────────────────────────────────────────────────────────────────────────────

export interface TablePolicyArtifact {
	readonly scope: TableScope
	/** An inbox's read action is `read`; it has no write action, because only its form appends. */
	readonly actions: {
		readonly read: string
		readonly insert: string | null
		readonly update: string | null
		readonly delete: string | null
	}
	readonly insert: readonly string[]
	readonly update: readonly string[]
	readonly version: string | null
	readonly createdBy: string | null
	/** Column → its own read action. A column without one falls back to the table's read action. */
	readonly columns: Readonly<Record<string, { readonly read: string }>>
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
