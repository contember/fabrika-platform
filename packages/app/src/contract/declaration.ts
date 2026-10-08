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

export interface DimensionDeclaration {
	readonly in?: string
	readonly creator?: string
	readonly members?: { readonly manage: string; readonly list: string }
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
export interface LinkAccessDeclaration {
	readonly action: string
}

export type SpaAccessDeclaration = { readonly member: true } | { readonly action: string; readonly over: string }

export type ProcedureType = 'query' | 'mutation'

export interface ProcedureDeclaration<S, Access = AccessDeclaration> {
	readonly '~kind': 'procedure'
	readonly type: ProcedureType
	/** `null` when the procedure takes no input. */
	readonly input: S | null
	readonly output: S
	readonly access: Access
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

export interface RpcMountDeclaration<S> {
	readonly kind: 'rpc'
	readonly prefix: string
	readonly callers: readonly [RpcCaller, ...RpcCaller[]]
	readonly procedures: ProcedureTreeDeclaration<S>
}

export interface LinkMountDeclaration<S> {
	readonly kind: 'link'
	readonly prefix: string
	readonly spa: string
	readonly dimension: string
	readonly grants: readonly string[]
	readonly issuedBy: string
	readonly maxDays: number
	readonly procedures: ProcedureTreeDeclaration<S, LinkAccessDeclaration>
}

export interface SpaMountDeclaration {
	readonly kind: 'spa'
	readonly prefix: string
	readonly dir: string
	readonly access: SpaAccessDeclaration
}

export interface HealthMountDeclaration {
	readonly kind: 'health'
	readonly path: string
}

export interface FormMountDeclaration<S> {
	readonly kind: 'form'
	readonly path: string
	readonly input: S
	readonly appendTo: string
	readonly maxBytes?: number
}

export interface WebhookMountDeclaration<S> {
	readonly kind: 'webhook'
	readonly path: string
	readonly scheme: 'github-sha256'
	/** A dimension, or `app` for the whole application. */
	readonly boundTo: string
	readonly actions: readonly string[]
	readonly input: S
	readonly maxBytes?: number
}

export interface FilesDeclaration {
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

export interface CronDeclaration {
	readonly kind: 'cron'
	readonly schedule: string
	readonly actions: readonly string[]
	/** A dimension, or `app` for the whole application. */
	readonly scope: string
	readonly timeout?: string
	readonly retries?: number
}

export interface ExportDeclaration<S> {
	readonly kind: 'export'
	readonly version: number
	readonly consumers: readonly string[]
	readonly audience: string
	readonly procedures: ProcedureTreeDeclaration<S>
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
