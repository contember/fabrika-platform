// A contract as plain data, with each schema of type `S`: a zod schema in the evaluated contract, a `SchemaShape`
// once described. `buildArtifact` reads only this shape, so a reader that produces it from source (B1) and
// `compileContract` normalize through the same code.

import type { CspSource, RpcCaller } from '@fabrika/auth-core'

export interface ContractDeclaration<S> {
	readonly app: string
	readonly dimensions: Readonly<Record<string, DimensionDeclaration>>
	readonly actions: Readonly<Record<string, string>>
	readonly roles: Readonly<Record<string, RoleDeclaration>>
	readonly mounts: Readonly<Record<string, MountDeclaration<S>>>
	readonly files: Readonly<Record<string, FilesDeclaration>>
	readonly jobs: Readonly<Record<string, CronDeclaration>>
	readonly exports: Readonly<Record<string, ExportDeclaration<S>>>
	readonly imports: Readonly<Record<string, ImportDeclaration>>
	readonly csp: CspDeclaration
}

/**
 * The keys of the object `defineContract`'s callback returns that are sections, not mounts. Every other key is a
 * mount. A reader of source splits the object the same way.
 */
export const SURFACE_SECTIONS = ['files', 'jobs', 'exports', 'imports', 'csp'] as const

export type SurfaceSection = (typeof SURFACE_SECTIONS)[number]

/**
 * The option fields each builder takes, and the fields it sets itself. A builder copies only its option fields and
 * records every other key of its options in `unknownOptions`, so an option can never replace what the builder set;
 * `buildArtifact` refuses a non-empty `unknownOptions`. A reader of source fills it the same way.
 */
export type Builder = 'procedure' | 'rpc' | 'link' | 'spa' | 'form' | 'webhook' | 'files' | 'cron' | 'export'

export interface BuilderFields {
	readonly options: readonly string[]
	readonly owned: readonly string[]
}

export const BUILDER_FIELDS: Readonly<Record<Builder, BuilderFields>> = {
	procedure: { options: ['input', 'output', 'access'], owned: ['~kind', 'type'] },
	rpc: { options: ['callers'], owned: ['kind', 'prefix', 'procedures'] },
	link: { options: ['spa', 'dimension', 'grants', 'issuedBy', 'maxDays', 'procedures'], owned: ['kind', 'prefix'] },
	spa: { options: ['dir', 'access'], owned: ['kind', 'prefix'] },
	form: { options: ['input', 'appendTo', 'maxBytes'], owned: ['kind', 'path'] },
	webhook: { options: ['scheme', 'boundTo', 'actions', 'input', 'maxBytes'], owned: ['kind', 'path'] },
	files: { options: ['owner', 'read', 'write', 'delete', 'maxBytes', 'types', 'maxPerOwner', 'link'], owned: ['kind'] },
	cron: { options: ['actions', 'scope', 'timeout', 'retries'], owned: ['kind', 'schedule'] },
	export: { options: ['version', 'consumers', 'audience', 'procedures'], owned: ['kind'] },
}

/** The keys of `options` that are not `builder`'s option fields. */
export function unknownOptions(options: object, builder: Builder): string[] {
	const declared = BUILDER_FIELDS[builder].options
	return Object.keys(options).filter((key) => !declared.includes(key))
}

/**
 * The off-road fields a site of the staged kit declares beside its builder's options. The kit copies them into
 * `declared`; `buildArtifact` checks which of them the site may carry.
 */
export const DECLARED_FIELDS = ['sql', 'unscoped', 'connect', 'issues'] as const

/** The keys of a kit site's `options` that are neither `builder`'s option fields nor a declared field. */
export function kitUnknownOptions(options: object, builder: Builder): string[] {
	return unknownOptions(options, builder).filter((key) => !DECLARED_FIELDS.some((field) => field === key))
}

/**
 * The reach a site of the staged kit declares, as written (`sql`, `unscoped`, `connect`, `issues`): only the fields
 * its options carry. Unchecked here: the static reader copies what the source holds, and `buildArtifact` parses it.
 */
export interface DeclaredDeclaration {
	readonly sql?: unknown
	readonly unscoped?: unknown
	readonly connect?: unknown
	readonly issues?: unknown
}

/** The declared fields of a kit site's options, each one only when the options carry it. */
export function declaredOf(options: DeclaredDeclaration): DeclaredDeclaration {
	return {
		...(options.sql === undefined ? {} : { sql: options.sql }),
		...(options.unscoped === undefined ? {} : { unscoped: options.unscoped }),
		...(options.connect === undefined ? {} : { connect: options.connect }),
		...(options.issues === undefined ? {} : { issues: options.issues }),
	}
}

/** Option keys outside the builder's option fields; `buildArtifact` refuses any. */
interface OptionsRecord {
	readonly unknownOptions?: readonly string[]
}

export interface DimensionDeclaration {
	readonly in?: string
	readonly creator?: string
	readonly members?: { readonly manage: string; readonly list: string }
	/** `'labels'` only; `buildArtifact` refuses another value. */
	readonly directory?: string
}

