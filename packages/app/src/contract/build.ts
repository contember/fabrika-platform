// `buildArtifact`: a described contract and its table policies → the normalized `ContractArtifact`. Every check
// the types cannot make, every default and every generated endpoint is here, once.

import {
	type AccessForm,
	type AdmissionRate,
	assertNoAmbiguity,
	type AttachmentFormat,
	type BodyAdmission,
	BUILTIN_ROLE_KEYS,
	type Caller,
	canonicalizeArtifact,
	type CapabilityAccessForm,
	type CapabilityRequirement,
	type ChallengeProvider,
	CONTRACT_FORMAT,
	type ContractArtifact,
	type CrossOriginForm,
	type CspExtensions,
	type CspSource,
	type DeclaredReach,
	type DimensionArtifact,
	directoryReach,
	displayNameProblem,
	type EndpointDirectory,
	type EndpointRequirement,
	type EndpointRow,
	type EndpointSource,
	type ExportArtifact,
	type FileCollectionArtifact,
	type FileKindArtifact,
	type FileShape,
	FORM_URLENCODED_TYPE,
	type FormChallenge,
	type FormFileArtifact,
	type FormMountArtifact,
	type FormRate,
	type ImportArtifact,
	isLocale,
	isMessageKind,
	isSchemaOutput,
	JOB_MAILERS,
	JOB_SITE_PREFIX,
	type JobArtifact,
	type JobMailer,
	type Locale,
	LOCALES,
	type MailTemplate,
	mailTemplateProblems,
	type MailTemplates,
	MESSAGE_KINDS,
	type MessageKind,
	type MountArtifact,
	type OutputShape,
	type ProcedureArtifact,
	type RoleArtifact,
	type SchemaShape,
	type ScopeBinding,
	tableActions,
	type TablePolicyArtifact,
	type TokenPurposeArtifact,
	type WebhookScheme,
} from '@fabrika/auth-core'
import type { InboxColumns } from '@fabrika/db/tables'
import { isPolicyOrigin, MAX_CSP_ORIGINS } from '@fabrika/proxy-core/headers'
import { z } from 'zod/v4'
import { contractArtifactSchema } from './artifact-schema'
import {
	type AccessDeclaration,
	type Builder,
	BUILDER_FIELDS,
	type CapabilityDeclaration,
	type ContractDeclaration,
	type CronDeclaration,
	type CspDeclaration,
	DECLARED_FIELDS,
	type ExportDeclaration,
	type FileKindDeclaration,
	type FilesDeclaration,
	type FormMountDeclaration,
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
	ATTACHMENT_LIMITS,
	CHALLENGE_ORIGINS,
	challengeAction,
	CONNECT_LIMITS,
	CONNECT_PREFIX,
	CONTRACT_DEFAULTS,
	exportBase,
	FILE_LIMITS,
	fileCollectionPaths,
	FILES_PREFIX,
	FORM_CHALLENGE_FIELD,
	FORM_FILE_LIMITS,
	FORM_INPUT_PART,
	FORM_LIMITS,
	FORM_MULTIPART_TYPE,
	JOB_LIMITS,
	joinPath,
	JSON_ADMISSION,
	LINK_API_SEGMENT,
	PROCEDURE_LIMITS,
	PUBLIC_MUTATION_RATE,
	spaPrefixRowId,
	WEBHOOK_ACCOUNT_PATTERN,
	WEBHOOK_BINDING_PARAMETER,
	WEBHOOK_LIMITS,
	WEBHOOK_SCOPE_FIELD,
	WEBHOOKS_PREFIX,
} from './defaults'
import { ContractError, Problems } from './problems'
import { TOKEN_MAX_DAYS } from './token'
import { hmacSchemeSchema, WEBHOOK_SCHEME_ALLOWED, webhookSchemeSchema } from './webhook-scheme'

const APP_ID = /^[a-z0-9][a-z0-9-]*$/
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const DIMENSION = /^[a-z][A-Za-z0-9_]*$/
const ACTION = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/
/** Literal segments of unreserved URL characters, none starting with `.`: canonical without any decoding. */
const LITERAL_PATH = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/
const MIME_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/
const CRON_FIELD = /^[0-9*/,-]+$/
const DIGEST = /^sha256:[0-9a-f]+$/
const FRAMEWORK_PREFIX = '/__fabrika'
/** A fixed name a header carries as it is: no path, no quoting, no extension but the format's. */
const ATTACHMENT_FILENAMES: Readonly<Record<AttachmentFormat, RegExp>> = {
	csv: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.csv$/,
	xlsx: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.xlsx$/,
}
/** The `boundTo` and job `scope` value for the whole application; no dimension may take the name. */
const APP_SCOPE = 'app'
const AUDIENCE = 'any consumer user'
const IMPORT_FIELDS = ['app', 'export', 'version', 'digest', 'procedures', 'usedBy', 'timeoutMs']
/** Tables the framework keeps in the application's schema; no site reaches them unscoped. */
const FRAMEWORK_TABLE_PREFIX = 'fabrika_'
/** The most origins one site calls: a site that reaches more is an integration hub, which a connector import serves. */
const MAX_EGRESS_ORIGINS = 16
const DECLARED_ALLOWED =
	"sql: 'read' | 'write', unscoped: { <table>: 'read' | 'write' }, connect: ['<import>'], issues: '<link mount>', then: '<cron job>', mailer: 'installation' | 'own', kicks: ['<cron job>'], binds: '<webhook>', signs: ['<token purpose>'], egress: ['https://<host>']"
const CSP_FIELDS = ['connectSrc', 'imgSrc', 'frameAncestors', 'scriptSrc', 'frameSrc', 'styleSrc', 'fontSrc']
/** An environment variable an application reads; a form's challenge names its secret by one. */
const APPLICATION_VARIABLE = /^[A-Z][A-Z0-9_]*$/
/** A form's file field names the inbox column its file's id lands in. */
const FORM_FILE_FIELD = /^[a-z_][a-z0-9_]*$/
/** Turnstile's `action`: the form's name, which the verification expects back. */
const CHALLENGE_ACTION = /^[A-Za-z0-9_-]{1,32}$/

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

const COUNT: SchemaShape = { type: 'number', int: true, min: 0, exclusiveMin: false, max: null, exclusiveMax: false, multipleOf: null }

/** The shapes of a collection's generated list query; `src/files/collections.ts` parses with the same schemas. */
export const FILE_LIST_INPUT: SchemaShape = {
	type: 'object',
	fields: {
		owner: TEXT,
		after: { type: 'optional', inner: UUID },
		limit: { type: 'optional', inner: { ...COUNT, min: 1, max: FILE_LIMITS.listPageMax } },
	},
}
/** A link holder's list names no owner: the owner is the link's object. */
export const FILE_LINK_LIST_INPUT: SchemaShape = {
	type: 'object',
	fields: {
		after: { type: 'optional', inner: UUID },
		limit: { type: 'optional', inner: { ...COUNT, min: 1, max: FILE_LIMITS.listPageMax } },
	},
}
export const FILE_LIST_OUTPUT: SchemaShape = {
	type: 'object',
	fields: {
		items: {
			type: 'array',
			minItems: null,
			maxItems: FILE_LIMITS.listPageMax,
			items: {
				type: 'object',
				fields: {
					id: UUID,
					name: { type: 'nullable', inner: TEXT },
					type: TEXT,
					size: COUNT,
					status: { type: 'enum', values: ['live', 'quarantined', 'rejected'] },
					createdAt: { ...UUID, format: 'datetime' },
				},
			},
		},
		next: { type: 'nullable', inner: UUID },
	},
}

/** The shapes of the generated webhook binding endpoints; `@fabrika/app/implement` parses with the same schemas. */
export const WEBHOOK_BIND_INPUT: SchemaShape = {
	type: 'object',
	fields: { [WEBHOOK_SCOPE_FIELD]: TEXT, account: { ...UUID, format: null, pattern: WEBHOOK_ACCOUNT_PATTERN } },
}
export const WEBHOOK_BIND_OUTPUT: SchemaShape = { type: 'object', fields: { id: UUID, url: TEXT, secret: TEXT } }
export const WEBHOOK_UNBIND_INPUT: SchemaShape = { type: 'object', fields: { [WEBHOOK_SCOPE_FIELD]: TEXT, id: UUID } }
export const WEBHOOK_UNBIND_OUTPUT: SchemaShape = ID_OBJECT

/**
 * Validates a described contract against its table policies and normalizes it; throws `ContractError` with every
 * problem. A form's fields are checked against its inbox's columns only where `inboxes` names them.
 */
