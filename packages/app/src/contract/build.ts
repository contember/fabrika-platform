// `buildArtifact`: a described contract and its table policies → the normalized `ContractArtifact`. Every check
// the types cannot make, every default and every generated endpoint is here, once.

import {
	type AccessForm,
	assertNoAmbiguity,
	type BodyAdmission,
	BUILTIN_ROLE_KEYS,
	type Caller,
	canonicalizeArtifact,
	type ContractArtifact,
	type CspExtensions,
	type CspSource,
	type DimensionArtifact,
	type EndpointRequirement,
	type EndpointRow,
	type EndpointSource,
	type ExportArtifact,
	type FileCollectionArtifact,
	type ImportArtifact,
	type JobArtifact,
	type MountArtifact,
	type RoleArtifact,
	type SchemaShape,
	type ScopeBinding,
	type TablePolicyArtifact,
} from '@fabrika/auth-core'
import { isPolicyOrigin, MAX_CSP_ORIGINS } from '@fabrika/proxy-core/headers'
import { contractArtifactSchema } from './artifact-schema'
import {
	type AccessDeclaration,
	type Builder,
	BUILDER_FIELDS,
	type ContractDeclaration,
	type CronDeclaration,
	type CspDeclaration,
	type ExportDeclaration,
	type FilesDeclaration,
	type ImportDeclaration,
	isProcedure,
	type LinkAccessDeclaration,
	type LinkMountDeclaration,
	type MountDeclaration,
	type ProcedureDeclaration,
	type ProcedureTreeDeclaration,
	type SpaAccessDeclaration,
} from './declaration'
import {
	CONNECT_LIMITS,
	CONNECT_PREFIX,
	CONTRACT_DEFAULTS,
	exportBase,
	FILES_PREFIX,
	joinPath,
	JSON_ADMISSION,
	LINK_API_SEGMENT,
	WEBHOOK_ACCOUNT_PATTERN,
	WEBHOOK_BINDING_PARAMETER,
	WEBHOOK_SCOPE_FIELD,
	WEBHOOKS_PREFIX,
} from './defaults'
import { ContractError, Problems } from './problems'

const APP_ID = /^[a-z0-9][a-z0-9-]*$/
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const DIMENSION = /^[a-z][A-Za-z0-9_]*$/
const ACTION = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/
/** Literal segments of unreserved URL characters, none starting with `.`: canonical without any decoding. */
const LITERAL_PATH = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/
const MIME_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/
const CRON_FIELD = /^[0-9*/,-]+$/
const TIMEOUT = /^[1-9][0-9]*[smh]$/
const DIGEST = /^sha256:[0-9a-f]+$/
const FRAMEWORK_PREFIX = '/__fabrika'
/** The `boundTo` and job `scope` value for the whole application; no dimension may take the name. */
const APP_SCOPE = 'app'
const AUDIENCE = 'any consumer user'
const IMPORT_FIELDS = ['app', 'export', 'version', 'digest', 'procedures', 'usedBy', 'timeoutMs']
const CSP_FIELDS = ['connectSrc', 'imgSrc', 'frameAncestors']

const UUID: SchemaShape = {
	type: 'string',
	format: 'uuid',
	minLength: null,
	maxLength: null,
	pattern: null,
	startsWith: null,
	endsWith: null,
	includes: null,
}
const ID_OBJECT: SchemaShape = { type: 'object', fields: { id: UUID } }
const TEXT: SchemaShape = { ...UUID, format: null, minLength: 1 }

/** The shapes of the generated webhook binding endpoints; `@fabrika/app/implement` parses with the same schemas. */
export const WEBHOOK_BIND_INPUT: SchemaShape = {
	type: 'object',
	fields: { [WEBHOOK_SCOPE_FIELD]: TEXT, account: { ...UUID, format: null, pattern: WEBHOOK_ACCOUNT_PATTERN } },
}
export const WEBHOOK_BIND_OUTPUT: SchemaShape = { type: 'object', fields: { id: UUID, url: TEXT, secret: TEXT } }
export const WEBHOOK_UNBIND_INPUT: SchemaShape = { type: 'object', fields: { [WEBHOOK_SCOPE_FIELD]: TEXT, id: UUID } }
export const WEBHOOK_UNBIND_OUTPUT: SchemaShape = ID_OBJECT

/** Validates a described contract against its table policies and normalizes it; throws `ContractError` with every problem. */
export function buildArtifact(contract: ContractDeclaration<SchemaShape>, tables: Readonly<Record<string, TablePolicyArtifact>>): ContractArtifact {
	const problems = new Problems()
	const artifact = canonicalizeArtifact(new ArtifactBuilder(contract, tables, problems).build())
	problems.throwIfAny()
	// A check missing above must surface here, not in the proxy or Control that reads the artifact later.
	const parsed = contractArtifactSchema.safeParse(JSON.parse(JSON.stringify(artifact)))
	if (!parsed.success) {
		throw new ContractError(parsed.error.issues.map((issue) => `artifact ${issue.path.map(String).join('.')}: ${issue.message}`))
	}
	return parsed.data
}

class ArtifactBuilder {
	readonly #contract: ContractDeclaration<SchemaShape>
	readonly #tables: Readonly<Record<string, TablePolicyArtifact>>
	readonly #problems: Problems
	readonly #endpoints: EndpointRow[] = []
	readonly #reservedPrefixes: string[] = []

	constructor(contract: ContractDeclaration<SchemaShape>, tables: Readonly<Record<string, TablePolicyArtifact>>, problems: Problems) {
		this.#contract = contract
		this.#tables = tables
		this.#problems = problems
	}