export interface RoleDeclaration {
	readonly grants: readonly string[]
	readonly member?: { readonly scope: string; readonly assignableBy: readonly string[] }
}

export type AccessDeclaration =
	| { readonly member: true }
	| { readonly action: string; readonly over: string }
	| { readonly action: string; readonly in: string; readonly from: string }
	| { readonly action: string; readonly on: string; readonly from: string }
	| { readonly action: string; readonly creates: string }

/** A link procedure acts on the object its key is bound to, so it names only the action. */
/** An export procedure's access: an action, never `member`, because the consumer's key holds exactly the actions. */
export type ExportAccessDeclaration = Exclude<AccessDeclaration, { readonly member: true }>

export interface LinkAccessDeclaration {
	readonly action: string
}

export type SpaAccessDeclaration = { readonly member: true } | { readonly action: string; readonly over: string }

export type ProcedureType = 'query' | 'mutation'

export interface ProcedureDeclaration<S, Access = AccessDeclaration> extends OptionsRecord {
	readonly '~kind': 'procedure'
	readonly type: ProcedureType
	/** `null` when the procedure takes no input. */
	readonly input: S | null
	readonly output: S
	readonly access: Access
	/** What a procedure of the staged kit declares off the paved road; a `defineContract` procedure has none. */
	readonly declared?: unknown
}

/** Procedures by name; a nested object groups them, and the path joins the names with `.`. */
export interface ProcedureTreeDeclaration<S, Access = AccessDeclaration> {
	readonly [name: string]: ProcedureDeclaration<S, Access> | ProcedureTreeDeclaration<S, Access>
}

export type MountDeclaration<S> =
	| RpcMountDeclaration<S>
	| LinkMountDeclaration<S>
	| SpaMountDeclaration
	| HealthMountDeclaration
	| FormMountDeclaration<S>
	| WebhookMountDeclaration<S>

export interface RpcMountDeclaration<S> extends OptionsRecord {
	readonly kind: 'rpc'
	readonly prefix: string
	readonly callers: readonly [RpcCaller, ...RpcCaller[]]
	readonly procedures: ProcedureTreeDeclaration<S>
}

export interface LinkMountDeclaration<S> extends OptionsRecord {
	readonly kind: 'link'
	readonly prefix: string
	readonly spa: string
	readonly dimension: string
	readonly grants: readonly string[]
	readonly issuedBy: string
	readonly maxDays: number
	readonly procedures: ProcedureTreeDeclaration<S, LinkAccessDeclaration>
}

export interface SpaMountDeclaration extends OptionsRecord {
	readonly kind: 'spa'
	readonly prefix: string
	readonly dir: string
	readonly access: SpaAccessDeclaration
}

export interface HealthMountDeclaration {
	readonly kind: 'health'
	readonly path: string
}

export interface FormMountDeclaration<S> extends OptionsRecord {
	readonly kind: 'form'
	readonly path: string
	readonly input: S
	readonly appendTo: string
	readonly maxBytes?: number
}

export interface WebhookMountDeclaration<S> extends OptionsRecord {
	readonly kind: 'webhook'
	readonly path: string
	readonly scheme: 'github-sha256'
	/** A dimension, or `app` for the whole application. */
	readonly boundTo: string
	readonly actions: readonly string[]
	readonly input: S
	readonly maxBytes?: number
	/** What a webhook of the staged kit declares off the paved road. */
	readonly declared?: unknown
}

export interface FilesDeclaration extends OptionsRecord {
	readonly kind: 'files'
	readonly owner: string
	readonly read: string
	readonly write: string
	readonly delete: string
	readonly maxBytes: number
	readonly types: readonly string[]
	readonly maxPerOwner?: number
	readonly link?: boolean
}

export interface CronDeclaration extends OptionsRecord {
	readonly kind: 'cron'
	readonly schedule: string
	readonly actions: readonly string[]
	/** A dimension, or `app` for the whole application. */
	readonly scope: string
	readonly timeout?: string
	readonly retries?: number
	/** What a job of the staged kit declares off the paved road. */
	readonly declared?: unknown
}

export interface ExportDeclaration<S> extends OptionsRecord {
	readonly kind: 'export'
	readonly version: number
	readonly consumers: readonly string[]
	readonly audience: string
	readonly procedures: ProcedureTreeDeclaration<S, ExportAccessDeclaration>
}

export interface ImportDeclaration {
	readonly app: string
	readonly export: string
	readonly version: number
	readonly digest: string
	readonly procedures: readonly string[]
	readonly usedBy: readonly string[]
	readonly timeoutMs?: number
}

export interface CspDeclaration {
	readonly connectSrc?: readonly CspSource[]
	readonly imgSrc?: readonly CspSource[]
	readonly frameAncestors?: readonly CspSource[]
}

export function isProcedure<S, Access>(
	node: ProcedureDeclaration<S, Access> | ProcedureTreeDeclaration<S, Access>,
): node is ProcedureDeclaration<S, Access> {
	return node['~kind'] === 'procedure'
}