export function buildArtifact(
	contract: ContractDeclaration<SchemaShape>,
	tables: Readonly<Record<string, TablePolicyArtifact>>,
	inboxes: InboxColumns = {},
): ContractArtifact {
	const problems = new Problems()
	const artifact = canonicalizeArtifact(new ArtifactBuilder(contract, tables, inboxes, problems).build())
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
	readonly #inboxes: InboxColumns
	readonly #problems: Problems
	readonly #endpoints: EndpointRow[] = []
	readonly #reservedPrefixes: string[] = []
	readonly #declared: Record<string, DeclaredReach> = {}
	/** Each procedure of the staged kit's rules, by endpoint id. */
	readonly #procedureRules: Record<string, ProcedureArtifact> = {}
	/** Whether any site is the staged kit's, whose reach is only what it declares; `defineContract`'s sites are not. */
	#kit = false
	/** The endpoints that declare `connect`, by the import they name. */
	readonly #connected = new Map<string, string[]>()
	/** The forms that declare a challenge: their provider's fixed origins join the CSP, and their secret stays private. */
	readonly #challenges: { readonly form: string; readonly provider: ChallengeProvider; readonly secret: string }[] = []
	/** Each variable a browser config serves, and where the contract names it. */
	readonly #publicVariables: { readonly where: string; readonly field: string; readonly name: string }[] = []
	/** The file kinds the contract declares, by name: read before the mounts, whose file fields and outputs name them. */
	#fileKinds: Record<string, FileKindArtifact> = {}

	constructor(
		contract: ContractDeclaration<SchemaShape>,
		tables: Readonly<Record<string, TablePolicyArtifact>>,
		inboxes: InboxColumns,
		problems: Problems,
	) {
		this.#contract = contract
		this.#tables = tables
		this.#inboxes = inboxes
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
		const tokens = this.#tokens()
		this.#fileKinds = this.#readFileKinds()
		const mounts: Record<string, MountArtifact> = {}
		for (const [name, mount] of Object.entries(contract.mounts)) {
			if (this.#name(`mount '${name}'`, name)) {
				const artifact = this.#mount(name, mount)
				if (artifact !== null) {
					mounts[name] = artifact
				}
			}
		}
		this.#checkPublicVariables()
		for (const row of this.#endpoints) {
			if ((row.kind === 'form' || row.kind === 'webhook') && row.input !== null && containsFile(row.input)) {
				this.#problem(`mount '${row.id}'`, "takes a file in its input, which only a procedure's top-level field does (file('<kind>'))")
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
		this.#checkKickCycles()
		const directories = this.#directories(dimensions)
		const locale = this.#locale()
		const displayName = this.#displayName()
		const mail = this.#mail()
		const people = this.#people()
		const artifact: ContractArtifact = {
			format: CONTRACT_FORMAT,
			app: contract.app,
			dimensions,
			actions,
			roles,
			mounts,
			files,
			...(Object.keys(this.#fileKinds).length === 0 ? {} : { fileKinds: this.#fileKinds }),
			jobs,
			exports,
			imports,
			csp,
			tables,
			endpoints: this.#endpoints,
			reservedPrefixes: this.#reservedPrefixes,
			...(this.#kit ? { declared: this.#declared } : {}),
			...(Object.keys(directories).length === 0 ? {} : { directories }),
			...(locale === null ? {} : { locale }),
			...(displayName === null ? {} : { displayName }),
			...(mail === null ? {} : { mail }),
			...people,
			...(Object.keys(this.#procedureRules).length === 0 ? {} : { procedures: this.#procedureRules }),
			...(Object.keys(tokens).length === 0 ? {} : { tokens }),
		}
		try {
			assertNoAmbiguity(artifact)
		} catch (error) {
			this.#problem('endpoints', error instanceof Error ? error.message : String(error))
		}
		return artifact
	}

	/** The member directory each endpoint reads, recorded so the approval and the digest cover the reach. */
	#directories(dimensions: ContractArtifact['dimensions']): Record<string, EndpointDirectory> {
		const directories: Record<string, EndpointDirectory> = {}
		for (const row of this.#endpoints) {
			const reach = directoryReach(dimensions, row)
			if (reach !== null) {
				directories[row.id] = reach
			}
		}
		return directories
	}

	// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────

	/** The application's own people: its `members` actions, and its directory's labels. Each field only when declared. */
	#people(): Pick<ContractArtifact, 'members' | 'directory'> {
		const { members, directory } = this.#contract
		if (members !== undefined) {
			this.#knownAction('members.manage', members.manage)
			this.#knownAction('members.list', members.list)
		}
		if (directory !== undefined && directory !== 'labels') {
			this.#problem('directory', `is '${String(directory)}' (allowed: 'labels')`)
		}
		if (directory !== undefined && members === undefined) {
			this.#problem('directory', 'declares a directory and no members: { manage, list } whose list it labels')
		}
		return {
			...(members === undefined ? {} : { members: { manage: members.manage, list: members.list } }),
			...(directory === 'labels' ? { directory: 'labels' } : {}),
		}
	}

	#locale(): Locale | null {
		const locale = this.#contract.locale
		if (locale === undefined) return null
		if (isLocale(locale)) return locale
		this.#problem('locale', `'${locale}' is not a language IAM speaks (allowed: ${LOCALES.map((value) => `'${value}'`).join(', ')})`)
		return null
	}

	#displayName(): string | null {
		const displayName = this.#contract.displayName
		if (displayName === undefined) return null
		const problem = displayNameProblem(displayName)
		if (problem !== null) this.#problem('displayName', problem)
		return displayName
	}

	/** The declared e-mail templates; an empty declaration is none, so the digest stays. */
	#mail(): MailTemplates | null {
		const mail = this.#contract.mail
		if (mail === undefined) return null
		const templates: { [K in MessageKind]?: { [L in Locale]?: MailTemplate } } = {}
		for (const [kind, byLocale] of Object.entries(mail)) {
			if (!isMessageKind(kind)) {
				this.#problem(`mail '${kind}'`, `is not a message IAM sends (allowed: ${MESSAGE_KINDS.map((value) => `'${value}'`).join(', ')})`)
				continue
			}
			const declared: { [L in Locale]?: MailTemplate } = {}
			for (const [locale, template] of Object.entries(byLocale)) {
				const where = `mail.${kind}.${locale}`
				if (!isLocale(locale)) {
					this.#problem(where, `'${locale}' is not a language IAM speaks (allowed: ${LOCALES.map((value) => `'${value}'`).join(', ')})`)
					continue
				}
				for (const problem of mailTemplateProblems(kind, template)) this.#problem(where, problem)
				declared[locale] = { subject: template.subject, text: template.text, ...(template.html === undefined ? {} : { html: template.html }) }
			}
			if (Object.keys(declared).length > 0) templates[kind] = declared
		}
		return Object.keys(templates).length === 0 ? null : templates
	}

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
			if (dimension.directory !== undefined && dimension.directory !== 'labels') {
				this.#problem(where, `its directory is '${String(dimension.directory)}' (allowed: 'labels')`)
			}
			if (dimension.directory !== undefined && dimension.members === undefined) {
				this.#problem(where, 'declares a directory and no members: { manage, list } whose list it labels')
			}
			dimensions[name] = {
				in: dimension.in ?? null,
				creator: dimension.creator ?? null,
				members: dimension.members === undefined ? null : { manage: dimension.members.manage, list: dimension.members.list },
				...(dimension.directory === 'labels' ? { directory: 'labels' } : {}),
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
					const assigning = Object.hasOwn(this.#contract.roles, assigner) ? this.#contract.roles[assigner] : undefined
					if (assigning === undefined || (assigning.member !== undefined && assigning.member.scope !== scope)) {
						this.#problem(
							where,
							`is assignable by '${assigner}', which is neither a membership role of '${scope}' nor an application-wide role (a role with no member)`,
						)
					}
				}
			}
			if (role.external !== undefined && role.external !== true) {
				this.#problem(where, `its external is ${String(role.external)} (allowed: external: true, or no external)`)
			}
			if (role.external === true && role.member === undefined) {
				this.#problem(where, 'is declared external and is not a membership role: only a role with member: { scope, … } may admit externals')
			}
			roles[name] = {
				grants: [...role.grants],
				member: role.member === undefined ? null : { scope: role.member.scope, assignableBy: [...role.member.assignableBy] },
				...(role.external === true ? { external: true } : {}),
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
					const id = `${name}.${path}`
					const callers = nonEmpty(mount.callers)
					const actions = this.#procedure({ kind: 'mount', name }, id, joinPath(mount.prefix, path), callers, procedure)
					this.#declare(`procedure '${id}'`, id, procedure.declared, {
						kind: 'rpc',
						readOnly: procedure.type === 'query',
						access: procedure.access,
						actions,
					})
				}
				const compatibility = this.#compatibility(where, mount.compatibility)
				return { kind: 'rpc', prefix: mount.prefix, callers: [...mount.callers], ...(compatibility === 'backward' ? { compatibility } : {}) }
			}
			case 'link':
				return this.#link(name, mount)
			case 'spa': {
				if (mount.prefix !== '/') {
					this.#prefix(where, mount.prefix)
				}
				this.#nonEmpty(`${where} dir`, mount.dir)
				const requirement = this.#spaRequirement(where, mount.access)
				// The bare prefix (`/admin`) is the mount's too, under its access: it redirects to `/admin/`.
				const rows = mount.prefix === '/'
					? [{ id: name, path: joinPath(mount.prefix, '*') }]
					: [{ id: name, path: joinPath(mount.prefix, '*') }, { id: spaPrefixRowId(name), path: mount.prefix }]
				for (const { id, path } of rows) {
					const source = { kind: 'mount' as const, name }
					if (requirement === 'public') {
						this.#row({ id, source, kind: 'public-spa', method: 'GET', path, callers: [], requirement: null, admission: null, input: null, output: null })
					} else if (requirement !== null) {
						this.#row({ id, source, kind: 'spa', method: 'GET', path, callers: ['human'], requirement, admission: null, input: null, output: null })
					}
				}
				const publicVariables = this.#spaPublic(where, mount.public)
				return { kind: 'spa', prefix: mount.prefix, dir: mount.dir, ...(publicVariables.length === 0 ? {} : { public: publicVariables }) }
			}
			case 'health':
				this.#prefix(where, mount.path)
				this.#anonymous(name, 'health', 'GET', mount.path, null, null)
				return { kind: 'health', path: mount.path }
			case 'form': {
				this.#prefix(where, mount.path)
				this.#objectSchema(`${where} input`, mount.input)
				this.#nonEmpty(`${where} appendTo`, mount.appendTo)
				const files = mount.files === undefined ? null : this.#formFiles(where, mount, mount.files)
				this.#formByteBudget(where, mount, files)
				const limit = this.#bodyLimit(where, mount.maxBytes, CONTRACT_DEFAULTS.formMaxBytes)
				// A form that takes files is multipart: `maxBytes` bounds its input part, each collection its file. While no
				// file is required it also takes the JSON body it took before, so its existing pages keep working.
				const optional = files !== null && Object.values(files).every((file) => !file.required)
				const admission: BodyAdmission = files === null
					? limit
					: { contentTypes: optional ? ['application/json', FORM_MULTIPART_TYPE] : [FORM_MULTIPART_TYPE], maxBytes: limit.maxBytes }
				this.#anonymous(name, 'form', 'POST', mount.path, admission, mount.input, this.#crossOrigin(where, mount.crossOrigin, true))
				return {
					kind: 'form',
					path: mount.path,
					appendTo: mount.appendTo,
					...this.#formAdmission(name, where, mount),
					...(mount.then === undefined ? {} : { then: this.#kickedJob(where, mount.then) }),
					...(files === null ? {} : { files }),
				}
			}
			case 'webhook': {
				this.#prefix(where, mount.path)
				this.#objectSchema(`${where} input`, mount.input)
				const boundTo = this.#scopeBinding(where, 'boundTo', mount.boundTo)
				// A GitHub webhook bound to a dimension keeps its generated binding endpoints; any other binds through `binds`.
				const generated = boundTo?.kind === 'dimension' && mount.scheme === 'github-sha256' ? boundTo.dimension : null
				const members = generated === null ? undefined : this.#contract.dimensions[generated]?.members
				if (generated !== null && members === undefined) {
					this.#problem(where, `is bound to '${generated}', which declares no members: { manage, list } to create bindings with`)
				}
				this.#actionList(where, mount.actions)
				const path = joinPath(mount.path, `:${WEBHOOK_BINDING_PARAMETER}`)
				const limits = this.#limits(where, mount.limits, WEBHOOK_LIMITS)
				this.#anonymous(name, 'webhook', 'POST', path, { contentTypes: ['application/json'], maxBytes: limits.maxBytes }, mount.input)
				this.#declare(where, name, mount.declared, { kind: 'webhook', readOnly: false })
				if (generated !== null && members !== undefined) {
					this.#webhookBindings(name, generated, members.manage)
				}
				const scheme = this.#webhookScheme(where, mount.scheme)
				return boundTo === null || scheme === null
					? null
					: { kind: 'webhook', path: mount.path, scheme, boundTo, actions: [...mount.actions], timeoutMs: limits.timeoutMs }
			}
			default:
				this.#problem(where, 'is not a mount (allowed: c.rpc, c.link, c.spa, c.health, c.form or c.webhook)')
				return null
		}
	}

	/** The job a form, a mutation, a webhook or a job kicks: a cron job of this contract. */
	#kickedJob(where: string, then: string, field: 'then' | 'kicks' = 'then'): string {
		const jobs = this.#contract.jobs
		const job: { readonly kind: string } | undefined = Object.hasOwn(jobs, then) ? jobs[then] : undefined
		if (job === undefined) {
			const names = Object.keys(jobs)
			this.#problem(
				where,
				`${field} '${then}' is not a job of the contract (jobs: ${names.length === 0 ? 'none' : names.join(', ')})${suggestion(then, names)}`,
			)
		} else if (job.kind !== 'cron') {
			this.#problem(where, `${field} '${then}' is not a cron job (allowed: a job c.cron declares)`)
		}
		return then
	}

	/** A form's declared rate, honeypot and challenge, each present in the artifact only when declared. */
	#formAdmission(name: string, where: string, mount: FormMountDeclaration<SchemaShape>): Pick<FormMountArtifact, 'rate' | 'honeypot' | 'challenge'> {
		const fields = mount.input.type === 'object' ? mount.input.fields : {}
		const admission: { rate?: FormRate; honeypot?: string; challenge?: FormChallenge } = {}
		if (mount.rate !== undefined) {
			admission.rate = this.#formRate(`${where} rate`, mount.rate)
		}
		if (mount.honeypot !== undefined) {
			const field = fields[mount.honeypot]
			if (field === undefined) {
				this.#problem(where, `honeypot '${mount.honeypot}' is not a field of its input (allowed: a z.string() field the form's page hides)`)
			} else if (!isStringField(field)) {
				this.#problem(where, `honeypot '${mount.honeypot}' is not a string field (allowed: z.string() or z.optional(z.string()))`)
			}
			if (mount.honeypot === FORM_CHALLENGE_FIELD) {
				this.#problem(where, `honeypot '${mount.honeypot}' is the field the challenge token travels in`)
			}
			admission.honeypot = mount.honeypot
		}
		if (mount.challenge !== undefined) {
			admission.challenge = this.#formChallenge(name, where, mount.challenge, fields)
		}
		return admission
	}

	/**
	 * A form's file fields: at most `FORM_FILE_LIMITS.maxFields`, each a lowercase column name that no input field, the
	 * honeypot, the challenge token or the input part takes, each landing in a declared collection that scans. An
	 * anonymous visitor's file reaches the people who read the collection, so the form must declare a challenge too.
	 */
	#formFiles(where: string, mount: FormMountDeclaration<SchemaShape>, declared: unknown): Readonly<Record<string, FormFileArtifact>> | null {
		const example = "files: { photo: { collection: '<a c.files collection with scan: true>' } }"
		if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
			this.#problem(where, `files is not an object of file fields (allowed: ${example})`)
			return null
		}
		const entries = Object.entries(declared)
		if (entries.length === 0 || entries.length > FORM_FILE_LIMITS.maxFields) {
			this.#problem(where, `files declares ${entries.length} file fields (allowed: 1 to ${FORM_FILE_LIMITS.maxFields}, one file each)`)
		}
		if (mount.challenge === undefined) {
			this.#problem(where, "takes files, so it declares a challenge: an anonymous upload needs a solved one (challenge: { provider: 'turnstile', … })")
		}
		const fields = mount.input.type === 'object' ? mount.input.fields : {}
		const files: Record<string, FormFileArtifact> = {}
		for (const [field, option] of entries) {
			const at = `${where} file '${field}'`
			if (!FORM_FILE_FIELD.test(field)) {
				this.#problem(at, 'is not a column name (allowed: lowercase snake_case, as its inbox column is named)')
			}
			if (field === FORM_INPUT_PART || field === FORM_CHALLENGE_FIELD || field === mount.honeypot || Object.hasOwn(fields, field)) {
				this.#problem(at, `is also the name of the input part, the challenge token, the honeypot or an input field; name the file its own field`)
			}
			if (typeof option !== 'object' || option === null || Array.isArray(option)) {
				this.#problem(at, `is not { collection, required? } (allowed: ${example})`)
				continue
			}
			this.#keys(at, option, ['collection', 'required'])
			const collection: unknown = Reflect.get(option, 'collection')
			const required: unknown = Reflect.get(option, 'required')
			if (required !== undefined && typeof required !== 'boolean') {
				this.#problem(at, `required ${JSON.stringify(required)} is not true or false`)
			}
			const collections = this.#contract.files
			const target: { readonly kind: string; readonly scan?: boolean } | undefined =
				typeof collection === 'string' && Object.hasOwn(collections, collection) ? collections[collection] : undefined
			if (typeof collection !== 'string' || target === undefined || target.kind !== 'files') {
				const names = Object.keys(collections)
				this.#problem(
					at,
					`collection ${JSON.stringify(collection)} is not a file collection of the contract (collections: ${
						names.length === 0 ? 'none' : names.join(', ')
					})`,
				)
				continue
			}
			if (target.scan !== true) {
				this.#problem(at, `lands in files '${collection}', which does not scan; an anonymous visitor's file waits for a clean verdict (scan: true)`)
			}
			files[field] = { collection, required: required === true }
		}
		return files
	}

	/** `bytesPerHour` belongs to a form with files, and fits at least the largest file one of its fields admits. */
	#formByteBudget(where: string, mount: FormMountDeclaration<SchemaShape>, files: Readonly<Record<string, FormFileArtifact>> | null): void {
		const declared: unknown = typeof mount.rate === 'object' && mount.rate !== null ? Reflect.get(mount.rate, 'bytesPerHour') : undefined
		if (declared === undefined) {
			return
		}
		if (files === null) {
			this.#problem(where, 'declares rate.bytesPerHour and takes no files (allowed: on a form with files)')
			return
		}
		const largest = Math.max(...Object.values(files).map((file) => this.#contract.files[file.collection]?.maxBytes ?? 0))
		if (typeof declared === 'number' && declared < largest) {
			this.#problem(where, `rate.bytesPerHour ${declared} is less than the ${largest} bytes one of its files may hold`)
		}
	}

	#formRate(where: string, rate: object): FormRate {
		this.#keys(where, rate, ['perClient', 'perForm', 'bytesPerHour'])
		const parsed: { perClient?: number; perForm?: number; bytesPerHour?: number } = {}
		const bytes: unknown = Reflect.get(rate, 'bytesPerHour')
		if (bytes !== undefined) {
			if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > FORM_FILE_LIMITS.maxBytesPerHour) {
				this.#problem(where, `bytesPerHour ${String(bytes)} is not a whole number of bytes from 1 to ${FORM_FILE_LIMITS.maxBytesPerHour}`)
			} else {
				parsed.bytesPerHour = bytes
			}
		}
		for (const key of ['perClient', 'perForm'] as const) {
			const value: unknown = Reflect.get(rate, key)
			if (value === undefined) {
				continue
			}
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > FORM_LIMITS.maxPerMinute) {
				this.#problem(where, `${key} ${String(value)} is not a whole number of submissions per minute from 1 to ${FORM_LIMITS.maxPerMinute}`)
				continue
			}
			parsed[key] = value
		}
		return parsed
	}

	#formChallenge(name: string, where: string, challenge: object, fields: Readonly<Record<string, SchemaShape>>): FormChallenge | undefined {
		this.#keys(`${where} challenge`, challenge, ['provider', 'secret', 'siteKey'])
		const provider: unknown = Reflect.get(challenge, 'provider')
		const secret: unknown = Reflect.get(challenge, 'secret')
		const siteKey: unknown = Reflect.get(challenge, 'siteKey')
		if (provider !== 'turnstile') {
			this.#problem(where, `challenge provider ${JSON.stringify(provider)} is not one the framework verifies (allowed: 'turnstile')`)
			return undefined
		}
		if (typeof secret !== 'string' || !APPLICATION_VARIABLE.test(secret) || secret.startsWith('FABRIKA_')) {
			this.#problem(
				where,
				`challenge secret ${
					JSON.stringify(secret)
				} is not the name of an application variable (allowed: 'TURNSTILE_SECRET'; never the secret itself, never FABRIKA_*)`,
			)
			return undefined
		}
		if (!CHALLENGE_ACTION.test(name)) {
			this.#problem(where, `a form with a challenge is named as the widget's action, at most 32 letters, digits, '_' or '-'`)
		}
		const token = fields[FORM_CHALLENGE_FIELD]
		if (token === undefined || token.type !== 'string') {
			this.#problem(where, `declares a challenge, so its input needs the required field ${FORM_CHALLENGE_FIELD}: z.string(), the widget's token`)
		}
		this.#challenges.push({ form: name, provider, secret })
		if (siteKey === undefined || !this.#applicationVariable(where, 'challenge siteKey', siteKey, 'TURNSTILE_SITE_KEY')) {
			return { provider, secret }
		}
		this.#publicVariables.push({ where, field: 'challenge siteKey', name: siteKey })
		return { provider, secret, siteKey }
	}

	/** The variables an SPA mount serves its pages; `[]` when it declares none. */
	#spaPublic(where: string, declared: readonly string[] | undefined): readonly string[] {
		if (declared === undefined) {
			return []
		}
		if (declared.length === 0) {
			this.#problem(where, "public names no variable (allowed: public: ['SIGNUP_URL'], or no public)")
		}
		this.#unique(where, 'public', declared)
		const names = declared.filter((name) => this.#applicationVariable(where, 'public', name, 'SIGNUP_URL'))
		for (const name of names) {
			this.#publicVariables.push({ where, field: 'public', name })
		}
		return names
	}

	/** Whether `name` names an application variable: a value or a framework variable is refused. */
	#applicationVariable(where: string, field: string, name: unknown, example: string): name is string {
		if (typeof name === 'string' && APPLICATION_VARIABLE.test(name) && !name.startsWith('FABRIKA_')) {
			return true
		}
		this.#problem(
			where,
			`${field} ${JSON.stringify(name)} is not the name of an application variable (allowed: '${example}'; never a value, never FABRIKA_*)`,
		)
		return false
	}

	/** A browser config serves every public variable to anyone who opens a page, so none of them may hold a secret. */
	#checkPublicVariables(): void {
		for (const variable of this.#publicVariables) {
			const owner = this.#challenges.find((challenge) => challenge.secret === variable.name)
			if (owner !== undefined) {
				this.#problem(variable.where, `${variable.field} '${variable.name}' is the secret of form '${owner.form}'; a secret is never public`)
			}
		}
	}

	/** The webhook's verifier: a preset, or a framework-owned shape the runtime computes. */
	#webhookScheme(where: string, value: unknown): WebhookScheme | null {
		const parsed = z.safeParse(webhookSchemeSchema, value)
		if (parsed.success && typeof parsed.data === 'object' && !('hmac' in parsed.data)) {
			// The verifier runs in the framework, behind the proxy, which forwards no `Authorization` it did not read.
			this.#problem(
				where,
				`scheme ${
					JSON.stringify(value)
				} needs the request's Authorization header, which the proxy removes from an anonymous endpoint's request (ADR-0022 rule 3); this release serves the presets and the hmac shape`,
			)
			return null
		}
		if (parsed.success) {
			return parsed.data
		}
		// A union names no branch; an `hmac` shape is refused for its own first issue.
		const shape = isRecord(value) && Object.hasOwn(value, 'hmac') ? z.safeParse(hmacSchemeSchema, value['hmac']) : null
		const issue = shape?.success === false ? shape.error.issues[0] : undefined
		const detail = issue === undefined ? '' : ` (hmac${issue.path.map((key) => `.${String(key)}`).join('')}: ${issue.message})`
		this.#problem(where, `scheme ${JSON.stringify(value)} is not a verifier${detail} (allowed: ${WEBHOOK_SCHEME_ALLOWED})`)
		return null
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
			this.#noCrossOrigin(`procedure '${id}'`, procedure.crossOrigin, 'a link holder')
			if (procedure.actions !== undefined) {
				this.#problem(`procedure '${id}'`, 'declares actions, which only a public procedure holds; a link procedure holds its link grant')
			}
			const rules = this.#rules(id, procedure, 'link')
			this.#declare(`procedure '${id}'`, id, procedure.declared, { kind: 'link', readOnly: procedure.type === 'query' })
			if (requirement !== null) {
				this.#row({
					id,
					source: { kind: 'mount', name },
					kind: procedure.type,
					path: joinPath(api, path),
					callers: ['link'],
					requirement,
					...rowWire(rules),
					input: procedure.input,
					output: this.#output(`procedure '${id}'`, procedure),
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

	/**
	 * A procedure's row and its rules; a public procedure's workload actions, which `#declare` records, or `null`.
	 * `callers` is `null` on an RPC mount whose groups are all public.
	 */
	#procedure(
		source: EndpointSource,
		id: string,
		path: string,
		callers: readonly [Caller, ...Caller[]] | null,
		procedure: ProcedureDeclaration<SchemaShape>,
	): readonly string[] | null {
		const where = `procedure '${id}'`
		this.#procedureSchemas(where, procedure)
		if (isPublicAccess(procedure.access)) {
			if (source.kind === 'mount') {
				return this.#publicProcedure(source, id, path, procedure)
			}
			this.#problem(where, 'is public, which only a procedure of an RPC mount is (allowed: an action and its scope)')
			return null
		}
		if (procedure.actions !== undefined) {
			this.#problem(where, 'declares actions, which only a public procedure holds (its handler runs as its own workload); remove them')
		}
		if (source.kind === 'export' && (procedure.redirect !== undefined || procedure.http !== undefined)) {
			this.#problem(where, 'is an export procedure, which answers JSON to a POST: it declares no http and no redirect()')
		}
		if (source.kind === 'export' && (procedure.output.type === 'file' || (procedure.input !== null && containsFile(procedure.input)))) {
			this.#problem(where, 'is an export procedure, which carries JSON both ways: it takes no file and answers none')
		}
		const requirement = this.#requirement(where, procedure)
		const rules = this.#rules(id, procedure, 'credentialed')
		const crossOrigin = source.kind === 'mount'
			? this.#credentialedOrigins(where, procedure.crossOrigin, rules?.origins ?? 'same-origin')
			: this.#noCrossOrigin(
				where,
				procedure.crossOrigin ?? (rules?.origins === 'same-origin' ? undefined : rules?.origins),
				'a consuming application, from its server',
			)
		if (callers === null) {
			this.#problem(
				where,
				"is credentialed, and its group names no callers: a group without callers holds public procedures only (app.group({ callers: ['human'] }, …))",
			)
			return null
		}
		if (requirement !== null) {
			this.#row({
				id,
				source,
				kind: procedure.type,
				path,
				callers,
				requirement,
				...rowWire(rules),
				input: procedure.input,
				output: this.#output(where, procedure),
				...crossOrigin,
			})
		}
		return null
	}

	/**
	 * A procedure anyone calls (`access: { public: true }`): its own row mode, no callers and no requirement, and its
	 * handler holding its top-level `actions` as the endpoint's own workload. It answers the default admission of a public
	 * procedure unless it declares its own.
	 */
	#publicProcedure(source: EndpointSource, id: string, path: string, procedure: ProcedureDeclaration<SchemaShape>): readonly string[] | null {
		const where = `procedure '${id}'`
		if (!hasExactKeys(procedure.access, ['public'])) {
			this.#problem(where, `access ${JSON.stringify(procedure.access)} is not the public form (allowed: { public: true }, with actions beside it)`)
		}
		if (procedure.crossOrigin !== undefined) {
			this.#problem(where, "is public: its origins are admission.origins ('same-origin', 'listed' or 'any'), never crossOrigin")
		}
		const actions = this.#workloadActions(where, procedure.actions)
		const rules = this.#rules(id, procedure, 'public')
		if (rules === null) {
			// A procedure of the staged kit always carries `declared`; one without it is no kit procedure.
			this.#problem(where, 'is public, which only a procedure of the staged kit (app.group) is')
			return null
		}
		const origins = rules.origins === 'any'
			? { crossOrigin: 'any' as const }
			: rules.origins === 'listed'
			? { crossOrigin: 'environment' as const }
			: {}
		this.#row({
			id,
			source,
			kind: 'public',
			path,
			callers: [],
			requirement: null,
			...rowWire(rules),
			input: procedure.input,
			output: this.#output(where, procedure),
			...origins,
		})
		return actions
	}

	/** A public procedure's `actions`: at least one action of the contract, each once. */
	#workloadActions(where: string, value: unknown): readonly string[] {
		if (!Array.isArray(value) || value.length === 0 || !value.every((action) => typeof action === 'string')) {
			this.#problem(where, "is public, so it declares what its handler holds: actions: ['<action>'], at least one")
			return []
		}
		const actions: string[] = value.filter((action) => typeof action === 'string')
		this.#unique(where, 'actions', actions)
		for (const action of actions) {
			this.#knownAction(where, action)
		}
		return actions
	}

	/** A credentialed procedure's origins: `crossOrigin: true` as before, or `admission.origins: 'listed'`; never both. */
	#credentialedOrigins(where: string, crossOrigin: unknown, origins: AdmissionOrigins): { readonly crossOrigin?: CrossOriginForm } {
		if (crossOrigin !== undefined && origins !== 'same-origin') {
			this.#problem(where, "declares crossOrigin and admission.origins; declare admission.origins: 'listed' alone")
		}
		if (origins === 'listed') {
			return { crossOrigin: 'environment' }
		}
		return this.#crossOrigin(where, crossOrigin, false)
	}

	/**
	 * A procedure's rules of the staged kit, every default applied: `limits` within its ceilings, and `admission` merged
	 * into the default of the procedure's kind (a declared bucket replaces the default, `null` turns it off). Recorded under
	 * the endpoint id; `null` for a `defineContract` procedure, which declares none and keeps its row as it was.
	 */
	#rules(id: string, procedure: ProcedureDeclaration<SchemaShape, unknown>, kind: 'public' | 'credentialed' | 'link'): ProcedureRules | null {
		const where = `procedure '${id}'`
		if (procedure.declared === undefined) {
			for (const field of ['admission', 'limits', 'http'] as const) {
				if (procedure[field] !== undefined) {
					this.#problem(where, `declares ${field}, which only a procedure of the staged kit declares`)
				}
			}
			return null
		}
		const files = this.#inputFiles(where, procedure)
		const limits = this.#limits(where, procedure.limits, PROCEDURE_LIMITS, files)
		const admission = this.#admission(id, procedure, kind, files)
		const http = this.#http(where, procedure, kind, files)
		this.#procedureRules[id] = {
			rate: admission.rate,
			challenge: admission.challenge,
			timeoutMs: limits.timeoutMs,
			...(http.query === null ? {} : { query: http.query }),
			...(http.method === 'GET' && procedure.type === 'mutation' ? { changesStateOnGet: true } : {}),
		}
		return {
			maxBytes: limits.maxBytes,
			origins: admission.origins,
			method: http.method,
			body: http.body,
			...(files === null ? {} : { filesOptional: files.optional }),
		}
	}

	/**
	 * A procedure's file fields: each a top-level field of its input that holds a file of a declared kind (`file(k)`),
	 * an optional one, or an array of them bounded by `.max(n)`; a mutation's only, `maxFiles` files together. `null`
	 * when it takes none.
	 */
	#inputFiles(where: string, procedure: ProcedureDeclaration<SchemaShape, unknown>): InputFiles | null {
		const input = procedure.input
		if (input === null || input.type !== 'object') {
			return null
		}
		const fields: { readonly name: string; readonly kind: string; readonly count: number; readonly required: boolean }[] = []
		for (const [name, shape] of Object.entries(input.fields)) {
			const field = fileField(shape)
			if (field === 'unbounded') {
				this.#problem(where, `input field '${name}' is an array of files without a bound (allowed: z.array(file('<kind>')).max(n))`)
			} else if (field !== null) {
				fields.push({ name, ...field })
			} else if (containsFile(shape)) {
				this.#problem(
					where,
					`input field '${name}' holds a file below the top level (allowed: ${name}: file('<kind>'), z.optional(file('<kind>')) or z.array(file('<kind>')).max(n))`,
				)
			}
		}
		if (fields.length === 0) {
			return null
		}
		if (procedure.type !== 'mutation') {
			this.#problem(where, 'takes a file, which only a mutation does: a file is written, and a query writes nothing')
		}
		const count = fields.reduce((sum, field) => sum + field.count, 0)
		if (count > PROCEDURE_LIMITS.maxFiles) {
			this.#problem(where, `takes up to ${count} files, more than the ${PROCEDURE_LIMITS.maxFiles} one request may carry`)
		}
		let bytes = 0
		let largest = 0
		let scanning = true
		for (const field of fields) {
			const kind = this.#fileKind(`${where} input field '${field.name}'`, field.kind)
			if (kind !== null) {
				bytes += field.count * kind.maxBytes
				largest = Math.max(largest, kind.maxBytes)
				scanning &&= kind.scan === true
			}
		}
		return { bytes, largest, scanning, optional: fields.every((field) => !field.required) }
	}

	/**
	 * A procedure's HTTP shape (`http: { method?, query?, body? }`): `POST` with a JSON body by default. A query may be
	 * `GET`, its input then read from flat scalar URL parameters; so may a public mutation whose input holds a signed
	 * token, which answers a redirect or a schema. A POST may read a flat `query` from the URL beside its body, and take a
	 * native form's `urlencoded` body of flat scalar fields. `cache` waits for caching, a later step of this release.
	 */
	#http(
		where: string,
		procedure: ProcedureDeclaration<SchemaShape, unknown>,
		kind: 'public' | 'credentialed' | 'link',
		files: InputFiles | null = null,
	): { readonly method: 'GET' | 'POST'; readonly body: ProcedureBody | null; readonly query: SchemaShape | null } {
		const fallback = { method: 'POST' as const, body: files === null ? ('json' as const) : ('multipart' as const), query: null }
		const value = procedure.http
		// A query that answers a file is a GET, so `<img src>` and `<a download>` reach it.
		if (value === undefined && procedure.type === 'query' && procedure.output.type === 'file') {
			return this.#http(where, { ...procedure, http: { method: 'GET' } }, kind, files)
		}
		if (value === undefined) {
			return fallback
		}
		const allowed = "http: { method?: 'GET' | 'POST', query?: z.strictObject({ … }), body?: 'json' | 'urlencoded' }"
		if (!isRecord(value)) {
			this.#problem(where, `http is not an object (allowed: ${allowed})`)
			return fallback
		}
		this.#keys(`${where} http`, value, ['method', 'query', 'body', 'cache'])
		if (value['cache'] !== undefined) {
			this.#problem(where, 'declares http.cache, which this release does not serve yet (allowed: no cache; every answer is no-store)')
		}
		const method = value['method'] ?? 'POST'
		if (method !== 'GET' && method !== 'POST') {
			this.#problem(where, `http.method ${JSON.stringify(method)} is not a method (allowed: 'GET' or 'POST')`)
			return fallback
		}
		if (files !== null && value['body'] !== undefined) {
			this.#problem(where, 'takes files, so its body is multipart/form-data, which the input derives: it declares no http.body')
			return fallback
		}
		const body = value['body'] ?? (method === 'GET' ? null : files === null ? 'json' : 'multipart')
		const flat = (shape: SchemaShape | null) => shape === null || (shape.type === 'object' && Object.values(shape.fields).every(isParameter))
		if (method === 'GET') {
			if (procedure.type === 'mutation') {
				this.#getMutation(where, procedure, kind)
			}
			if (value['query'] !== undefined || value['body'] !== undefined) {
				this.#problem(where, 'is GET, which reads its input from the URL: it declares no http.query and no http.body')
			}
			if (!flat(procedure.input)) {
				this.#problem(where, 'is GET, so its input is flat scalar fields the URL carries (allowed: strings, numbers, booleans, enums, literals, null)')
			}
			return { method, body: null, query: null }
		}
		if (body === 'multipart' && files !== null) {
			const query = value['query']
			if (query !== undefined && (!isSchemaShape(query) || query.type !== 'object' || !flat(query))) {
				this.#problem(where, 'http.query is not a strict object of flat scalar fields (allowed: z.strictObject({ t: z.string() }))')
				return { method, body, query: null }
			}
			return { method, body, query: query === undefined ? null : query }
		}
		if (body !== 'json' && body !== 'urlencoded') {
			this.#problem(where, `http.body ${JSON.stringify(body)} is not a body codec (allowed: 'json' or 'urlencoded')`)
			return fallback
		}
		if (body === 'urlencoded' && !flat(procedure.input)) {
			this.#problem(where, "takes a urlencoded body, so its input is flat scalar fields (allowed: http.body: 'json' for anything else)")
		}
		const query = value['query']
		if (query === undefined) {
			return { method, body, query: null }
		}
		if (!isSchemaShape(query) || query.type !== 'object' || !flat(query)) {
			this.#problem(where, 'http.query is not a strict object of flat scalar fields (allowed: z.strictObject({ t: z.string() }))')
			return { method, body, query: null }
		}
		this.#tokenFields(`${where} http.query`, query, true)
		return { method, body, query }
	}

	/**
	 * A mutation answers `GET` only when it is public and a verified signed token in its input names what it changes: a
	 * link scanner may follow it, and a session's top-level navigation would carry the cookie. It answers a redirect or a
	 * schema.
	 */
	#getMutation(where: string, procedure: ProcedureDeclaration<SchemaShape, unknown>, kind: 'public' | 'credentialed' | 'link'): void {
		if (kind !== 'public') {
			this.#problem(
				where,
				"is a GET mutation, which only a public procedure is: a session's top-level navigation carries its cookie (allowed: POST, or access: { public: true } with a signedToken)",
			)
			return
		}
		const fields = procedure.input?.type === 'object' ? Object.values(procedure.input.fields) : []
		if (!fields.some((field) => field.type === 'token')) {
			this.#problem(where, "is a GET mutation, so its input holds a required signedToken('<purpose>') that names what it changes")
		}
		if (procedure.attachment !== undefined || procedure.output.type === 'file') {
			this.#problem(where, 'is a GET mutation, which answers redirect() or a schema, never a file')
		}
	}

	/**
	 * A procedure's or a webhook's `limits`, each bound within a procedure's ceiling; `defaults` for what it leaves out. A
	 * procedure with file fields admits by default its JSON input's bytes and each of its files at its kind's `maxBytes`,
	 * at most `maxFileBodyBytes` in all.
	 */
	#limits(
		where: string,
		value: unknown,
		base: { readonly maxBytes: number; readonly timeoutMs: number },
		files: InputFiles | null = null,
	): { readonly maxBytes: number; readonly timeoutMs: number } {
		const defaults = { maxBytes: base.maxBytes + (files?.bytes ?? 0), timeoutMs: base.timeoutMs }
		const ceiling = files === null ? PROCEDURE_LIMITS.maxMaxBytes : PROCEDURE_LIMITS.maxFileBodyBytes
		if (defaults.maxBytes > ceiling && (!isRecord(value) || value['maxBytes'] === undefined)) {
			this.#problem(
				where,
				`takes files of up to ${
					files?.bytes ?? 0
				} bytes together, more than the ${ceiling} bytes a request may carry: take fewer or smaller files, or declare limits.maxBytes`,
			)
		}
		if (value === undefined) {
			return { ...defaults, maxBytes: Math.min(defaults.maxBytes, ceiling) }
		}
		if (!isRecord(value)) {
			this.#problem(where, 'limits is not an object (allowed: limits: { maxBytes?, timeoutMs? })')
			return defaults
		}
		this.#keys(`${where} limits`, value, ['maxBytes', 'timeoutMs'])
		return {
			maxBytes: this.#bounded(where, 'limits.maxBytes', value['maxBytes'], Math.min(defaults.maxBytes, ceiling), ceiling, 'bytes'),
			timeoutMs: this.#bounded(where, 'limits.timeoutMs', value['timeoutMs'], defaults.timeoutMs, PROCEDURE_LIMITS.maxTimeoutMs, 'ms'),
		}
	}

	/** A declared whole number from 1 to `ceiling`, or `fallback` when it is absent or refused. */
	#bounded(where: string, field: string, value: unknown, fallback: number, ceiling: number, unit: string): number {
		if (value === undefined) {
			return fallback
		}
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
			this.#problem(where, `${field} ${JSON.stringify(value)} is not a whole number of ${unit} from 1 to ${ceiling}`)
			return fallback
		}
		return value
	}

	#admission(
		id: string,
		procedure: ProcedureDeclaration<SchemaShape, unknown>,
		kind: 'public' | 'credentialed' | 'link',
		files: InputFiles | null = null,
	): { readonly origins: AdmissionOrigins; readonly rate: AdmissionRate; readonly challenge: FormChallenge | null } {
		const where = `procedure '${id}'`
		const admitted = this.#declaredAdmission(id, procedure, kind, files)
		if (kind === 'public' && files !== null) {
			const missing = [
				...(admitted.rate.bytesPerHour === null ? ['admission.rate.bytesPerHour'] : []),
				...(admitted.challenge === null ? ['admission.challenge'] : []),
			]
			if (missing.length > 0) {
				this.#problem(where, `is public and takes files, so it declares ${missing.join(' and ')}: an anonymous upload is budgeted and challenged`)
			}
			if (!files.scanning) {
				this.#problem(
					where,
					"is public and takes files, so each of its file kinds scans (scan: true): an anonymous visitor's file waits for a clean verdict",
				)
			}
		}
		return admitted
	}

	#declaredAdmission(
		id: string,
		procedure: ProcedureDeclaration<SchemaShape, unknown>,
		kind: 'public' | 'credentialed' | 'link',
		files: InputFiles | null,
	): { readonly origins: AdmissionOrigins; readonly rate: AdmissionRate; readonly challenge: FormChallenge | null } {
		const where = `procedure '${id}'`
		const rate: Record<keyof AdmissionRate, number | null> = kind === 'public' && procedure.type === 'mutation'
			? { perClient: PUBLIC_MUTATION_RATE.perClient, perCaller: null, perEndpoint: PUBLIC_MUTATION_RATE.perEndpoint, bytesPerHour: null }
			: { perClient: null, perCaller: null, perEndpoint: null, bytesPerHour: null }
		const declared = procedure.admission
		if (declared === undefined) {
			return { origins: 'same-origin', rate, challenge: null }
		}
		const allowed =
			"admission: { origins?: 'same-origin' | 'listed' | 'any', rate?: { perClient?, perCaller?, perEndpoint?, bytesPerHour? }, challenge? }"
		if (!isRecord(declared)) {
			this.#problem(where, `admission is not an object (allowed: ${allowed})`)
			return { origins: 'same-origin', rate, challenge: null }
		}
		this.#keys(`${where} admission`, declared, ['origins', 'rate', 'challenge'])
		const origins = this.#origins(where, declared['origins'], kind)
		const declaredRate = declared['rate']
		if (declaredRate !== undefined && !isRecord(declaredRate)) {
			this.#problem(where, `admission.rate is not an object of buckets (allowed: ${allowed})`)
		}
		for (const [bucket, value] of Object.entries(isRecord(declaredRate) ? declaredRate : {})) {
			if (!Object.hasOwn(rate, bucket)) {
				this.#problem(where, `admission.rate.${bucket} is not a bucket (allowed: perClient, perCaller, perEndpoint, bytesPerHour)`)
				continue
			}
			const field = bucket === 'perClient' || bucket === 'perCaller' || bucket === 'perEndpoint' || bucket === 'bytesPerHour' ? bucket : null
			if (field === null) continue
			if (field === 'perClient' && kind !== 'public') {
				this.#problem(where, 'admission.rate.perClient counts by the client address, which only a public procedure does (allowed: perCaller)')
			} else if (field === 'perCaller' && kind === 'public') {
				this.#problem(where, 'admission.rate.perCaller counts by the caller, and a public procedure has none (allowed: perClient)')
			} else if (field === 'bytesPerHour' && files === null) {
				this.#problem(where, 'admission.rate.bytesPerHour bounds the bytes of file fields, and the input declares none')
			} else if (field === 'bytesPerHour' && typeof value === 'number' && value < (files?.largest ?? 0)) {
				this.#problem(where, `admission.rate.bytesPerHour ${value} is less than the ${files?.largest ?? 0} bytes one of its files may hold`)
			}
			const [ceiling, unit] = field === 'bytesPerHour'
				? [PROCEDURE_LIMITS.maxBytesPerHour, 'bytes per hour']
				: [PROCEDURE_LIMITS.maxPerMinute, 'calls per minute']
			rate[field] = value === null ? null : this.#bounded(where, `admission.rate.${field}`, value, rate[field] ?? 1, ceiling, unit)
		}
		const challenge = declared['challenge']
		if (challenge === undefined) {
			return { origins, rate, challenge: null }
		}
		if (kind !== 'public' || !isRecord(challenge)) {
			this.#problem(where, kind === 'public' ? 'admission.challenge is not an object' : 'admission.challenge belongs to a public procedure only')
			return { origins, rate, challenge: null }
		}
		const fields = procedure.input?.type === 'object' ? procedure.input.fields : {}
		return { origins, rate, challenge: this.#formChallenge(challengeAction(id), where, challenge, fields) ?? null }
	}

	#origins(where: string, value: unknown, kind: 'public' | 'credentialed' | 'link'): AdmissionOrigins {
		if (value === undefined || value === 'same-origin') {
			return 'same-origin'
		}
		if ((value === 'listed' && kind !== 'link') || (value === 'any' && kind === 'public')) {
			return value
		}
		const allowed = kind === 'public' ? "'same-origin', 'listed' or 'any'" : kind === 'link' ? "'same-origin'" : "'same-origin' or 'listed'"
		this.#problem(where, `admission.origins ${JSON.stringify(value)} is not an origin rule here (allowed: ${allowed})`)
		return 'same-origin'
	}

	/**
	 * A procedure's or a form's `crossOrigin` (ADR-0022 "Cross-origin endpoints"): `true` admits the origins the
	 * environment lists, `'*'` (a form only, `any`) every origin. Absent stays absent, so the row keeps its digest.
	 */
	#crossOrigin(where: string, value: unknown, anyOrigin: boolean): { readonly crossOrigin?: CrossOriginForm } {
		if (value === undefined) {
			return {}
		}
		if (value === true) {
			return { crossOrigin: 'environment' }
		}
		if (anyOrigin && value === '*') {
			return { crossOrigin: 'any' }
		}
		const allowed = anyOrigin ? "crossOrigin: true for the environment's listed origins, or crossOrigin: '*' for any" : 'crossOrigin: true'
		this.#problem(where, `crossOrigin ${JSON.stringify(value)} is not a cross-origin form (allowed: ${allowed})`)
		return {}
	}

	/** A procedure no page on another origin may call: `caller` is who calls it instead. */
	#noCrossOrigin(where: string, value: unknown, caller: string): { readonly crossOrigin?: CrossOriginForm } {
		if (value !== undefined) {
			this.#problem(where, `is called by ${caller}, never cross-origin (only an RPC procedure of c.rpc and a form take crossOrigin)`)
		}
		return {}
	}

	/**
	 * A procedure's answer: its output schema, or for an `attachment()` the file it encodes from the rows. A column is a
	 * scalar cell, the name is fixed and safe in a header, and each limit is within `ATTACHMENT_LIMITS`.
	 */
	#output(where: string, procedure: ProcedureDeclaration<SchemaShape, unknown>): OutputShape {
		if (procedure.redirect !== undefined) {
			return this.#redirect(where, procedure.redirect.origins)
		}
		if (procedure.output.type === 'file') {
			this.#fileKind(`${where} output`, procedure.output.kind)
			return procedure.output
		}
		if (containsFile(procedure.output)) {
			this.#problem(where, "answers JSON with a file inside, which JSON cannot carry (allowed: output: file('<kind>'), or the file's reference fields)")
		}
		const attachment = procedure.attachment
		if (attachment === undefined) {
			return procedure.output
		}
		const at = `${where} attachment`
		this.#options(at, 'attachment', attachment.unknownOptions)
		const format: AttachmentFormat = attachment.format === 'xlsx' ? 'xlsx' : 'csv'
		if (attachment.format !== format) {
			this.#problem(at, `format '${attachment.format}' is not a file format the framework encodes (allowed: 'csv', 'xlsx')`)
		}
		const filename = ATTACHMENT_FILENAMES[format]
		if (!filename.test(attachment.filename)) {
			this.#problem(at, `filename '${attachment.filename}' is not a file name (allowed: ${filename.source})`)
		}
		const maxBytes = this.#attachmentLimit(at, 'maxBytes', attachment.maxBytes, ATTACHMENT_LIMITS.maxBytes)
		const maxRows = this.#attachmentLimit(at, 'maxRows', attachment.maxRows ?? ATTACHMENT_LIMITS.defaultMaxRows, ATTACHMENT_LIMITS.maxRows)
		const items = procedure.output.type === 'array' ? procedure.output.items : null
		if (items?.type !== 'object') {
			this.#problem(at, 'the row is not an object (allowed: row: z.strictObject({ … }))')
			return procedure.output
		}
		const columns = Object.entries(items.fields).map(([name, shape]) => ({ name, shape }))
		if (columns.length === 0) {
			this.#problem(at, 'the row has no field, so the file would have no column')
		}
		for (const column of columns) {
			if (!isCell(column.shape)) {
				this.#problem(at, `column '${column.name}' is not a cell (allowed: a string, number, boolean, enum or literal, optional or nullable)`)
			}
		}
		return { type: 'attachment', format, filename: attachment.filename, maxBytes, maxRows, columns }
	}

	/** A redirect's listed origins: exact `https://` origins, each once; the application's own needs none. */
	#redirect(where: string, origins: readonly string[]): OutputShape {
		this.#unique(where, 'redirect origins', origins)
		for (const origin of origins) {
			if (!isPolicyOrigin(origin)) {
				this.#problem(where, `redirect origin '${origin}' is not an exact https origin (allowed: 'https://shop.example')`)
			}
		}
		return { type: 'redirect', origins: [...origins] }
	}

	#attachmentLimit(where: string, field: string, value: number, ceiling: number): number {
		if (!Number.isInteger(value) || value < 1 || value > ceiling) {
			this.#problem(where, `${field} ${value} is not a whole number from 1 to ${ceiling}`)
		}
		return value
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
		kind: 'health' | 'form' | 'webhook' | 'public-spa',
		method: 'GET' | 'POST',
		path: string,
		admission: BodyAdmission | null,
		input: SchemaShape | null,
		crossOrigin: { readonly crossOrigin?: CrossOriginForm } = {},
	): void {
		this.#row({
			id: name,
			source: { kind: 'mount', name },
			kind,
			method,
			path,
			callers: [],
			requirement: null,
			admission,
			input,
			output: null,
			...crossOrigin,
		})
	}

	/** A row that answers a stored file carries the file-response profile, which its digest covers. */
	#row(row: EndpointRow): void {
		const where = `endpoint '${row.id}'`
		// A token travels only as a top-level field of a procedure's own input, never into an export's consumer.
		const carries = (row.kind === 'query' || row.kind === 'mutation' || row.kind === 'public') && row.source.kind === 'mount'
		if (row.input !== null) {
			this.#tokenFields(`${where} input`, row.input, carries)
		}
		if (row.output !== null && isSchemaOutput(row.output)) {
			this.#tokenFields(`${where} output`, row.output, false)
		}
		this.#endpoints.push(row.output?.type === 'file' ? { ...row, response: 'file' } : row)
	}

	/**
	 * Every signed token field of `shape`: a declared purpose, and, where `topLevel` allows it, a field of the object
	 * itself (optional or not); anywhere else a token is refused, since the framework verifies only those.
	 */
	#tokenFields(where: string, shape: SchemaShape, topLevel: boolean): void {
		const visit = (at: SchemaShape, top: boolean): void => {
			switch (at.type) {
				case 'token':
					if (!top) {
						this.#problem(
							where,
							`carries signedToken('${at.purpose}') where the framework does not verify it (allowed: a top-level field of a procedure's input or http.query)`,
						)
					}
					this.#knownPurpose(where, at.purpose)
					return
				case 'object':
					for (const field of Object.values(at.fields)) visit(field, top && at === shape)
					return
				case 'optional':
					visit(at.inner, top)
					return
				case 'nullable':
				case 'array':
					visit(at.type === 'array' ? at.items : at.inner, false)
					return
				case 'tuple':
					for (const item of [...at.items, ...(at.rest === null ? [] : [at.rest])]) visit(item, false)
					return
				case 'record':
					visit(at.value, false)
					return
				case 'union':
					for (const option of at.options) visit(option, false)
					return
				default:
					return
			}
		}
		visit(shape, topLevel)
	}

	#knownPurpose(where: string, purpose: string): void {
		const tokens = this.#contract.tokens ?? {}
		if (!Object.hasOwn(tokens, purpose)) {
			this.#problem(
				where,
				`signedToken('${purpose}') names no token purpose of defineApp's options${
					suggestion(purpose, Object.keys(tokens))
				} (allowed: tokens: { ${purpose}: token(Claims, { maxDays }) })`,
			)
		}
	}

	/**
	 * The token purposes: each a name, its claims a strict object that carries no token, its `maxDays` a whole number of
	 * days up to `TOKEN_MAX_DAYS`.
	 */
	#tokens(): Record<string, TokenPurposeArtifact> {
		const tokens: Record<string, TokenPurposeArtifact> = {}
		for (const [purpose, declared] of Object.entries(this.#contract.tokens ?? {})) {
			const where = `token '${purpose}'`
			if (!this.#name(where, purpose)) {
				continue
			}
			if (!isRecord(declared) || !hasExactKeys(declared, ['claims', 'maxDays'])) {
				this.#problem(where, 'is not built with token(Claims, { maxDays })')
				continue
			}
			this.#objectSchema(`${where} claims`, declared.claims)
			this.#tokenFields(`${where} claims`, declared.claims, false)
			const maxDays = this.#bounded(where, 'maxDays', declared.maxDays, 1, TOKEN_MAX_DAYS, 'days')
			tokens[purpose] = { claims: declared.claims, maxDays }
		}
		return tokens
	}

	#reserve(prefix: string | null): void {
		if (prefix !== null && !this.#reservedPrefixes.includes(prefix)) {
			this.#reservedPrefixes.push(prefix)
		}
	}

	// ── Requirements ────────────────────────────────────────────────────────────────────────────

	#requirement(where: string, procedure: ProcedureDeclaration<SchemaShape>): EndpointRequirement | null {
		const access: AccessDeclaration = procedure.access
		if ('capabilities' in access) {
			return this.#capabilities(where, procedure, access)
		}
		const form = accessForm(access)
		if (form === null) {
			this.#problem(
				where,
				`access ${
					JSON.stringify(access)
				} is not one access form (allowed: { member: true }, { action, over }, { action, in, from }, { action, on, from }, { action, creates }, { action, app: true })`,
			)
			return null
		}
		if (form.form === 'member') {
			return { kind: 'member' }
		}
		this.#knownAction(where, form.action)
		if (form.access.form !== 'app') {
			this.#knownDimension(where, form.access.dimension)
		}
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

	/**
	 * Several capabilities, each an action `over` a dimension or `on` or `in` the value an input field names: at least two,
	 * by names the handler reads (`ctx.capabilities.<name>`). Several fields may name one value.
	 */
	#capabilities(
		where: string,
		procedure: ProcedureDeclaration<SchemaShape>,
		access: { readonly capabilities: Readonly<Record<string, CapabilityDeclaration>> },
	): EndpointRequirement | null {
		const allowed = '{ capabilities: { <name>: { action, over } | { action, in, from } | { action, on, from }, … } }, at least two'
		if (!hasExactKeys(access, ['capabilities']) || !isRecord(access.capabilities) || Object.keys(access.capabilities).length < 2) {
			this.#problem(where, `access ${JSON.stringify(access)} is not several capabilities (allowed: ${allowed})`)
			return null
		}
		const capabilities: Record<string, CapabilityRequirement> = {}
		for (const [name, declared] of Object.entries(access.capabilities)) {
			const at = `${where} capability '${name}'`
			const form = accessForm(declared)
			if (!this.#name(at, name) || form === null || form.form !== 'action' || !isCapabilityForm(form.access)) {
				if (form !== null) this.#problem(at, `is not one capability (allowed: { action, over }, { action, in, from }, { action, on, from })`)
				else {this.#problem(
						at,
						`${JSON.stringify(declared)} is not one access form (allowed: { action, over }, { action, in, from }, { action, on, from })`,
					)}
				continue
			}
			this.#knownAction(at, form.action)
			this.#knownDimension(at, form.access.dimension)
			if (form.access.form !== 'over') {
				this.#fromField(at, procedure.input, form.access.from)
			}
			capabilities[name] = { action: form.action, access: form.access }
		}
		return { kind: 'capabilities', capabilities }
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

	/** `'public'` is the anonymous `public-spa` row: no requirement at all. */
	#spaRequirement(where: string, access: SpaAccessDeclaration): EndpointRequirement | 'public' | null {
		if (hasExactKeys(access, ['public']) && 'public' in access && access.public === true) {
			return 'public'
		}
		if (hasExactKeys(access, ['member']) && 'member' in access && access.member === true) {
			return { kind: 'member' }
		}
		if (hasExactKeys(access, ['action', 'over']) && 'over' in access) {
			this.#knownAction(where, access.action)
			this.#knownDimension(where, access.over)
			return { kind: 'action', action: access.action, access: { form: 'over', dimension: access.over } }
		}
		if (hasExactKeys(access, ['action', 'app']) && 'app' in access && access.app === true) {
			this.#knownAction(where, access.action)
			return { kind: 'action', action: access.action, access: { form: 'app' } }
		}
		this.#problem(
			where,
			`access ${JSON.stringify(access)} is not an SPA access (allowed: { member: true }, { action, over }, { action, app: true } or { public: true })`,
		)
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
			if (collection.kind === 'file-kind') {
				continue
			}
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
			const paths = fileCollectionPaths(FILES_PREFIX, name)
			const [firstType, ...otherTypes] = collection.types
			if (firstType !== undefined) {
				this.#row({
					id: `files.${name}.upload`,
					source,
					kind: 'upload',
					method: 'POST',
					path: `${paths.upload}/:owner`,
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
				path: `${paths.download}/:fileId`,
				callers: ['human'],
				requirement: { kind: 'action', action: collection.read, access: { form: 'on', dimension, from: 'fileId' } },
				admission: null,
				input: null,
				output: null,
			})
			this.#row({
				id: `files.${name}.list`,
				source,
				kind: 'query',
				method: 'POST',
				path: paths.list,
				callers: ['human'],
				requirement: { kind: 'action', action: collection.read, access: { form: 'on', dimension: owner.scope.dimension, from: 'owner' } },
				admission: JSON_ADMISSION,
				input: FILE_LIST_INPUT,
				output: FILE_LIST_OUTPUT,
			})
			this.#row({
				id: `files.${name}.remove`,
				source,
				kind: 'mutation',
				method: 'POST',
				path: paths.remove,
				callers: ['human'],
				requirement: { kind: 'action', action: collection.delete, access: { form: 'on', dimension, from: 'id' } },
				admission: JSON_ADMISSION,
				input: ID_OBJECT,
				output: ID_OBJECT,
			})
			if (artifact.link !== false) {
				this.#linkFiles(where, name, collection, owner.scope.dimension, artifact.link)
			}
		}
		return files
	}

	/**
	 * The rows a link holder reaches a collection by (upload, list, download): under the API prefix of every link mount
	 * bound to the owner's dimension (`link: true`) or of each one `link` names, caller `link`, the owner being the
	 * link's object (no parameter names it). A serving mount grants the collection's write and read actions, so a key of
	 * it can do what the rows require; a mount `link` does not name serves no row and need not grant them.
	 */
	#linkFiles(where: string, name: string, collection: FilesDeclaration, ownerDimension: string, link: true | readonly string[]): void {
		const bound = Object.entries(this.#contract.mounts).flatMap(([mountName, mount]) =>
			mount.kind === 'link' && mount.dimension === ownerDimension ? [{ mountName, mount }] : []
		)
		const boundForm = `c.link(prefix, { dimension: '${ownerDimension}', … })`
		if (link === true && bound.length === 0) {
			this.#problem(where, `sets link: true, and no link mount is bound to '${ownerDimension}' (allowed: ${boundForm})`)
		}
		const mounts = link === true ? bound : link.flatMap((mountName) => {
			const found = bound.find((candidate) => candidate.mountName === mountName)
			if (found === undefined) {
				const allowed = bound.length === 0 ? boundForm : bound.map((candidate) => candidate.mountName).join(', ')
				this.#problem(where, `link names '${mountName}', which is no link mount bound to '${ownerDimension}' (allowed: ${allowed})`)
			}
			return found === undefined ? [] : [found]
		})
		const [firstType, ...otherTypes] = collection.types
		for (const { mountName, mount } of mounts) {
			const missing = [collection.write, collection.read].filter((action, index, all) => all.indexOf(action) === index && !mount.grants.includes(action))
			if (missing.length > 0) {
				const subject = link === true ? `sets link: true, and link mount '${mountName}'` : `link names mount '${mountName}', which`
				this.#problem(
					where,
					`${subject} grants no ${missing.map((action) => `'${action}'`).join(' or ')} (allowed: grants: [${
						[...mount.grants, ...missing].map((action) => `'${action}'`).join(', ')
					}])`,
				)
				continue
			}
			const source: EndpointSource = { kind: 'mount', name: mountName }
			const paths = fileCollectionPaths(joinPath(mount.prefix, LINK_API_SEGMENT), name)
			const ofTheLink = (action: string): EndpointRequirement => ({
				kind: 'action',
				action,
				access: { form: 'on', dimension: ownerDimension, from: null },
			})
			if (firstType !== undefined) {
				this.#row({
					id: `${mountName}.files.${name}.upload`,
					source,
					kind: 'upload',
					method: 'POST',
					path: paths.upload,
					callers: ['link'],
					requirement: ofTheLink(collection.write),
					admission: { contentTypes: [firstType, ...otherTypes], maxBytes: collection.maxBytes },
					input: null,
					output: ID_OBJECT,
				})
			}
			this.#row({
				id: `${mountName}.files.${name}.list`,
				source,
				kind: 'query',
				method: 'POST',
				path: paths.list,
				callers: ['link'],
				requirement: ofTheLink(collection.read),
				admission: JSON_ADMISSION,
				input: FILE_LINK_LIST_INPUT,
				output: FILE_LIST_OUTPUT,
			})
			this.#row({
				id: `${mountName}.files.${name}.download`,
				source,
				kind: 'download',
				method: 'GET',
				path: `${paths.download}/:fileId`,
				callers: ['link'],
				requirement: ofTheLink(collection.read),
				admission: null,
				input: null,
				output: null,
			})
		}
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
		const link = this.#fileLink(where, collection.link)
		this.#fileTypes(where, collection)
		return {
			owner: collection.owner,
			read: collection.read,
			write: collection.write,
			delete: collection.delete,
			maxBytes: collection.maxBytes,
			types: [...collection.types],
			maxPerOwner: collection.maxPerOwner ?? CONTRACT_DEFAULTS.fileMaxPerOwner,
			link,
			...(collection.scan === true ? { scan: true } : {}),
		}
	}

	/** The media types and the scan of a file kind or a collection: exact types, and a scan that can vouch for each file. */
	#fileTypes(where: string, declared: Pick<FileKindDeclaration, 'types' | 'maxBytes' | 'scan'>): void {
		this.#unique(where, 'types', declared.types)
		for (const type of declared.types) {
			if (!MIME_TYPE.test(type)) {
				this.#problem(where, `'${type}' is not an exact media type (allowed: 'image/png'; no wildcards or parameters)`)
			}
		}
		if (declared.types.length === 0) {
			this.#problem(where, 'admits no media type (allowed: types: [<exact media types>])')
		}
		if (declared.scan !== undefined && typeof declared.scan !== 'boolean') {
			this.#problem(where, 'scan is true or false')
		}
		for (const type of declared.scan === true ? declared.types.filter((candidate) => FILE_LIMITS.unscannedTypes.includes(candidate)) : []) {
			this.#problem(
				where,
				`scans its files and admits '${type}', an archive the framework does not open, so no scan can vouch for its contents (allowed: application/zip, which the framework checks entry by entry)`,
			)
		}
		if (declared.scan === true && declared.maxBytes > FILE_LIMITS.maxScannedBytes) {
			this.#problem(
				where,
				`scans its files and admits ${declared.maxBytes} bytes per file; the scanner gives a clean verdict to at most ${FILE_LIMITS.maxScannedBytes} (allowed: maxBytes: ${FILE_LIMITS.maxScannedBytes} or less)`,
			)
		}
	}

	/** The file kinds (`c.files({ types, maxBytes, scan? })`), before the mounts that name them. */
	#readFileKinds(): Record<string, FileKindArtifact> {
		const kinds: Record<string, FileKindArtifact> = {}
		for (const [name, declared] of Object.entries(this.#contract.files)) {
			if (declared.kind !== 'file-kind') {
				continue
			}
			const where = `files '${name}'`
			if (!this.#name(where, name)) {
				continue
			}
			this.#options(where, 'fileKind', declared.unknownOptions)
			this.#positiveInteger(`${where} maxBytes`, declared.maxBytes)
			if (declared.maxBytes > PROCEDURE_LIMITS.maxFileBodyBytes) {
				this.#problem(
					where,
					`admits ${declared.maxBytes} bytes per file, more than the ${PROCEDURE_LIMITS.maxFileBodyBytes} bytes a request may carry (allowed: maxBytes: ${PROCEDURE_LIMITS.maxFileBodyBytes} or less)`,
				)
			}
			this.#fileTypes(where, declared)
			kinds[name] = { types: [...declared.types], maxBytes: declared.maxBytes, ...(declared.scan === true ? { scan: true } : {}) }
		}
		return kinds
	}

	/** A file kind the contract declares, by the name a file field, a file output or a file column gives. */
	#fileKind(where: string, kind: string): FileKindArtifact | null {
		const found = Object.hasOwn(this.#fileKinds, kind) ? this.#fileKinds[kind] : undefined
		if (found === undefined) {
			const declared = Object.keys(this.#fileKinds)
			this.#problem(
				where,
				`names the file kind '${kind}', which the contract does not declare (allowed: ${
					declared.length === 0 ? 'files: { <kind>: c.files({ types, maxBytes }) }' : declared.join(', ')
				})`,
			)
			return null
		}
		return found
	}

	/** `link` as the artifact holds it: a boolean, or the link mounts it names, each once. */
	#fileLink(where: string, link: FilesDeclaration['link']): boolean | readonly string[] {
		if (link === undefined || typeof link === 'boolean') return link ?? CONTRACT_DEFAULTS.fileLink
		if (link.length === 0) this.#problem(where, "link names no mount (allowed: link: true, or link: ['<link mount>'])")
		this.#unique(where, 'link', link)
		return [...link]
	}

	#jobs(): Record<string, JobArtifact> {
		const jobs: Record<string, JobArtifact> = {}
		for (const [name, job] of Object.entries(this.#contract.jobs)) {
			const where = `job '${name}'`
			if (!this.#name(where, name) || !this.#kind(where, job, 'cron', "c.cron('<schedule>', { … })")) {
				continue
			}
			const scope = this.#job(where, job)
			this.#declare(where, `${JOB_SITE_PREFIX}${name}`, job.declared, { kind: 'job', readOnly: false, actions: job.actions })
			if (scope !== null) {
				jobs[name] = {
					schedule: job.schedule,
					actions: [...job.actions],
					scope,
					timeoutMs: this.#jobLimits(where, job.limits),
					retries: job.retries ?? CONTRACT_DEFAULTS.jobRetries,
				}
			}
		}
		return jobs
	}

	/** A job's `limits`: its attempt's time only, since a job reads no body. */
	#jobLimits(where: string, value: unknown): number {
		if (value === undefined) {
			return JOB_LIMITS.timeoutMs
		}
		if (!isRecord(value)) {
			this.#problem(where, 'limits is not an object (allowed: limits: { timeoutMs? })')
			return JOB_LIMITS.timeoutMs
		}
		if (value['maxBytes'] !== undefined) {
			this.#problem(where, 'declares limits.maxBytes, and a job reads no body (allowed: limits: { timeoutMs? })')
		}
		this.#keys(`${where} limits`, value, ['maxBytes', 'timeoutMs'])
		return this.#bounded(where, 'limits.timeoutMs', value['timeoutMs'], JOB_LIMITS.timeoutMs, JOB_LIMITS.maxTimeoutMs, 'ms')
	}

	#job(where: string, job: CronDeclaration): ScopeBinding | null {
		this.#options(where, 'cron', job.unknownOptions)
		const fields = job.schedule.split(' ')
		if (fields.length !== 5 || !fields.every((field) => CRON_FIELD.test(field))) {
			this.#problem(where, `schedule '${job.schedule}' is not five cron fields separated by single spaces (allowed: '0 3 * * *')`)
		}
		this.#actionList(where, job.actions)
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
				if (!('action' in procedure.access)) {
					// The consumer's key holds exactly the export's actions, so a `member` procedure would have none to hold.
					this.#problem(`procedure '${id}'`, 'an export procedure names its action (allowed: { action, over })')
				} else if ('app' in procedure.access) {
					this.#problem(
						`procedure '${id}'`,
						'an export procedure reads in one dimension (allowed: { action, over }, { action, in, from }, { action, on, from })',
					)
				}
				if (procedure.attachment !== undefined) {
					this.#problem(`procedure '${id}'`, 'an export answers its consumers JSON; an attachment() is for an RPC or a link procedure')
				}
				this.#readAction(`procedure '${id}'`, procedure.access)
				this.#procedure(source, id, joinPath(CONNECT_PREFIX, id), callers, procedure)
				this.#declare(`procedure '${id}'`, id, procedure.declared, { kind: 'export', readOnly: true })
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
		const dimensionOf = (requirement: EndpointRequirement): string | null =>
			requirement.kind === 'action' && requirement.access.form !== 'app' ? requirement.access.dimension : null
		const dimension = dimensionOf(first)
		if (first.kind === 'action' && dimension === null) {
			// `#exports` refused the app form already: a description needs one dimension.
			return null
		}
		if (first.kind === 'capabilities') {
			// `#exports` refused several capabilities already: a consumer's key holds one action.
			return null
		}
		const description: EndpointRequirement = first.kind === 'member' || dimension === null
			? first
			: { kind: 'action', action: first.action, access: { form: 'over', dimension } }
		const same = requirements.every((requirement) =>
			requirement !== null && requirement.kind !== 'capabilities' && (requirement.kind === 'member'
				? description.kind === 'member'
				: description.kind === 'action' && requirement.action === description.action && dimensionOf(requirement) === dimension)
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
			this.#import(where, name, declaration, procedureIds)
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

	#import(where: string, name: string, declaration: ImportDeclaration, procedureIds: ReadonlySet<string>): void {
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
		for (const id of this.#connected.get(name) ?? []) {
			if (!declaration.usedBy.includes(id)) {
				this.#problem(where, `is not used by '${id}', which declares connect: ['${name}'] (allowed: usedBy naming every endpoint that connects)`)
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
		const scriptSrc = this.#cspSources('csp scriptSrc', this.#withChallengeOrigins('scriptSrc', declaration.scriptSrc ?? []))
		const frameSrc = this.#cspSources('csp frameSrc', this.#withChallengeOrigins('frameSrc', declaration.frameSrc ?? []))
		const styleSrc = this.#cspSources('csp styleSrc', declaration.styleSrc ?? [])
		const fontSrc = this.#cspSources('csp fontSrc', declaration.fontSrc ?? [])
		return {
			connectSrc: this.#cspSources('csp connectSrc', declaration.connectSrc ?? []),
			imgSrc: this.#cspSources('csp imgSrc', declaration.imgSrc ?? []),
			frameAncestors: this.#cspSources('csp frameAncestors', declaration.frameAncestors ?? []),
			...(scriptSrc.length === 0 ? {} : { scriptSrc }),
			...(frameSrc.length === 0 ? {} : { frameSrc }),
			...(styleSrc.length === 0 ? {} : { styleSrc }),
			...(fontSrc.length === 0 ? {} : { fontSrc }),
		}
	}

	/** The declared sources, plus each fixed origin a form's challenge provider loads that the contract does not name itself. */
	#withChallengeOrigins(directive: 'scriptSrc' | 'frameSrc', declared: readonly CspSource[]): CspSource[] {
		const sources = [...declared]
		for (const provider of new Set(this.#challenges.map((challenge) => challenge.provider))) {
			const forms = this.#challenges.filter((challenge) => challenge.provider === provider).map((challenge) => challenge.form).sort()
			for (const origin of CHALLENGE_ORIGINS[provider][directive]) {
				if (!sources.some((source) => source.origin === origin)) {
					sources.push({ origin, purpose: `the ${provider} challenge of ${forms.map((form) => `'${form}'`).join(', ')}` })
				}
			}
		}
		return sources
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

	/** An RPC mount's promise to its callers; `unchecked` when it makes none. */
	#compatibility(where: string, value: unknown): 'backward' | 'unchecked' {
		if (value === undefined || value === 'unchecked' || value === 'backward') {
			return value ?? 'unchecked'
		}
		this.#problem(where, `compatibility ${JSON.stringify(value)} is not a promise (allowed: compatibility: 'backward' or 'unchecked')`)
		return 'unchecked'
	}

	// ── Declared reach ──────────────────────────────────────────────────────────────────────────

	/**
	 * What a site of the staged kit declares off the paved road, parsed: the static reader copies it from source
	 * unchecked. A site that declares anything is recorded under `site`; a read-only site declares only `'read'`.
	 */
	#declare(where: string, site: string, value: unknown, place: DeclaringSite): void {
		if (value === undefined) {
			return
		}
		this.#kit = true
		if (!isRecord(value)) {
			this.#problem(where, `declares its reach as something other than an object (allowed: ${DECLARED_ALLOWED})`)
			return
		}
		for (const key of Object.keys(value)) {
			if (!DECLARED_FIELDS.some((field) => field === key)) {
				this.#problem(where, `'${key}' is not a declared field (allowed: ${DECLARED_ALLOWED})`)
			}
		}
		const workload = place.kind === 'rpc' ? place.actions : null
		if (workload !== null) {
			for (const field of ['sql', 'unscoped', 'connect', 'issues', 'binds'] as const) {
				if (value[field] !== undefined) {
					this.#problem(where, `is public and declares ${field}: a public procedure reaches its actions only (allowed: kicks, signs)`)
				}
			}
		}
		const then = this.#then(where, value['then'], place)
		const mailer = this.#mailer(where, value['mailer'], place)
		const kicks = this.#kicks(where, value['kicks'], place)
		const binds = this.#binds(where, value['binds'], place)
		const signs = this.#signs(where, value['signs'], place)
		const egress = this.#egress(where, value['egress'], place)
		const reach: DeclaredReach = {
			sql: this.#sqlMode(where, value['sql'], place.readOnly),
			unscoped: this.#unscoped(where, value['unscoped'], place.readOnly),
			connect: place.kind === 'rpc' ? this.#connect(where, site, value['connect']) : [],
			issues: place.kind === 'rpc'
				? this.#issues(where, value['issues'], place.access)
				: place.kind === 'job'
				? this.#jobIssues(where, value['issues'], place.actions)
				: null,
			...(then === undefined ? {} : { then }),
			...(mailer === undefined ? {} : { mailer }),
			...(workload === null || workload.length === 0 ? {} : { actions: workload }),
			...(kicks.length === 0 ? {} : { kicks }),
			...(binds === undefined ? {} : { binds }),
			...(signs.length === 0 ? {} : { signs }),
			...(egress.length === 0 ? {} : { egress }),
		}
		if (place.kind !== 'rpc') {
			this.#rpcOnly(where, 'connect', value['connect'])
		}
		if (place.kind !== 'rpc' && place.kind !== 'job' && value['issues'] !== undefined) {
			this.#problem(where, 'declares issues, which only an endpoint of an RPC mount or a cron job declares')
		}
		if (
			reach.sql !== null || Object.keys(reach.unscoped).length > 0 || reach.connect.length > 0 || reach.issues !== null || reach.then !== undefined
			|| reach.mailer !== undefined || reach.actions !== undefined || reach.kicks !== undefined || reach.binds !== undefined
			|| reach.signs !== undefined || reach.egress !== undefined
		) {
			this.#declared[site] = reach
		}
	}

	#sqlMode(where: string, value: unknown, readOnly: boolean): DeclaredReach['sql'] {
		if (value === undefined) {
			return null
		}
		if (value !== 'read' && value !== 'write') {
			this.#problem(where, `sql ${JSON.stringify(value)} is not a mode (allowed: sql: 'read' or 'write')`)
			return null
		}
		if (readOnly && value === 'write') {
			this.#problem(where, "declares sql: 'write', and it runs read-only (allowed: sql: 'read')")
		}
		return value
	}

	#unscoped(where: string, value: unknown, readOnly: boolean): DeclaredReach['unscoped'] {
		if (value === undefined) {
			return {}
		}
		if (!isRecord(value)) {
			this.#problem(where, "unscoped is not an object of tables (allowed: unscoped: { <table>: 'read' | 'write' })")
			return {}
		}
		const unscoped: Record<string, 'read' | 'write'> = {}
		for (const [table, mode] of Object.entries(value)) {
			if (table.startsWith(FRAMEWORK_TABLE_PREFIX)) {
				this.#problem(where, `unscoped '${table}' is a table the framework keeps; ${FRAMEWORK_TABLE_PREFIX}* is reserved`)
			} else if (!Object.hasOwn(this.#tables, table)) {
				this.#problem(where, `unscoped '${table}' is not a table of src/db/tables.ts${suggestion(table, Object.keys(this.#tables))}`)
			}
			if (mode !== 'read' && mode !== 'write') {
				this.#problem(where, `unscoped '${table}' has the mode ${JSON.stringify(mode)} (allowed: 'read' or 'write')`)
				continue
			}
			if (readOnly && mode === 'write') {
				this.#problem(where, `declares unscoped '${table}': 'write', and it runs read-only (allowed: 'read')`)
			}
			const scope = Object.hasOwn(this.#tables, table) ? this.#tables[table]?.scope.mode : undefined
			if (mode === 'write' && scope === 'reference') {
				this.#problem(
					where,
					`declares unscoped '${table}': 'write', and no site writes a reference table: its rows come from a migration (allowed: 'read')`,
				)
			} else if (mode === 'write' && scope === 'inbox') {
				this.#problem(where, `declares unscoped '${table}': 'write', and only its form writes a form's inbox (allowed: 'read')`)
			}
			unscoped[table] = mode
		}
		return unscoped
	}

	#connect(where: string, site: string, value: unknown): string[] {
		if (value === undefined) {
			return []
		}
		if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
			this.#problem(where, "connect is not a list of import names (allowed: connect: ['<import>'])")
			return []
		}
		const names: string[] = value.filter((name) => typeof name === 'string')
		this.#unique(where, 'connect', names)
		for (const name of names) {
			if (!Object.hasOwn(this.#contract.imports, name)) {
				this.#problem(where, `connect '${name}' is not an import of the application${suggestion(name, Object.keys(this.#contract.imports))}`)
			}
			this.#connected.set(name, [...(this.#connected.get(name) ?? []), site])
		}
		return names
	}

	/** The link mount `issues` names, or null after a problem; `undefined` when the site declares none. */
	#issuedMount(where: string, value: unknown): { readonly name: string; readonly mount: LinkMountDeclaration<SchemaShape> | null } | null | undefined {
		if (value === undefined) {
			return undefined
		}
		if (typeof value !== 'string') {
			this.#problem(where, "issues is not a link mount's name (allowed: issues: '<link mount>')")
			return null
		}
		const mount = Object.hasOwn(this.#contract.mounts, value) ? this.#contract.mounts[value] : undefined
		if (mount?.kind !== 'link') {
			this.#problem(where, `issues '${value}', which is not a link mount of the contract`)
			return { name: value, mount: null }
		}
		return { name: value, mount }
	}

	/**
	 * A job issues the links of a mount when its actions hold the mount's `issuedBy` and every grant: IAM checks the same
	 * against the job's declaration, app-wide, so the job issues for any object of the mount's dimension.
	 */
	#jobIssues(where: string, value: unknown, actions: readonly string[]): string | null {
		const issued = this.#issuedMount(where, value)
		if (issued === undefined || issued === null) {
			return null
		}
		const { name, mount } = issued
		const missing = mount === null ? [] : [mount.issuedBy, ...mount.grants].filter((action) => !actions.includes(action))
		if (missing.length > 0) {
			this.#problem(where, `issues '${name}', whose links need ${missing.map((action) => `'${action}'`).join(', ')} among the job's actions`)
		}
		return name
	}

	/** `issues` names a link mount whose links this endpoint's own capability can issue: its action on its dimension. */
	#issues(where: string, value: unknown, access: AccessDeclaration): string | null {
		const issued = this.#issuedMount(where, value)
		if (issued === undefined || issued === null) {
			return null
		}
		const { name, mount } = issued
		if (mount === null) {
			return name
		}
		const target = 'on' in access ? access.on : 'in' in access ? access.in : null
		if (target !== mount.dimension || !('action' in access) || access.action !== mount.issuedBy) {
			this.#problem(
				where,
				`issues '${name}', whose links a '${mount.issuedBy}' capability on a '${mount.dimension}' issues (allowed: access: { action: '${mount.issuedBy}', on: '${mount.dimension}', from })`,
			)
		}
		return name
	}

	/**
	 * The webhook whose bindings a credentialed mutation of an RPC mount creates and removes: a webhook of this contract.
	 * `undefined` when it declares none or after a problem.
	 */
	#binds(where: string, value: unknown, place: DeclaringSite): string | undefined {
		if (value === undefined) {
			return undefined
		}
		if (place.kind !== 'rpc' || place.readOnly || place.actions !== null) {
			// A public procedure is refused with the other reach it may not declare.
			if (place.kind !== 'rpc' || place.actions === null) {
				this.#problem(where, 'declares binds, which only a credentialed mutation of an RPC mount declares')
			}
			return undefined
		}
		const mounts = this.#contract.mounts
		const webhook = typeof value === 'string' && Object.hasOwn(mounts, value) ? mounts[value] : undefined
		if (typeof value !== 'string' || webhook?.kind !== 'webhook') {
			const names = Object.entries(mounts).filter(([, mount]) => mount.kind === 'webhook').map(([name]) => name)
			this.#problem(
				where,
				`binds ${JSON.stringify(value)} is not a webhook of the contract (webhooks: ${names.length === 0 ? 'none' : names.join(', ')})${
					typeof value === 'string' ? suggestion(value, names) : ''
				}`,
			)
			return undefined
		}
		return value
	}

	/**
	 * The token purposes a site signs (`ctx.tokens.sign`): a procedure of an RPC mount, a webhook or a job, never an export
	 * or a link procedure. Each names a purpose of `defineApp`'s options, once; `[]` when it declares none or after a problem.
	 */
	#signs(where: string, value: unknown, place: DeclaringSite): string[] {
		if (value === undefined) {
			return []
		}
		if (place.kind === 'export' || place.kind === 'link') {
			this.#problem(
				where,
				`declares signs, which ${
					place.kind === 'export' ? 'an export procedure' : 'a link procedure'
				} never does: a procedure of an RPC mount, a webhook or a job signs`,
			)
			return []
		}
		if (!Array.isArray(value) || value.length === 0 || !value.every((purpose) => typeof purpose === 'string')) {
			this.#problem(where, "signs is not a list of token purposes (allowed: signs: ['<token purpose>'])")
			return []
		}
		const purposes: string[] = value.filter((purpose) => typeof purpose === 'string')
		this.#unique(where, 'signs', purposes)
		for (const purpose of purposes) {
			this.#knownPurpose(where, purpose)
		}
		return [...new Set(purposes)].sort()
	}

	/**
	 * The HTTPS origins a site's code calls: a credentialed procedure of an RPC mount, a webhook or a job, never a public,
	 * export or link procedure. Each is an exact origin with no path or wildcard, once; `[]` when it declares none or after
	 * a problem.
	 */
	#egress(where: string, value: unknown, place: DeclaringSite): string[] {
		if (value === undefined) {
			return []
		}
		const refusedBy = place.kind === 'export'
			? 'an export procedure'
			: place.kind === 'link'
			? 'a link procedure'
			: place.kind === 'rpc' && place.actions !== null
			? 'a public procedure'
			: null
		if (refusedBy !== null) {
			this.#problem(where, `declares egress, which ${refusedBy} never does: a credentialed procedure, a webhook or a job calls out`)
			return []
		}
		if (!Array.isArray(value) || value.length === 0 || !value.every((origin) => typeof origin === 'string')) {
			this.#problem(where, "egress is not a list of origins (allowed: egress: ['https://api.example.com'])")
			return []
		}
		const origins: string[] = value.filter((origin) => typeof origin === 'string')
		if (origins.length > MAX_EGRESS_ORIGINS) {
			this.#problem(where, `${origins.length} egress origins exceed the limit of ${MAX_EGRESS_ORIGINS}`)
		}
		for (const origin of origins) {
			if (!isPolicyOrigin(origin)) {
				this.#problem(where, `egress '${origin}' is not an https origin (allowed: 'https://api.example.com', no path or wildcard)`)
			}
		}
		this.#unique(where, 'egress', origins)
		return [...new Set(origins)].sort()
	}

	/** The cron job a mutation kicks once its transaction committed; `undefined` when it declares none or after a problem. */
	#then(where: string, value: unknown, place: DeclaringSite): string | undefined {
		if (value === undefined) {
			return undefined
		}
		if (place.kind !== 'rpc' && place.kind !== 'link') {
			this.#problem(where, 'declares then, which only a mutation of an RPC or link mount declares')
			return undefined
		}
		if (place.readOnly) {
			this.#problem(where, 'declares then, and it runs read-only (allowed: then on a mutation)')
			return undefined
		}
		if (typeof value !== 'string') {
			this.#problem(where, "then is not a job's name (allowed: then: '<cron job>')")
			return undefined
		}
		return this.#kickedJob(where, value)
	}

	/**
	 * The cron jobs a site may kick (`ctx.kick`): a mutation of an RPC or link mount, a webhook or a job, never a site
	 * that runs read-only. Each names a cron job of the contract, once; `[]` when it declares none or after a problem.
	 */
	#kicks(where: string, value: unknown, place: DeclaringSite): string[] {
		if (value === undefined) {
			return []
		}
		if (place.kind === 'export' || place.readOnly) {
			this.#problem(where, 'declares kicks, and it runs read-only: only a mutation, a webhook or a job kicks a job')
			return []
		}
		if (!Array.isArray(value) || value.length === 0 || !value.every((name) => typeof name === 'string')) {
			this.#problem(where, "kicks is not a list of cron jobs (allowed: kicks: ['<cron job>'])")
			return []
		}
		const names: string[] = value.filter((name) => typeof name === 'string')
		this.#unique(where, 'kicks', names)
		for (const name of names) {
			this.#kickedJob(where, name, 'kicks')
		}
		return [...new Set(names)]
	}

	/**
	 * The kick edges between jobs are acyclic: a job never kicks itself, directly or around a cycle, so one run never
	 * starts an unbounded chain of runs.
	 */
	#checkKickCycles(): void {
		const edges = new Map<string, readonly string[]>()
		for (const [site, reach] of Object.entries(this.#declared)) {
			if (site.startsWith(JOB_SITE_PREFIX) && reach.kicks !== undefined) {
				edges.set(site.slice(JOB_SITE_PREFIX.length), reach.kicks)
			}
		}
		const done = new Set<string>()
		const visit = (job: string, path: readonly string[]): void => {
			if (path.includes(job)) {
				this.#problem(`job '${job}'`, `kicks itself around the cycle ${[...path.slice(path.indexOf(job)), job].join(' → ')}`)
				return
			}
			if (done.has(job)) return
			for (const next of edges.get(job) ?? []) {
				visit(next, [...path, job])
			}
			done.add(job)
		}
		for (const job of [...edges.keys()].sort()) {
			visit(job, [])
		}
	}

	/** The mail transport a cron job reaches; `undefined` when it declares none or after a problem. */
	#mailer(where: string, value: unknown, place: DeclaringSite): JobMailer | undefined {
		if (value === undefined) {
			return undefined
		}
		if (place.kind !== 'job') {
			this.#problem(where, 'declares mailer, which only a cron job declares')
			return undefined
		}
		const mailer = JOB_MAILERS.find((transport) => transport === value)
		if (mailer === undefined) {
			this.#problem(where, `mailer ${JSON.stringify(value)} is not a transport (allowed: mailer: 'installation' or 'own')`)
		}
		return mailer
	}

	/** `connect` calls another application on behalf of a person, so only an RPC endpoint declares it. */
	#rpcOnly(where: string, field: 'connect', value: unknown): void {
		if (value !== undefined) {
			this.#problem(where, `declares ${field}, which only an endpoint of an RPC mount declares`)
		}
	}

	// ── Table policies ──────────────────────────────────────────────────────────────────────────

	#checkTables(): Record<string, TablePolicyArtifact> {
		const owners = new Map<string, string>()
		const memberActions = new Set(Object.values(this.#contract.roles).flatMap((role) => role.member === undefined ? [] : role.grants))
		const tables: Record<string, TablePolicyArtifact> = {}
		for (const [name, table] of Object.entries(this.#tables)) {
			const where = `table '${name}'`
			const { read, insert, update, delete: remove, appRead = [], appCount = [] } = table.actions
			for (const action of [read, insert, update, remove].flatMap(tableActions).concat(appRead, appCount)) {
				this.#knownAction(where, action)
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
			}
			for (const [column, kind] of Object.entries(table.files ?? {})) {
				this.#fileKind(`${where} files.${column}`, kind)
			}
			if (scope.mode === 'inbox') {
				const form = this.#contract.mounts[scope.form]
				if (form?.kind !== 'form' || form.appendTo !== name) {
					this.#problem(where, `is the inbox of '${scope.form}', which is not a c.form mount that appends to '${name}'`)
				}
				for (const action of tableActions(read).filter((held) => memberActions.has(held))) {
					this.#problem(where, `its read action '${action}' is granted by a membership role (allowed: an action only application-level roles grant)`)
				}
			}
			tables[name] = table
		}
		for (const [name, mount] of Object.entries(this.#contract.mounts)) {
			if (mount.kind === 'form') {
				const inbox = this.#tables[mount.appendTo]?.scope
				if (inbox?.mode !== 'inbox' || inbox.form !== name) {
					this.#problem(`mount '${name}'`, `appends to '${mount.appendTo}', which is not an inbox table of this form (scope: { inbox: '${name}', … })`)
				} else {
					this.#inboxFields(name, mount)
				}
			}
		}
		return tables
	}

	/** Each input field of a form is a column of its inbox, of the same name; the honeypot and the challenge token are not. */
	#inboxFields(name: string, mount: FormMountDeclaration<SchemaShape>): void {
		const columns = Object.hasOwn(this.#inboxes, mount.appendTo) ? this.#inboxes[mount.appendTo] : undefined
		if (columns === undefined || mount.input.type !== 'object') {
			return
		}
		const fileFields = typeof mount.files === 'object' && mount.files !== null ? Object.keys(mount.files) : []
		for (const field of [...Object.keys(mount.input.fields), ...fileFields]) {
			const exempt = field === mount.honeypot || (mount.challenge !== undefined && field === FORM_CHALLENGE_FIELD)
			if (!exempt && !columns.includes(field)) {
				this.#problem(
					`mount '${name}'`,
					`the ${fileFields.includes(field) ? 'file' : 'input'} field '${field}' is not a column of its inbox ${mount.appendTo}${
						suggestion(field, columns)
					} (allowed: a field named like a column: ${columns.join(', ')})`,
				)
			}
		}
	}

	// ── Shared checks ───────────────────────────────────────────────────────────────────────────

	#problem(where: string, problem: string): void {
		this.#problems.add(where, problem)
	}

	#options(where: string, builder: Builder, unknown: readonly string[] | undefined): void {
		const fields = BUILDER_FIELDS[builder]
		const call = builder === 'procedure' ? 'c.query and c.mutation' : builder === 'attachment' ? 'attachment()' : `c.${builder}`
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

/** Where a declaration stands: what kind of site, whether it runs read-only, and an RPC endpoint's access form. */
type DeclaringSite =
	/** `actions` are a public procedure's workload actions; `null` for a credentialed procedure. */
	| { readonly kind: 'rpc'; readonly readOnly: boolean; readonly access: AccessDeclaration; readonly actions: readonly string[] | null }
	| { readonly kind: 'job'; readonly readOnly: boolean; readonly actions: readonly string[] }
	| { readonly kind: 'link' | 'export' | 'webhook'; readonly readOnly: boolean }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What a procedure's row takes from its rules: the body limit and the origin rule. */
/** A procedure's body codec: `multipart` is derived from its file fields, never declared. */
type ProcedureBody = 'json' | 'urlencoded' | 'multipart'

interface ProcedureRules {
	readonly method: 'GET' | 'POST'
	/** `null` for a GET, which takes no body. */
	readonly body: ProcedureBody | null
	readonly maxBytes: number
	readonly origins: AdmissionOrigins
	/** A multipart procedure whose every file field may be left empty also takes a JSON body. */
	readonly filesOptional?: boolean
}

/** What a procedure's file fields add to its body: their bytes together, the largest one, and whether every kind scans. */
interface InputFiles {
	readonly bytes: number
	readonly largest: number
	readonly scanning: boolean
	readonly optional: boolean
}

/** A top-level input field that holds files: `file(k)`, optional, or an array bounded by `.max(n)`. */
function fileField(shape: SchemaShape): { readonly kind: string; readonly count: number; readonly required: boolean } | 'unbounded' | null {
	if (shape.type === 'file') {
		return { kind: shape.kind, count: 1, required: true }
	}
	if (shape.type === 'optional') {
		const inner = fileField(shape.inner)
		return inner === null || inner === 'unbounded' ? inner : { ...inner, required: false }
	}
	if (shape.type === 'array' && shape.items.type === 'file') {
		return shape.maxItems === null ? 'unbounded' : { kind: shape.items.kind, count: shape.maxItems, required: (shape.minItems ?? 0) > 0 }
	}
	return null
}

/** Whether a schema holds a file anywhere. */
export function containsFile(shape: SchemaShape): boolean {
	switch (shape.type) {
		case 'file':
			return true
		case 'array':
			return containsFile(shape.items)
		case 'tuple':
			return shape.items.some(containsFile) || (shape.rest !== null && containsFile(shape.rest))
		case 'record':
			return containsFile(shape.value)
		case 'object':
			return Object.values(shape.fields).some(containsFile)
		case 'optional':
		case 'nullable':
			return containsFile(shape.inner)
		case 'union':
			return shape.options.some(containsFile)
		default:
			return false
	}
}

/** The file fields of an input, by name: the parts a multipart body carries beside its JSON. */
export function fileFieldsOf(input: SchemaShape | null): ReadonlyMap<string, FileShape & { readonly many: boolean; readonly max: number }> {
	const fields = new Map<string, FileShape & { readonly many: boolean; readonly max: number }>()
	if (input?.type !== 'object') {
		return fields
	}
	for (const [name, shape] of Object.entries(input.fields)) {
		const inner = shape.type === 'optional' ? shape.inner : shape
		if (inner.type === 'file') {
			fields.set(name, { type: 'file', kind: inner.kind, many: false, max: 1 })
		} else if (inner.type === 'array' && inner.items.type === 'file') {
			fields.set(name, { type: 'file', kind: inner.items.kind, many: true, max: inner.maxItems ?? 0 })
		}
	}
	return fields
}

type AdmissionOrigins = 'same-origin' | 'listed' | 'any'

/** The method and body admission of a procedure's row: POST with a JSON body, unlimited, for a `defineContract` one. */
function rowWire(rules: ProcedureRules | null): Pick<EndpointRow, 'method' | 'admission'> {
	if (rules === null) {
		return { method: 'POST', admission: JSON_ADMISSION }
	}
	if (rules.body === null) {
		return { method: rules.method, admission: null }
	}
	if (rules.body === 'multipart') {
		const contentTypes: readonly [string, ...string[]] = rules.filesOptional === true
			? ['application/json', FORM_MULTIPART_TYPE]
			: [FORM_MULTIPART_TYPE]
		return { method: rules.method, admission: { contentTypes, maxBytes: rules.maxBytes } }
	}
	return {
		method: rules.method,
		admission: { contentTypes: [rules.body === 'urlencoded' ? FORM_URLENCODED_TYPE : 'application/json'], maxBytes: rules.maxBytes },
	}
}

/** A described schema: what `describeContract` and the reader leave where a contract wrote one. */
function isSchemaShape(value: unknown): value is SchemaShape {
	return isRecord(value) && typeof value['type'] === 'string'
}

function nonEmpty<T>(list: readonly T[]): readonly [T, ...T[]] | null {
	const [first, ...rest] = list
	return first === undefined ? null : [first, ...rest]
}

function isPublicAccess(access: unknown): boolean {
	return isRecord(access) && access['public'] === true
}

type ResolvedAccess = { readonly form: 'member' } | { readonly form: 'action'; readonly action: string; readonly access: AccessForm }

function isCapabilityForm(access: AccessForm): access is CapabilityAccessForm {
	return access.form === 'over' || access.form === 'in' || (access.form === 'on' && access.from !== null)
}

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
	if ('app' in access) {
		return hasExactKeys(access, ['action', 'app']) && access.app === true ? { form: 'action', action: access.action, access: { form: 'app' } } : null
	}
	return null
}

/** A value one URL or urlencoded parameter carries: a scalar, or a signed token, possibly absent. */
function isParameter(shape: SchemaShape): boolean {
	return isCell(shape) || shape.type === 'token' || (shape.type === 'optional' && shape.inner.type === 'token')
}

/** A value one CSV field holds: a scalar, possibly absent. */
function isCell(shape: SchemaShape): boolean {
	switch (shape.type) {
		case 'string':
		case 'number':
		case 'boolean':
		case 'null':
		case 'literal':
		case 'enum':
			return true
		case 'optional':
		case 'nullable':
			return isCell(shape.inner)
		case 'union':
			return shape.options.every(isCell)
		default:
			return false
	}
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

/** `z.string()` or `z.optional(z.string())`: a field a page can leave empty, such as a honeypot. */
function isStringField(shape: SchemaShape): boolean {
	return shape.type === 'string' || (shape.type === 'optional' && shape.inner.type === 'string')
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