	build(): ContractArtifact {
		const contract = this.#contract
		if (!APP_ID.test(contract.app)) {
			this.#problem('app', `'${contract.app}' is not an application id (allowed: ${APP_ID.source})`)
		}
		const actions = this.#actions()
		const dimensions = this.#dimensions()
		const roles = this.#roles()
		const mounts: Record<string, MountArtifact> = {}
		for (const [name, mount] of Object.entries(contract.mounts)) {
			if (this.#name(`mount '${name}'`, name)) {
				const artifact = this.#mount(name, mount)
				if (artifact !== null) {
					mounts[name] = artifact
				}
			}
		}
		const files = this.#files(dimensions)
		const jobs = this.#jobs()
		const exports = this.#exports()
		const imports = this.#imports()
		const csp = this.#csp(contract.csp)
		const tables = this.#checkTables()
		this.#reserve(this.#endpoints.some((row) => row.source.kind === 'files') ? FILES_PREFIX : null)
		this.#reserve(this.#endpoints.some((row) => row.source.kind === 'export') ? CONNECT_PREFIX : null)
		const artifact: ContractArtifact = {
			app: contract.app,
			dimensions,
			actions,
			roles,
			mounts,
			files,
			jobs,
			exports,
			imports,
			csp,
			tables,
			endpoints: this.#endpoints,
			reservedPrefixes: this.#reservedPrefixes,
		}
		try {
			assertNoAmbiguity(artifact)
		} catch (error) {
			this.#problem('endpoints', error instanceof Error ? error.message : String(error))
		}
		return artifact
	}

	// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────

	#actions(): Record<string, string> {
		const actions: Record<string, string> = {}
		for (const [action, description] of Object.entries(this.#contract.actions)) {
			if (!ACTION.test(action)) {
				this.#problem(`action '${action}'`, `an action is exact, dot-separated words (allowed: 'notes.read'; no '*')`)
			}
			if (description.trim() === '') {
				this.#problem(`action '${action}'`, 'needs a description, which IAM shows to the people who grant it')
			}
			actions[action] = description
		}
		return actions
	}

	#dimensions(): Record<string, DimensionArtifact> {
		const dimensions: Record<string, DimensionArtifact> = {}
		const declared = this.#contract.dimensions
		for (const [name, dimension] of Object.entries(declared)) {
			const where = `dimension '${name}'`
			if (!DIMENSION.test(name) || name === APP_SCOPE) {
				this.#problem(where, `is not a dimension name (allowed: ${DIMENSION.source}, not '${APP_SCOPE}')`)
			}
			if (dimension.in !== undefined && !Object.hasOwn(declared, dimension.in)) {
				this.#problem(where, `lies in '${dimension.in}', which is not a dimension of the contract`)
			}
			if (dimension.creator !== undefined) {
				const role = this.#contract.roles[dimension.creator]
				if (role?.member?.scope !== name) {
					this.#problem(where, `its creator '${dimension.creator}' must be a membership role of '${name}' (member: { scope: '${name}', … })`)
				}
			}
			if (dimension.members !== undefined) {
				this.#knownAction(`${where} members.manage`, dimension.members.manage)
				this.#knownAction(`${where} members.list`, dimension.members.list)
			}
			dimensions[name] = {
				in: dimension.in ?? null,
				creator: dimension.creator ?? null,
				members: dimension.members === undefined ? null : { manage: dimension.members.manage, list: dimension.members.list },
			}
		}
		for (const name of Object.keys(declared)) {
			const chain = [name]
			let parent = declared[name]?.in
			while (parent !== undefined && !chain.includes(parent)) {
				chain.push(parent)
				parent = declared[parent]?.in
			}
			if (parent !== undefined) {
				this.#problem(`dimension '${name}'`, `its containment is a cycle (${[...chain, parent].join(' → ')})`)
			}
		}
		return dimensions
	}

	#roles(): Record<string, RoleArtifact> {
		const roles: Record<string, RoleArtifact> = {}
		for (const [name, role] of Object.entries(this.#contract.roles)) {
			const where = `role '${name}'`
			this.#name(where, name)
			if (BUILTIN_ROLE_KEYS.includes(name)) {
				this.#problem(where, `is a role IAM defines itself for every application (reserved: ${BUILTIN_ROLE_KEYS.join(', ')}); choose another name`)
			}
			if (role.grants.length === 0) {
				this.#problem(where, 'grants nothing (allowed: grants: [<exact actions>])')
			}
			this.#unique(where, 'grants', role.grants)
			for (const action of role.grants) {
				this.#knownAction(where, action)
			}
			if (role.member !== undefined) {
				const scope = role.member.scope
				if (!Object.hasOwn(this.#contract.dimensions, scope)) {
					this.#problem(where, `is a membership role of '${scope}', which is not a dimension of the contract`)
				}
				for (const assigner of role.member.assignableBy) {
					if (this.#contract.roles[assigner]?.member?.scope !== scope) {
						this.#problem(where, `is assignable by '${assigner}', which is not a membership role of '${scope}'`)
					}
				}
			}
			roles[name] = {
				grants: [...role.grants],
				member: role.member === undefined ? null : { scope: role.member.scope, assignableBy: [...role.member.assignableBy] },
			}
		}
		return roles
	}

	// ── Mounts ──────────────────────────────────────────────────────────────────────────────────

	#mount(name: string, mount: MountDeclaration<SchemaShape>): MountArtifact | null {
		const where = `mount '${name}'`
		if (mount.kind !== 'health') {
			this.#options(where, mount.kind, mount.unknownOptions)
		}
		switch (mount.kind) {
			case 'rpc': {
				this.#prefix(where, mount.prefix)
				this.#callers(where, mount.callers)
				this.#reserve(mount.prefix)
				for (const [path, procedure] of procedures(mount.procedures)) {
					this.#procedure({ kind: 'mount', name }, `${name}.${path}`, joinPath(mount.prefix, path), mount.callers, procedure)
				}
				return { kind: 'rpc', prefix: mount.prefix, callers: mount.callers }
			}
			case 'link':
				return this.#link(name, mount)
			case 'spa': {
				if (mount.prefix !== '/') {
					this.#prefix(where, mount.prefix)
				}
				this.#nonEmpty(`${where} dir`, mount.dir)
				const requirement = this.#spaRequirement(where, mount.access)
				if (requirement !== null) {
					this.#row({
						id: name,
						source: { kind: 'mount', name },
						kind: 'spa',
						method: 'GET',
						path: joinPath(mount.prefix, '*'),
						callers: ['human'],
						requirement,
						admission: null,
						input: null,
						output: null,
					})
				}
				return { kind: 'spa', prefix: mount.prefix, dir: mount.dir }
			}
			case 'health':
				this.#prefix(where, mount.path)
				this.#anonymous(name, 'health', 'GET', mount.path, null, null)
				return { kind: 'health', path: mount.path }
			case 'form':
				this.#prefix(where, mount.path)
				this.#objectSchema(`${where} input`, mount.input)
				this.#nonEmpty(`${where} appendTo`, mount.appendTo)
				this.#anonymous(name, 'form', 'POST', mount.path, this.#bodyLimit(where, mount.maxBytes, CONTRACT_DEFAULTS.formMaxBytes), mount.input)
				return { kind: 'form', path: mount.path, appendTo: mount.appendTo }
			case 'webhook': {
				this.#prefix(where, mount.path)
				this.#objectSchema(`${where} input`, mount.input)
				const boundTo = this.#scopeBinding(where, 'boundTo', mount.boundTo)
				const members = boundTo?.kind === 'dimension' ? this.#contract.dimensions[boundTo.dimension]?.members : undefined
				if (boundTo?.kind === 'dimension' && members === undefined) {
					this.#problem(where, `is bound to '${boundTo.dimension}', which declares no members: { manage, list } to create bindings with`)
				}
				this.#actionList(where, mount.actions)
				const path = joinPath(mount.path, `:${WEBHOOK_BINDING_PARAMETER}`)
				this.#anonymous(name, 'webhook', 'POST', path, this.#bodyLimit(where, mount.maxBytes, CONTRACT_DEFAULTS.webhookMaxBytes), mount.input)
				if (boundTo?.kind === 'dimension' && members !== undefined) {
					this.#webhookBindings(name, boundTo.dimension, members.manage)
				}
				return boundTo === null ? null : { kind: 'webhook', path: mount.path, scheme: mount.scheme, boundTo, actions: [...mount.actions] }
			}
			default:
				this.#problem(where, 'is not a mount (allowed: c.rpc, c.link, c.spa, c.health, c.form or c.webhook)')
				return null
		}
	}

	/** A holder of the dimension's `members.manage` there binds a provider account to one value, and unbinds it. */
	#webhookBindings(name: string, dimension: string, manage: string): void {
		const access: AccessForm = { form: 'in', dimension, from: WEBHOOK_SCOPE_FIELD }
		const binding = (operation: 'bind' | 'unbind', input: SchemaShape, output: SchemaShape): EndpointRow => ({
			id: `webhooks.${name}.${operation}`,
			source: { kind: 'mount', name },
			kind: 'mutation',
			method: 'POST',
			path: joinPath(WEBHOOKS_PREFIX, `webhooks.${name}.${operation}`),
			callers: ['human'],
			requirement: { kind: 'action', action: manage, access },
			admission: JSON_ADMISSION,
			input,
			output,
		})
		this.#row(binding('bind', WEBHOOK_BIND_INPUT, WEBHOOK_BIND_OUTPUT))
		this.#row(binding('unbind', WEBHOOK_UNBIND_INPUT, WEBHOOK_UNBIND_OUTPUT))
		this.#reserve(WEBHOOKS_PREFIX)
	}

	#link(name: string, mount: LinkMountDeclaration<SchemaShape>): MountArtifact {
		const where = `mount '${name}'`
		this.#prefix(where, mount.prefix)
		this.#nonEmpty(`${where} spa`, mount.spa)
		this.#knownDimension(where, mount.dimension)
		if (mount.grants.length === 0) {
			this.#problem(where, 'grants nothing (allowed: grants: [<exact actions>])')
		}
		this.#unique(where, 'grants', mount.grants)
		this.#actionList(where, mount.grants)
		this.#knownAction(`${where} issuedBy`, mount.issuedBy)
		if (!Number.isInteger(mount.maxDays) || mount.maxDays < 1) {
			this.#problem(where, `maxDays ${mount.maxDays} is not a positive whole number of days`)
		}
		this.#row({
			id: name,
			source: { kind: 'mount', name },
			kind: 'link-spa',
			method: 'GET',
			path: joinPath(mount.prefix, '*'),
			callers: [],
			requirement: null,
			admission: null,
			input: null,
			output: null,
		})
		const api = joinPath(mount.prefix, LINK_API_SEGMENT)
		this.#reserve(api)
		for (const [path, procedure] of procedures(mount.procedures)) {
			const id = `${name}.${path}`
			const requirement = this.#linkRequirement(`procedure '${id}'`, procedure.access, mount)
			this.#procedureSchemas(`procedure '${id}'`, procedure)
			if (requirement !== null) {
				this.#row({
					id,
					source: { kind: 'mount', name },
					kind: procedure.type,
					method: 'POST',
					path: joinPath(api, path),
					callers: ['link'],
					requirement,
					admission: JSON_ADMISSION,
					input: procedure.input,
					output: procedure.output,
				})
			}
		}
		return {
			kind: 'link',
			prefix: mount.prefix,
			spa: mount.spa,
			dimension: mount.dimension,
			grants: [...mount.grants],
			issuedBy: mount.issuedBy,
			maxDays: mount.maxDays,
		}
	}

	#procedure(
		source: EndpointSource,
		id: string,
		path: string,
		callers: readonly [Caller, ...Caller[]],
		procedure: ProcedureDeclaration<SchemaShape>,
	): void {
		const where = `procedure '${id}'`
		this.#procedureSchemas(where, procedure)
		const requirement = this.#requirement(where, procedure)
		if (requirement !== null) {
			this.#row({
				id,
				source,
				kind: procedure.type,
				method: 'POST',
				path,
				callers,
				requirement,
				admission: JSON_ADMISSION,
				input: procedure.input,
				output: procedure.output,
			})
		}
	}

	#procedureSchemas(where: string, procedure: ProcedureDeclaration<SchemaShape, unknown>): void {
		this.#options(where, 'procedure', procedure.unknownOptions)
		if (procedure.type !== 'query' && procedure.type !== 'mutation') {
			this.#problem(where, `is not a procedure (allowed: c.query or c.mutation)`)
		}
		if (procedure.input !== null) {
			this.#objectSchema(`${where} input`, procedure.input)
		}
	}

	#anonymous(
		name: string,
		kind: 'health' | 'form' | 'webhook',
		method: 'GET' | 'POST',
		path: string,
		admission: BodyAdmission | null,
		input: SchemaShape | null,
	): void {
		this.#row({ id: name, source: { kind: 'mount', name }, kind, method, path, callers: [], requirement: null, admission, input, output: null })
	}

	#row(row: EndpointRow): void {
		this.#endpoints.push(row)
	}

	#reserve(prefix: string | null): void {
		if (prefix !== null && !this.#reservedPrefixes.includes(prefix)) {
			this.#reservedPrefixes.push(prefix)
		}
	}

	// ── Requirements ────────────────────────────────────────────────────────────────────────────

	#requirement(where: string, procedure: ProcedureDeclaration<SchemaShape>): EndpointRequirement | null {
		const access: AccessDeclaration = procedure.access
		const form = accessForm(access)
		if (form === null) {
			this.#problem(
				where,
				`access ${
					JSON.stringify(access)
				} is not one access form (allowed: { member: true }, { action, over }, { action, in, from }, { action, on, from }, { action, creates })`,
			)
			return null
		}
		if (form.form === 'member') {
			return { kind: 'member' }
		}
		this.#knownAction(where, form.action)
		this.#knownDimension(where, form.access.dimension)
		if ('from' in access) {
			this.#fromField(where, procedure.input, access.from)
		}
		if (form.access.form === 'creates') {
			if (procedure.type !== 'mutation') {
				this.#problem(where, `creates a '${form.access.dimension}' in a query (allowed: c.mutation)`)
			}
			const created = this.#contract.dimensions[form.access.dimension]
			if (created?.creator === undefined) {
				this.#problem(where, `creates a '${form.access.dimension}', which declares no creator role`)
			}
			if (created?.in !== undefined) {
				this.#problem(
					where,
					`creates a '${form.access.dimension}', which lies in '${created.in}' (allowed: a dimension without in; a contained value is a row a store inserts)`,
				)
			}
		}
		return { kind: 'action', action: form.action, access: form.access }
	}

	#linkRequirement(where: string, access: LinkAccessDeclaration, mount: LinkMountDeclaration<SchemaShape>): EndpointRequirement | null {
		if (!hasExactKeys(access, ['action'])) {
			this.#problem(where, `access ${JSON.stringify(access)} is not a link access (allowed: { action: <one of the link's grants> })`)
			return null
		}
		if (!mount.grants.includes(access.action)) {
			this.#problem(where, `needs '${access.action}', which the link does not grant (grants: ${mount.grants.join(', ')})`)
		}
		return { kind: 'action', action: access.action, access: { form: 'on', dimension: mount.dimension, from: null } }
	}

	#spaRequirement(where: string, access: SpaAccessDeclaration): EndpointRequirement | null {
		if (hasExactKeys(access, ['member']) && 'member' in access && access.member === true) {
			return { kind: 'member' }
		}
		if (hasExactKeys(access, ['action', 'over']) && 'over' in access) {
			this.#knownAction(where, access.action)
			this.#knownDimension(where, access.over)
			return { kind: 'action', action: access.action, access: { form: 'over', dimension: access.over } }
		}
		this.#problem(where, `access ${JSON.stringify(access)} is not an SPA access (allowed: { member: true } or { action, over })`)
		return null
	}

	/** `from` must name a required string field of the input, which the framework removes before the handler. */
	#fromField(where: string, input: SchemaShape | null, from: string): void {
		const field = input?.type === 'object' ? input.fields[from] : undefined
		if (field === undefined || !isRequiredString(field)) {
			this.#problem(where, `access.from '${from}' is not a required string field of the input (allowed: a string, a string literal or an enum)`)
		}
	}

	#scopeBinding(where: string, field: string, value: string): ScopeBinding | null {
		if (value === APP_SCOPE) {
			return { kind: 'app' }
		}
		if (!Object.hasOwn(this.#contract.dimensions, value)) {
			this.#problem(where, `${field} '${value}' is neither '${APP_SCOPE}' nor a dimension of the contract`)
			return null
		}
		return { kind: 'dimension', dimension: value }
	}

	// ── Sections ────────────────────────────────────────────────────────────────────────────────

	#files(dimensions: Record<string, DimensionArtifact>): Record<string, FileCollectionArtifact> {
		const files: Record<string, FileCollectionArtifact> = {}
		for (const [name, collection] of Object.entries(this.#contract.files)) {
			const where = `files '${name}'`
			if (!this.#name(where, name) || !this.#kind(where, collection, 'files', 'c.files({ … })')) {
				continue
			}
			const artifact = this.#fileCollection(where, collection)
			const owner = this.#tables[collection.owner]
			if (owner?.scope.mode !== 'dimension') {
				this.#problem(where, `its owner '${collection.owner}' is not a table with a dimension scope in src/db/tables.ts`)
				continue
			}
			const dimension = `file:${name}`
			dimensions[dimension] = { in: owner.scope.dimension, creator: null, members: null }
			files[name] = artifact
			const source: EndpointSource = { kind: 'files', name }
			const base = joinPath(FILES_PREFIX, `files.${name}`)
			const [firstType, ...otherTypes] = collection.types
			if (firstType !== undefined) {
				this.#row({
					id: `files.${name}.upload`,
					source,
					kind: 'upload',
					method: 'POST',
					path: `${base}.upload/:owner`,
					callers: ['human'],
					requirement: { kind: 'action', action: collection.write, access: { form: 'on', dimension: owner.scope.dimension, from: 'owner' } },
					admission: { contentTypes: [firstType, ...otherTypes], maxBytes: collection.maxBytes },
					input: null,
					output: ID_OBJECT,
				})
			}
			this.#row({
				id: `files.${name}.download`,
				source,
				kind: 'download',
				method: 'GET',
				path: `${base}/:fileId`,
				callers: ['human'],
				requirement: { kind: 'action', action: collection.read, access: { form: 'on', dimension, from: 'fileId' } },
				admission: null,
				input: null,
				output: null,
			})
			this.#row({
				id: `files.${name}.remove`,
				source,
				kind: 'mutation',
				method: 'POST',
				path: `${base}.remove`,
				callers: ['human'],
				requirement: { kind: 'action', action: collection.delete, access: { form: 'on', dimension, from: 'id' } },
				admission: JSON_ADMISSION,
				input: ID_OBJECT,
				output: ID_OBJECT,
			})
		}
		return files
	}

	#fileCollection(where: string, collection: FilesDeclaration): FileCollectionArtifact {
		this.#options(where, 'files', collection.unknownOptions)
		this.#knownAction(`${where} read`, collection.read)
		this.#knownAction(`${where} write`, collection.write)
		this.#knownAction(`${where} delete`, collection.delete)
		this.#positiveInteger(`${where} maxBytes`, collection.maxBytes)
		if (collection.maxPerOwner !== undefined) {
			this.#positiveInteger(`${where} maxPerOwner`, collection.maxPerOwner)
		}
		this.#unique(where, 'types', collection.types)
		for (const type of collection.types) {
			if (!MIME_TYPE.test(type)) {
				this.#problem(where, `'${type}' is not an exact media type (allowed: 'image/png'; no wildcards or parameters)`)
			}
		}
		if (collection.types.length === 0) {
			this.#problem(where, 'admits no media type (allowed: types: [<exact media types>])')
		}
		return {
			owner: collection.owner,
			read: collection.read,
			write: collection.write,
			delete: collection.delete,
			maxBytes: collection.maxBytes,
			types: [...collection.types],
			maxPerOwner: collection.maxPerOwner ?? CONTRACT_DEFAULTS.fileMaxPerOwner,
			link: collection.link ?? CONTRACT_DEFAULTS.fileLink,
		}
	}

	#jobs(): Record<string, JobArtifact> {
		const jobs: Record<string, JobArtifact> = {}
		for (const [name, job] of Object.entries(this.#contract.jobs)) {
			const where = `job '${name}'`
			if (!this.#name(where, name) || !this.#kind(where, job, 'cron', "c.cron('<schedule>', { … })")) {
				continue
			}
			const scope = this.#job(where, job)
			if (scope !== null) {
				jobs[name] = {
					schedule: job.schedule,
					actions: [...job.actions],
					scope,
					timeout: job.timeout ?? null,
					retries: job.retries ?? CONTRACT_DEFAULTS.jobRetries,
				}
			}
		}
		return jobs
	}

	#job(where: string, job: CronDeclaration): ScopeBinding | null {
		this.#options(where, 'cron', job.unknownOptions)
		const fields = job.schedule.split(' ')
		if (fields.length !== 5 || !fields.every((field) => CRON_FIELD.test(field))) {
			this.#problem(where, `schedule '${job.schedule}' is not five cron fields separated by single spaces (allowed: '0 3 * * *')`)
		}
		this.#actionList(where, job.actions)
		if (job.timeout !== undefined && !TIMEOUT.test(job.timeout)) {
			this.#problem(where, `timeout '${job.timeout}' is not a duration (allowed: '30s', '10m', '1h')`)
		}
		if (job.retries !== undefined && (!Number.isInteger(job.retries) || job.retries < 0)) {
			this.#problem(where, `retries ${job.retries} is not a whole number of at least 0`)
		}
		return this.#scopeBinding(where, 'scope', job.scope)
	}

	#exports(): Record<string, ExportArtifact> {
		const exports: Record<string, ExportArtifact> = {}
		for (const [name, declaration] of Object.entries(this.#contract.exports)) {
			const where = `export '${name}'`
			if (!this.#name(where, name) || !this.#kind(where, declaration, 'export', 'c.export({ … })')) {
				continue
			}
			const callers = this.#consumers(where, declaration)
			exports[name] = { version: declaration.version, consumers: [...declaration.consumers], audience: declaration.audience }
			if (callers === null) {
				continue
			}
			const source: EndpointSource = { kind: 'export', name }
			const base = exportBase(name, declaration.version)
			for (const [path, procedure] of procedures(declaration.procedures)) {
				const id = `${base}.${path}`
				if (procedure.type !== 'query') {
					this.#problem(`procedure '${id}'`, 'an export serves queries only (allowed: c.query)')
				}
				this.#readAction(`procedure '${id}'`, procedure.access)
				this.#procedure(source, id, joinPath(CONNECT_PREFIX, id), callers, procedure)
			}
			const requirement = this.#descriptionRequirement(where, base)
			if (requirement !== null) {
				// The description a consumer vendors, behind the callers and the action of the procedures it describes.
				this.#row({
					id: base,
					source,
					kind: 'query',
					method: 'POST',
					path: joinPath(CONNECT_PREFIX, base),
					callers,
					requirement,
					admission: JSON_ADMISSION,
					input: null,
					output: null,
				})
			}
		}
		return exports
	}

	/**
	 * The requirement of an export's description: the one requirement its procedures share. A description shows every
	 * procedure, so it needs what each procedure needs; v1 exports declare one action, in one dimension, for all of them.
	 */
	#descriptionRequirement(where: string, base: string): EndpointRequirement | null {
		const requirements = this.#endpoints.filter((row) => row.id.startsWith(`${base}.`)).map((row) => row.requirement)
		const [first] = requirements
		if (first === undefined || first === null) {
			this.#problem(where, 'exports no procedure (allowed: procedures: { <name>: c.query({ … }) })')
			return null
		}
		const description: EndpointRequirement = first.kind === 'member'
			? first
			: { kind: 'action', action: first.action, access: { form: 'over', dimension: first.access.dimension } }
		const same = requirements.every((requirement) =>
			requirement !== null && (requirement.kind === 'member'
				? description.kind === 'member'
				: description.kind === 'action' && requirement.action === description.action
					&& requirement.access.dimension === description.access.dimension)
		)
		if (!same) {
			this.#problem(where, 'its procedures need different actions or dimensions (allowed: one action in one dimension for every procedure of an export)')
			return null
		}
		return description
	}

	/** An export runs read-only, so its action may not be one a table writes with, nor one that manages members. */
	#readAction(where: string, access: AccessDeclaration): void {
		if (!('action' in access)) {
			return
		}
		for (const [table, policy] of Object.entries(this.#tables)) {
			const { insert, update, delete: remove } = policy.actions
			if (access.action === insert || access.action === update || access.action === remove) {
				this.#problem(where, `'${access.action}' writes table '${table}'; an export reads only (allowed: a read action)`)
			}
		}
		for (const [dimension, declared] of Object.entries(this.#contract.dimensions)) {
			if (declared.members?.manage === access.action) {
				this.#problem(where, `'${access.action}' manages the members of '${dimension}'; an export reads only (allowed: a read action)`)
			}
		}
	}

	#consumers(where: string, declaration: ExportDeclaration<SchemaShape>): readonly [Caller, ...Caller[]] | null {
		this.#options(where, 'export', declaration.unknownOptions)
		this.#positiveInteger(`${where} version`, declaration.version)
		if (declaration.audience !== AUDIENCE) {
			this.#problem(where, `audience '${declaration.audience}' is not supported (allowed: '${AUDIENCE}')`)
		}
		this.#unique(where, 'consumers', declaration.consumers)
		for (const consumer of declaration.consumers) {
			if (!APP_ID.test(consumer) || consumer === this.#contract.app) {
				this.#problem(where, `consumer '${consumer}' is not another application's id`)
			}
		}
		if (declaration.consumers.length === 0) {
			this.#problem(where, 'names no consumer (allowed: consumers: [<application ids>]; there is no wildcard)')
			return null
		}
		const [first, ...rest] = declaration.consumers.map((consumer): Caller => `app:${consumer}`)
		return first === undefined ? null : [first, ...rest]
	}

	#imports(): Record<string, ImportArtifact> {
		const imports: Record<string, ImportArtifact> = {}
		const procedureIds = new Set(
			this.#endpoints.filter((row) => row.source.kind === 'mount' && (row.kind === 'query' || row.kind === 'mutation')).map((row) => row.id),
		)
		for (const [name, declaration] of Object.entries(this.#contract.imports)) {
			const where = `import '${name}'`
			if (!this.#name(where, name)) {
				continue
			}
			this.#import(where, declaration, procedureIds)
			imports[name] = {
				app: declaration.app,
				export: declaration.export,
				version: declaration.version,
				digest: declaration.digest,
				procedures: [...declaration.procedures],
				usedBy: [...declaration.usedBy],
				timeoutMs: declaration.timeoutMs ?? CONTRACT_DEFAULTS.importTimeoutMs,
			}
		}
		return imports
	}

	#import(where: string, declaration: ImportDeclaration, procedureIds: ReadonlySet<string>): void {
		this.#keys(where, declaration, IMPORT_FIELDS)
		if (!APP_ID.test(declaration.app) || declaration.app === this.#contract.app) {
			this.#problem(where, `app '${declaration.app}' is not another application's id`)
		}
		this.#name(`${where} export`, declaration.export)
		this.#positiveInteger(`${where} version`, declaration.version)
		if (!DIGEST.test(declaration.digest)) {
			this.#problem(where, `digest '${declaration.digest}' is not the snapshot's digest (allowed: 'sha256:<hex>', as fabrika connect add writes it)`)
		}
		if (declaration.procedures.length === 0) {
			this.#problem(where, 'imports no procedure (allowed: procedures: [<names of the export>])')
		}
		this.#unique(where, 'procedures', declaration.procedures)
		if (declaration.usedBy.length === 0) {
			this.#problem(where, 'is used by no endpoint (allowed: usedBy: [<procedure ids of this contract>])')
		}
		this.#unique(where, 'usedBy', declaration.usedBy)
		for (const id of declaration.usedBy) {
			if (!procedureIds.has(id)) {
				this.#problem(where, `usedBy '${id}' is not a procedure of this contract (allowed: an id such as 'api.products.show')`)
			}
		}
		if (declaration.timeoutMs !== undefined) {
			this.#positiveInteger(`${where} timeoutMs`, declaration.timeoutMs)
			if (declaration.timeoutMs > CONNECT_LIMITS.maxTimeoutMs) {
				this.#problem(where, `timeoutMs ${declaration.timeoutMs} is above the ${CONNECT_LIMITS.maxTimeoutMs} ms every connector call is bounded by`)
			}
		}
	}

	#csp(declaration: CspDeclaration): CspExtensions {
		this.#keys('csp', declaration, CSP_FIELDS)
		return {
			connectSrc: this.#cspSources('csp connectSrc', declaration.connectSrc ?? []),
			imgSrc: this.#cspSources('csp imgSrc', declaration.imgSrc ?? []),
			frameAncestors: this.#cspSources('csp frameAncestors', declaration.frameAncestors ?? []),
		}
	}

	#cspSources(where: string, sources: readonly CspSource[]): CspSource[] {
		if (sources.length > MAX_CSP_ORIGINS) {
			this.#problem(where, `${sources.length} origins exceed the limit of ${MAX_CSP_ORIGINS}`)
		}
		for (const source of sources) {
			this.#keys(where, source, ['origin', 'purpose'])
			if (!isPolicyOrigin(source.origin)) {
				this.#problem(where, `'${source.origin}' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)`)
			}
			this.#nonEmpty(`${where} '${source.origin}' purpose`, source.purpose)
		}
		this.#unique(where, 'origins', sources.map((source) => source.origin))
		return sources.map((source) => ({ origin: source.origin, purpose: source.purpose }))
	}

	// ── Table policies ──────────────────────────────────────────────────────────────────────────

	#checkTables(): Record<string, TablePolicyArtifact> {
		const owners = new Map<string, string>()
		const memberActions = new Set(Object.values(this.#contract.roles).flatMap((role) => role.member === undefined ? [] : role.grants))
		const tables: Record<string, TablePolicyArtifact> = {}
		for (const [name, table] of Object.entries(this.#tables)) {
			const where = `table '${name}'`
			const { read, insert, update, delete: remove } = table.actions
			for (const action of [read, insert, update, remove]) {
				if (action !== null) {
					this.#knownAction(where, action)
				}
			}
			const scope = table.scope
			if (scope.mode === 'dimension') {
				const dimension = this.#contract.dimensions[scope.dimension]
				if (dimension === undefined) {
					this.#problem(where, `is scoped by '${scope.dimension}', which is not a dimension of the contract`)
				} else if ((dimension.in ?? null) !== (scope.container?.dimension ?? null)) {
					this.#problem(
						where,
						`lies in '${scope.container?.dimension ?? 'nothing'}', but the contract puts '${scope.dimension}' in '${dimension.in ?? 'nothing'}'`,
					)
				}
				const owner = owners.get(scope.dimension)
				if (owner !== undefined) {
					this.#problem(where, `dimension '${scope.dimension}' is already owned by table '${owner}'`)
				}
				owners.set(scope.dimension, name)
			} else if (scope.mode === 'child') {
				if (this.#tables[scope.parent]?.scope.mode !== 'dimension') {
					this.#problem(where, `its parent '${scope.parent}' is not a table with a dimension scope`)
				}
			} else if (scope.mode === 'inbox') {
				const form = this.#contract.mounts[scope.form]
				if (form?.kind !== 'form' || form.appendTo !== name) {
					this.#problem(where, `is the inbox of '${scope.form}', which is not a c.form mount that appends to '${name}'`)
				}
				if (memberActions.has(read)) {
					this.#problem(where, `its read action '${read}' is granted by a membership role (allowed: an action only application-level roles grant)`)
				}
			}
			tables[name] = table
		}
		for (const [name, mount] of Object.entries(this.#contract.mounts)) {
			if (mount.kind === 'form') {
				const inbox = this.#tables[mount.appendTo]?.scope
				if (inbox?.mode !== 'inbox' || inbox.form !== name) {
					this.#problem(`mount '${name}'`, `appends to '${mount.appendTo}', which is not an inbox table of this form (scope: { inbox: '${name}', … })`)
				}
			}
		}
		return tables
	}

	// ── Shared checks ───────────────────────────────────────────────────────────────────────────

	#problem(where: string, problem: string): void {
		this.#problems.add(where, problem)
	}

	#options(where: string, builder: Builder, unknown: readonly string[] | undefined): void {
		const fields = BUILDER_FIELDS[builder]
		const call = builder === 'procedure' ? 'c.query and c.mutation' : `c.${builder}`
		for (const key of unknown ?? []) {
			if (fields.owned.includes(key)) {
				this.#problem(where, `'${key}' is set by ${call} itself and cannot be an option; remove it`)
			} else {
				this.#problem(where, `'${key}' is not an option of ${call} (allowed: ${fields.options.join(', ')})`)
			}
		}
	}

	#keys(where: string, value: object, allowed: readonly string[]): void {
		for (const key of Object.keys(value)) {
			if (!allowed.includes(key)) {
				this.#problem(where, `'${key}' is not a field here (allowed: ${allowed.join(', ')})`)
			}
		}
	}

	#callers(where: string, callers: readonly string[]): void {
		this.#unique(where, 'callers', callers)
		for (const caller of callers) {
			if (caller.startsWith('app:')) {
				this.#problem(where, `'${caller}' reaches only an export; declare an export with consumers: ['${caller.slice('app:'.length)}'] instead`)
			} else if (caller !== 'human' && caller !== 'machine') {
				this.#problem(where, `'${caller}' is not a caller of an RPC mount (allowed: 'human' or 'machine')`)
			}
		}
	}

	#name(where: string, name: string): boolean {
		if (NAME.test(name)) {
			return true
		}
		this.#problem(where, `is not a name (allowed: ${NAME.source}; a '.' joins names into ids and paths)`)
		return false
	}

	#kind<K extends string>(where: string, value: { readonly kind: string }, kind: K, allowed: string): boolean {
		if (value.kind === kind) {
			return true
		}
		this.#problem(where, `is not built with ${allowed}`)
		return false
	}

	#knownAction(where: string, action: string): void {
		if (!Object.hasOwn(this.#contract.actions, action)) {
			this.#problem(where, `'${action}' is not an action of the contract${suggestion(action, Object.keys(this.#contract.actions))}`)
		}
	}

	#knownDimension(where: string, dimension: string): void {
		if (!Object.hasOwn(this.#contract.dimensions, dimension)) {
			this.#problem(where, `'${dimension}' is not a dimension of the contract${suggestion(dimension, Object.keys(this.#contract.dimensions))}`)
		}
	}

	#actionList(where: string, actions: readonly string[]): void {
		if (actions.length === 0) {
			this.#problem(where, 'names no action (allowed: actions: [<exact actions>])')
		}
		this.#unique(where, 'actions', actions)
		for (const action of actions) {
			this.#knownAction(where, action)
		}
	}

	#prefix(where: string, path: string): void {
		if (!LITERAL_PATH.test(path)) {
			this.#problem(where, `'${path}' is not a literal path (allowed: '/api', segments of letters, digits and '._~-', no trailing '/')`)
		} else if (path === FRAMEWORK_PREFIX || path.startsWith(`${FRAMEWORK_PREFIX}/`)) {
			this.#problem(where, `'${path}' is under ${FRAMEWORK_PREFIX}, which the framework reserves`)
		}
	}

	#objectSchema(where: string, schema: SchemaShape): void {
		if (schema.type !== 'object') {
			this.#problem(where, `is a ${schema.type} schema (allowed: z.strictObject({ … }))`)
		}
	}

	#bodyLimit(where: string, maxBytes: number | undefined, fallback: number): BodyAdmission {
		if (maxBytes !== undefined) {
			this.#positiveInteger(`${where} maxBytes`, maxBytes)
		}
		return { contentTypes: ['application/json'], maxBytes: maxBytes ?? fallback }
	}

	#positiveInteger(where: string, value: number): void {
		if (!Number.isSafeInteger(value) || value < 1) {
			this.#problem(where, `${value} is not a positive whole number`)
		}
	}

	#nonEmpty(where: string, value: string): void {
		if (value.trim() === '') {
			this.#problem(where, 'is empty')
		}
	}

	#unique(where: string, field: string, values: readonly string[]): void {
		const seen = new Set<string>()
		for (const value of values) {
			if (seen.has(value)) {
				this.#problem(where, `${field} lists '${value}' twice`)
			}
			seen.add(value)
		}
	}
}

type ResolvedAccess = { readonly form: 'member' } | { readonly form: 'action'; readonly action: string; readonly access: AccessForm }

/** The one access form the declaration spells, with exactly its keys; a mixture of two forms is none. */
function accessForm(access: AccessDeclaration): ResolvedAccess | null {
	if ('member' in access) {
		return hasExactKeys(access, ['member']) && access.member === true ? { form: 'member' } : null
	}
	if ('over' in access) {
		return hasExactKeys(access, ['action', 'over']) ? { form: 'action', action: access.action, access: { form: 'over', dimension: access.over } } : null
	}
	if ('in' in access) {
		return hasExactKeys(access, ['action', 'in', 'from'])
			? { form: 'action', action: access.action, access: { form: 'in', dimension: access.in, from: access.from } }
			: null
	}
	if ('on' in access) {
		return hasExactKeys(access, ['action', 'on', 'from'])
			? { form: 'action', action: access.action, access: { form: 'on', dimension: access.on, from: access.from } }
			: null
	}
	if ('creates' in access) {
		return hasExactKeys(access, ['action', 'creates'])
			? { form: 'action', action: access.action, access: { form: 'creates', dimension: access.creates } }
			: null
	}
	return null
}

/** A shape whose every admitted value is a string, so it can carry a scope value. */
function isRequiredString(shape: SchemaShape): boolean {
	switch (shape.type) {
		case 'string':
		case 'enum':
			return true
		case 'literal':
			return typeof shape.value === 'string'
		case 'union':
			return shape.options.length > 0 && shape.options.every(isRequiredString)
		default:
			return false
	}
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
	const own = Object.keys(value)
	return own.length === keys.length && keys.every((key) => own.includes(key))
}

/** Procedures of a tree with their dotted paths, in declaration order. */
function procedures<Access>(tree: ProcedureTreeDeclaration<SchemaShape, Access>, prefix = ''): [string, ProcedureDeclaration<SchemaShape, Access>][] {
	const found: [string, ProcedureDeclaration<SchemaShape, Access>][] = []
	for (const [name, node] of Object.entries(tree)) {
		const path = prefix === '' ? name : `${prefix}.${name}`
		if (isProcedure(node)) {
			found.push([path, node])
		} else {
			found.push(...procedures(node, path))
		}
	}
	return found
}

/** `' — did you mean 'notes.read'?'` for a name one or two edits from a known one. */
function suggestion(name: string, known: readonly string[]): string {
	const close = known.find((candidate) => editDistance(name, candidate) <= 2)
	return close === undefined ? '' : ` — did you mean '${close}'?`
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
	for (let i = 1; i <= a.length; i++) {
		const current = [i]
		for (let j = 1; j <= b.length; j++) {
			const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
			current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution))
		}
		previous = current
	}
	return previous[b.length] ?? 0
}
