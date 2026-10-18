// The `defineContract(…)` value as the evaluated module holds it: the vocabulary, and the surface each `c.*` builder
// builds. Every builder copies the fields `@fabrika/app`'s kit copies and records its other option keys in
// `unknownOptions`, so `buildArtifact` refuses them with the runtime's own words.

import {
	type AccessDeclaration,
	type AnyContract,
	type AnyMount,
	attachmentOutput,
	type Builder,
	type CronJob,
	type CspDeclaration,
	type DeclaredDeclaration,
	declaredOf,
	type DimensionDef,
	type Export,
	type ExportAccessDeclaration,
	type FileCollection,
	type ImportDeclaration,
	type KitImportDeclaration,
	kitImportsSection,
	kitUnknownOptions,
	type LinkAccessDeclaration,
	type ProcedureDeclaration,
	type ProcedureType,
	type QueryTree,
	type RoleDef,
	type Schema,
	type SpaAccessDeclaration,
	type Surface,
	SURFACE_SECTIONS,
	unknownOptions,
	type Vocabulary,
} from '@fabrika/app/contract'
import {
	type CspSource,
	isLocale,
	isMessageKind,
	type Locale,
	LOCALES,
	type MailTemplate,
	mailTemplateProblems,
	type MailTemplates,
	MESSAGE_KINDS,
	type MessageKind,
	type RpcCaller,
} from '@fabrika/auth-core'
import { z } from 'zod/v4'
import type { Located } from '../graph'
import { CONTRACT_LIMITS } from '../limits'
import type { ReaderProblems } from './problems'
import { type AppValue, describeKind, type Kit, kitName, type LiteralValue, schemaLimits } from './value'

/** A refused value; thrown inside this module and recorded where the reader can go on with the next entry. */
class Refused {
	readonly at: Located
	readonly message: string
	readonly allowed: string

	constructor(at: Located, message: string, allowed: string) {
		this.at = at
		this.message = message
		this.allowed = allowed
	}
}

const MAIL_ALLOWED =
	"a one-line subject, a text with {{actionUrl}} and an optional HTML body of the e-mail subset, naming only the message's placeholders"

const MOUNT_BUILDERS = ['rpc', 'link', 'spa', 'health', 'form', 'webhook'] as const
const MOUNT_ALLOWED = `one of c.${MOUNT_BUILDERS.join(', c.')}(…)`
const KIT_MOUNT_ALLOWED = 'one of c.rpc, c.spa, c.health, c.form(…), or a const of app.link(…) or app.webhook(…)'
const CONTRACT_ALLOWED = 'export const contract = app.contract((c) => ({ … })), or defineContract(vocabulary, (c) => ({ … }))'

/** Which builders a surface is written with: `defineContract`'s `c`, or the staged kit's (`app.*` and its `c`). */
type Form = 'surface' | 'kit'
const ACCESS_ALLOWED = '{ member: true }, { action, over }, { action, in, from }, { action, on, from }, { action, creates } or { action, app: true }'

type Entries = ReadonlyMap<string, LiteralValue>

interface Tree<Leaf> {
	readonly [name: string]: Leaf | Tree<Leaf>
}

/** Reads a `defineContract(…)` value into the contract `defineContract` returns; `null` after recording why not. */
export function readContractValue(value: LiteralValue, problems: ReaderProblems): AnyContract | null {
	return new SurfaceReader(problems).contract(value)
}

class SurfaceReader {
	readonly #problems: ReaderProblems
	#complete = true
	#schemaNodes = 0

	constructor(problems: ReaderProblems) {
		this.#problems = problems
	}

	contract(value: LiteralValue): AnyContract | null {
		const read = this.#attempt(() => {
			if (value.kind === 'kit-contract') {
				return this.#kitContract(value.app, value)
			}
			if (value.kind !== 'contract') {
				throw new Refused(value.at, `the contract is a ${describeKind(value)}`, CONTRACT_ALLOWED)
			}
			const [vocabularyValue, callback] = args(value, 'defineContract', 2, 2)
			if (callback?.kind !== 'callback' || vocabularyValue === undefined) {
				throw new Refused(value.at, 'defineContract takes the vocabulary and a builder callback', 'defineContract(vocabulary, (c) => ({ … }))')
			}
			return { vocabulary: this.#vocabulary(vocabularyValue), surface: this.#surface(callback.result, 'surface') }
		})
		if (read === null || !this.#complete) {
			return null
		}
		return { vocabulary: read.vocabulary, dimensions: read.vocabulary.dimensions, surface: read.surface }
	}

	/** `app.contract((c) => ({ … }))`: the kit's vocabulary, the surface, and the imports section the kit derives. */
	#kitContract(
		app: AppValue,
		value: Extract<LiteralValue, { kind: 'kit-contract' }>,
	): { vocabulary: Vocabulary<string, string, string>; surface: Surface } {
		const [callback] = args(value, 'app.contract', 1, 1)
		if (callback?.kind !== 'callback') {
			throw new Refused(value.at, 'app.contract takes a builder callback', 'app.contract((c) => ({ … }))')
		}
		const vocabulary = this.#vocabulary(app.vocabulary)
		const imports = this.#attempt(() => kitImports(app.options)) ?? undefined
		const surface = this.#surface(callback.result, 'kit')
		return { vocabulary, surface: imports === undefined ? surface : { ...surface, imports: kitImportsSection(imports, surface) } }
	}

	/** Runs one entry's read; a refusal is recorded and the reader goes on, so one read reports every entry. */
	#attempt<T>(read: () => T): T | null {
		try {
			return read()
		} catch (error) {
			if (!(error instanceof Refused)) {
				throw error
			}
			this.#problems.add(error.at, error.message, error.allowed)
			this.#complete = false
			return null
		}
	}

	/**
	 * A schema where the contract places it. `compileContract` describes each placement apart, so the expanded nodes of
	 * every placement count towards one budget for the whole contract.
	 */
	#schema(value: LiteralValue | undefined, owner: Owner, field: string): Schema {
		const read = schema(value, owner, field)
		this.#schemaNodes += value?.kind === 'schema' ? value.nodes : 0
		if (this.#schemaNodes > CONTRACT_LIMITS.schemaNodes) {
			throw new Refused(owner.at, `the contract's schemas expand to over ${CONTRACT_LIMITS.schemaNodes} nodes`, schemaLimits())
		}
		return read
	}

	/** A procedure's output: a schema, or `attachment({ … })`, built as `@fabrika/app`'s `attachment` builds it. */
	#output(value: LiteralValue | undefined, owner: BuilderValue): Schema {
		if (value?.kind !== 'attachment') {
			return this.#schema(value, owner, 'output')
		}
		const [definition] = args(value, 'attachment', 1, 1)
		const options = builderOptions(definition, value, 'attachment')
		const row = this.#schema(options.get('row'), value, 'row')
		if (!(row instanceof z.ZodObject)) {
			throw new Refused(options.get('row')?.at ?? value.at, 'the row is not an object schema', 'row: z.strictObject({ … })')
		}
		const maxRows = optionalNumber(options.get('maxRows'), 'maxRows')
		return attachmentOutput(row, {
			format: text(options.get('format'), value, 'format'),
			filename: text(options.get('filename'), value, 'filename'),
			maxBytes: numeric(options.get('maxBytes'), value, 'maxBytes'),
			...(maxRows === undefined ? {} : { maxRows }),
			unknownOptions: optionKeys(options, 'attachment'),
		})
	}

	#each<T>(entries: Entries, read: (name: string, value: LiteralValue) => T): Record<string, T> {
		const result: Record<string, T> = {}
		for (const [name, value] of entries) {
			const entry = this.#attempt(() => read(name, value))
			if (entry !== null) {
				result[name] = entry
			}
		}
		return result
	}

	// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────

	#vocabulary(value: LiteralValue): Vocabulary<string, string, string> {
		const fields = strictFields(value, 'the vocabulary', ['app', 'dimensions', 'actions', 'roles'], [
			'locale',
			'displayName',
			'mail',
			'members',
			'directory',
		])
		const locale = fields.get('locale')
		const displayName = fields.get('displayName')
		const mail = fields.get('mail')
		const members = fields.get('members')
		const memberFields = members === undefined ? undefined : strictFields(members, 'the vocabulary members', ['manage', 'list'], [])
		const directory = fields.get('directory')
		return {
			app: text(fields.get('app'), value, 'app'),
			...(locale === undefined ? {} : { locale: localeOf(locale, value) }),
			...(displayName === undefined ? {} : { displayName: text(displayName, value, 'displayName') }),
			...(mail === undefined ? {} : { mail: this.#mail(mail) }),
			...(memberFields === undefined
				? {}
				: { members: { manage: text(memberFields.get('manage'), value, 'manage'), list: text(memberFields.get('list'), value, 'list') } }),
			...(directory === undefined ? {} : { directory: directoryOf(directory, value) }),
			dimensions: this.#each(entries(fields.get('dimensions'), value, 'dimensions'), (name, dimension) => this.#dimension(name, dimension)),
			actions: this.#each(entries(fields.get('actions'), value, 'actions'), (_, description) => text(description, description, 'an action description')),
			roles: this.#each(entries(fields.get('roles'), value, 'roles'), (name, role) => this.#role(name, role)),
		}
	}

	/** The vocabulary's `mail`: message → language → `{ subject, text }`, each refused at the string it is wrong in. */
	#mail(value: LiteralValue): MailTemplates {
		const templates: { [K in MessageKind]?: { [L in Locale]?: MailTemplate } } = {}
		for (const [kind, byLocale] of strictFields(value, 'mail', [], MESSAGE_KINDS)) {
			if (!isMessageKind(kind)) continue
			const declared: { [L in Locale]?: MailTemplate } = {}
			for (const [locale, entry] of strictFields(byLocale, `mail.${kind}`, [], LOCALES)) {
				if (!isLocale(locale)) continue
				const fields = strictFields(entry, `mail.${kind}.${locale}`, ['subject', 'text'], ['html'])
				const html = fields.get('html')
				const template = {
					subject: text(fields.get('subject'), entry, 'subject'),
					text: text(fields.get('text'), entry, 'text'),
					...(html === undefined ? {} : { html: text(html, entry, 'html') }),
				}
				for (const problem of mailTemplateProblems(kind, template)) {
					const at = problem.startsWith('the subject') ? fields.get('subject') : problem.startsWith('the HTML') ? html : fields.get('text')
					this.#problems.add(at?.at ?? entry.at, `mail.${kind}.${locale}: ${problem}`, MAIL_ALLOWED)
					this.#complete = false
				}
				declared[locale] = template
			}
			templates[kind] = declared
		}
		return templates
	}

	#dimension(name: string, value: LiteralValue): DimensionDef<string, string, string> {
		const fields = strictFields(value, `dimension '${name}'`, [], ['in', 'creator', 'members', 'directory'])
		const members = fields.get('members')
		const memberFields = members === undefined ? undefined : strictFields(members, `dimension '${name}' members`, ['manage', 'list'], [])
		const directory = fields.get('directory')
		return {
			in: optionalText(fields.get('in'), 'in'),
			creator: optionalText(fields.get('creator'), 'creator'),
			members: memberFields === undefined
				? undefined
				: { manage: text(memberFields.get('manage'), value, 'manage'), list: text(memberFields.get('list'), value, 'list') },
			...(directory === undefined ? {} : { directory: directoryOf(directory, value) }),
		}
	}

	#role(name: string, value: LiteralValue): RoleDef<string, string, string> {
		const fields = strictFields(value, `role '${name}'`, ['grants'], ['member', 'external'])
		const member = fields.get('member')
		const memberFields = member === undefined ? undefined : strictFields(member, `role '${name}' member`, ['scope', 'assignableBy'], [])
		const external = fields.get('external')
		return {
			grants: texts(fields.get('grants'), value, 'grants'),
			member: memberFields === undefined
				? undefined
				: { scope: text(memberFields.get('scope'), value, 'scope'), assignableBy: texts(memberFields.get('assignableBy'), value, 'assignableBy') },
			...(external === undefined ? {} : { external: externalOf(external) }),
		}
	}

	// ── Surface ─────────────────────────────────────────────────────────────────────────────────

	#surface(value: LiteralValue, form: Form): Surface {
		if (value.kind !== 'object') {
			throw new Refused(
				value.at,
				`the builder callback returns a ${describeKind(value)}`,
				'(c) => ({ <mount>: c.rpc(…), …, files: { … }, jobs: { … } })',
			)
		}
		const mounts: Record<string, AnyMount> = {}
		for (const [name, entry] of value.entries) {
			if (isSection(name)) {
				continue
			}
			const mount = this.#attempt(() => (form === 'kit' ? this.#kitMount(entry) : this.#mount(entry)))
			if (mount !== null) {
				mounts[name] = mount
			}
		}
		const section = (name: string): Entries | undefined => {
			const entry = value.entries.get(name)
			return entry === undefined ? undefined : (this.#attempt(() => entries(entry, entry, name)) ?? undefined)
		}
		const files = section('files')
		const jobs = section('jobs')
		const exports = section('exports')
		const importsEntry = value.entries.get('imports')
		if (form === 'kit' && importsEntry !== undefined) {
			this.#attempt(() => {
				throw new Refused(importsEntry.at, 'the imports section of the kit contract', 'defineApp(vocabulary, tables, { imports }); remove the section')
			})
		}
		const imports = form === 'kit' ? undefined : section('imports')
		const csp = value.entries.get('csp')
		return {
			...mounts,
			files: files === undefined ? undefined : this.#each(files, (_, entry) => this.#files(entry, form)),
			jobs: jobs === undefined ? undefined : this.#each(jobs, (_, entry) => (form === 'kit' ? this.#kitCron(entry) : this.#cron(entry))),
			exports: exports === undefined ? undefined : this.#each(exports, (_, entry) => (form === 'kit' ? this.#kitExport(entry) : this.#export(entry))),
			imports: imports === undefined ? undefined : this.#each(imports, (name, entry) => importDeclaration(name, entry)),
			csp: csp === undefined ? undefined : (this.#attempt(() => cspDeclaration(csp)) ?? undefined),
		}
	}

	#mount(value: LiteralValue): AnyMount {
		const builder = surfaceBuilder(value, MOUNT_BUILDERS, MOUNT_ALLOWED)
		const at = builder.value
		switch (builder.name) {
			case 'rpc': {
				const [prefix, optionsValue, procedures] = args(at, 'c.rpc', 3, 3)
				const options = builderOptions(optionsValue, at, 'c.rpc')
				return {
					kind: 'rpc',
					prefix: text(prefix, at, 'the prefix'),
					callers: rpcCallers(options.get('callers'), at),
					procedures: this.#tree(procedures, at, 'surface', (leaf) => this.#procedure(leaf, 'surface', accessDeclaration)),
					unknownOptions: optionKeys(options, 'rpc'),
				}
			}
			case 'link': {
				const [prefix, optionsValue] = args(at, 'c.link', 2, 2)
				const options = builderOptions(optionsValue, at, 'c.link')
				const callback = options.get('procedures')
				if (callback?.kind !== 'callback') {
					throw new Refused(callback?.at ?? at.at, 'c.link needs procedures as a builder callback', 'procedures: (l) => ({ <name>: l.query({ … }) })')
				}
				return {
					kind: 'link',
					prefix: text(prefix, at, 'the prefix'),
					spa: text(options.get('spa'), at, 'spa'),
					dimension: text(options.get('dimension'), at, 'dimension'),
					grants: texts(options.get('grants'), at, 'grants'),
					issuedBy: text(options.get('issuedBy'), at, 'issuedBy'),
					maxDays: numeric(options.get('maxDays'), at, 'maxDays'),
					procedures: this.#tree(callback.result, at, 'link', (leaf) => this.#procedure(leaf, 'link', linkAccessDeclaration)),
					unknownOptions: optionKeys(options, 'link'),
				}
			}
			case 'spa': {
				const [prefix, optionsValue] = args(at, 'c.spa', 2, 2)
				const options = builderOptions(optionsValue, at, 'c.spa')
				return {
					kind: 'spa',
					prefix: text(prefix, at, 'the prefix'),
					dir: text(options.get('dir'), at, 'dir'),
					access: spaAccessDeclaration(options.get('access'), at),
					public: options.has('public') ? texts(options.get('public'), at, 'public') : undefined,
					unknownOptions: optionKeys(options, 'spa'),
				}
			}
			case 'health': {
				const [path] = args(at, 'c.health', 1, 1)
				return { kind: 'health', path: text(path, at, 'the path') }
			}
			case 'form': {
				const [path, optionsValue] = args(at, 'c.form', 2, 2)
				const options = builderOptions(optionsValue, at, 'c.form')
				return {
					kind: 'form',
					path: text(path, at, 'the path'),
					input: this.#schema(options.get('input'), at, 'input'),
					appendTo: text(options.get('appendTo'), at, 'appendTo'),
					maxBytes: optionalNumber(options.get('maxBytes'), 'maxBytes'),
					rate: formRate(options.get('rate')),
					honeypot: optionalText(options.get('honeypot'), 'honeypot'),
					challenge: formChallenge(options.get('challenge')),
					then: optionalText(options.get('then'), 'then'),
					...crossOriginOption(options.get('crossOrigin')),
					...formFiles(options.get('files')),
					unknownOptions: optionKeys(options, 'form'),
				}
			}
			case 'webhook': {
				const [path, optionsValue] = args(at, 'c.webhook', 2, 2)
				const options = builderOptions(optionsValue, at, 'c.webhook')
				const scheme = options.get('scheme')
				if (scheme?.kind !== 'string' || scheme.value !== 'github-sha256') {
					throw new Refused(scheme?.at ?? at.at, 'c.webhook needs a known scheme', "scheme: 'github-sha256'")
				}
				return {
					kind: 'webhook',
					path: text(path, at, 'the path'),
					scheme: scheme.value,
					boundTo: text(options.get('boundTo'), at, 'boundTo'),
					actions: texts(options.get('actions'), at, 'actions'),
					input: this.#schema(options.get('input'), at, 'input'),
					maxBytes: optionalNumber(options.get('maxBytes'), 'maxBytes'),
					unknownOptions: optionKeys(options, 'webhook'),
				}
			}
		}
	}

	/** A mount of the kit contract: `c.rpc(prefix, groups)`, a shell mount, or an `app.link` or `app.webhook` const. */
	#kitMount(value: LiteralValue): AnyMount {
		const builder = value.kind === 'builder' ? { name: value.name, kit: value.kit, args: value.args, at: value.at } : undefined
		if (builder?.kit === 'shell' && builder.name === 'rpc') {
			const [prefix, groupsValue] = args(builder, 'c.rpc', 2, 2)
			const path = text(prefix, builder, 'the prefix')
			const read = this.#groups(groupsValue, builder)
			const [first] = read.groups
			if (first === undefined) {
				throw new Refused(groupsValue?.at ?? builder.at, `c.rpc('${path}') mounts no group`, `c.rpc('${path}', { <name>: <group> })`)
			}
			if (read.groups.some((group) => !sameCallers(group.callers, first.callers))) {
				throw new Refused(builder.at, 'every group of one RPC mount names the same callers, in the same order', "callers: ['human'] in each group")
			}
			return {
				kind: 'rpc',
				prefix: path,
				callers: first.callers,
				procedures: read.procedures,
				unknownOptions: [...new Set(read.groups.flatMap((group) => group.unknownOptions))],
			}
		}
		if (builder?.kit === 'shell' && (builder.name === 'spa' || builder.name === 'health' || builder.name === 'form')) {
			return this.#mount(asSurface(builder))
		}
		if (builder?.kit === 'app' && builder.name === 'link') {
			const [prefix, optionsValue] = args(builder, 'app.link', 2, 2)
			const options = builderOptions(optionsValue, builder, 'app.link')
			const callback = options.get('procedures')
			if (callback?.kind !== 'callback') {
				throw new Refused(
					callback?.at ?? builder.at,
					'app.link needs procedures as a builder callback',
					'procedures: (l) => ({ <name>: l.query({ … }) })',
				)
			}
			return {
				kind: 'link',
				prefix: text(prefix, builder, 'the prefix'),
				spa: text(options.get('spa'), builder, 'spa'),
				dimension: text(options.get('dimension'), builder, 'dimension'),
				grants: texts(options.get('grants'), builder, 'grants'),
				issuedBy: text(options.get('issuedBy'), builder, 'issuedBy'),
				maxDays: numeric(options.get('maxDays'), builder, 'maxDays'),
				procedures: this.#tree(callback.result, builder, 'endpoints', (leaf) => this.#procedure(leaf, 'endpoints', linkAccessDeclaration)),
				unknownOptions: optionKeys(options, 'link'),
			}
		}
		if (builder?.kit === 'app' && builder.name === 'webhook') {
			const mount = this.#mount(asSurface(builder))
			if (mount.kind !== 'webhook') {
				throw new Refused(builder.at, 'app.webhook(…) read as another mount', 'app.webhook(path, { … })')
			}
			const options = builderOptions(builder.args[1], builder, 'app.webhook')
			return { ...mount, declared: declared(options), unknownOptions: kitOptionKeys(options, 'webhook') }
		}
		throw new Refused(value.at, `a ${describeKind(value)} where a mount of the kit stands`, KIT_MOUNT_ALLOWED)
	}

	/** The groups `c.rpc` mounts: one `app.group(…)`, or groups by name, nested; the procedures nest by the same names. */
	#groups(
		value: LiteralValue | undefined,
		owner: BuilderValue,
	): { readonly groups: readonly ReadGroup[]; readonly procedures: Tree<ProcedureDeclaration<Schema>> } {
		if (value?.kind === 'builder' && value.kit === 'app' && value.name === 'group') {
			const at = { name: value.name, kit: value.kit, args: value.args, at: value.at }
			const [optionsValue, callback] = args(at, 'app.group', 2, 2)
			const options = builderOptions(optionsValue, at, 'app.group')
			if (callback?.kind !== 'callback') {
				throw new Refused(
					callback?.at ?? at.at,
					'app.group takes its endpoints as a builder callback',
					'app.group({ callers }, (r) => ({ <name>: r.query({ … }) }))',
				)
			}
			const procedures = this.#tree(callback.result, at, 'endpoints', (leaf) => this.#procedure(leaf, 'endpoints', accessDeclaration))
			return { groups: [{ callers: rpcCallers(options.get('callers'), at), unknownOptions: optionKeys(options, 'rpc') }], procedures }
		}
		if (value?.kind !== 'object') {
			throw new Refused(
				value?.at ?? owner.at,
				`a ${value === undefined ? 'missing value' : describeKind(value)} where a group stands`,
				'app.group(…), or { <name>: <group> }',
			)
		}
		const groups: ReadGroup[] = []
		const procedures: Record<string, Tree<ProcedureDeclaration<Schema>>> = {}
		for (const [name, entry] of value.entries) {
			const read = this.#groups(entry, owner)
			groups.push(...read.groups)
			procedures[name] = read.procedures
		}
		return { groups, procedures }
	}

	#tree<Leaf>(value: LiteralValue | undefined, owner: BuilderValue, kit: Kit, leaf: (builder: BuilderValue) => Leaf): Tree<Leaf> {
		if (value?.kind !== 'object') {
			throw new Refused(value?.at ?? owner.at, 'procedures are not an object', `{ <name>: ${kitName(kit)}.query({ … }), <group>: { … } }`)
		}
		const tree: Record<string, Leaf | Tree<Leaf>> = {}
		for (const [name, node] of value.entries) {
			if (node.kind === 'builder') {
				tree[name] = leaf({ name: node.name, kit: node.kit, args: node.args, at: node.at })
			} else if (node.kind === 'object') {
				tree[name] = this.#tree(node, owner, kit, leaf)
			} else {
				throw new Refused(
					node.at,
					`procedure '${name}' is a ${describeKind(node)}`,
					`${kitName(kit)}.query({ … }), ${kitName(kit)}.mutation({ … }) or a group { … }`,
				)
			}
		}
		return tree
	}

	#procedure<Access>(
		builder: BuilderValue,
		kit: Kit,
		access: (value: LiteralValue | undefined, at: BuilderValue) => Access,
	): ProcedureDeclaration<Schema, Access> {
		const call = `${kitName(builder.kit)}.${builder.name}`
		if (builder.kit !== kit || (builder.name !== 'query' && builder.name !== 'mutation')) {
			throw new Refused(builder.at, `${call}(…) is not a procedure here`, `${kitName(kit)}.query({ … }) or ${kitName(kit)}.mutation({ … })`)
		}
		const type: ProcedureType = builder.name
		const [definition] = args(builder, call, 1, 1)
		const options = builderOptions(definition, builder, call)
		const input = options.get('input')
		return {
			'~kind': 'procedure',
			type,
			input: input === undefined || input.kind === 'null' ? null : this.#schema(input, builder, 'input'),
			output: this.#output(options.get('output'), builder),
			access: access(options.get('access'), builder),
			...crossOriginOption(options.get('crossOrigin')),
			...(kit === 'endpoints'
				? { declared: declared(options), unknownOptions: kitOptionKeys(options, 'procedure') }
				: { unknownOptions: optionKeys(options, 'procedure') }),
		}
	}

	// ── Sections ────────────────────────────────────────────────────────────────────────────────

	#files(value: LiteralValue, form: Form): FileCollection<string> {
		const at =
			surfaceBuilder(form === 'kit' && value.kind === 'builder' && value.kit === 'shell' ? asSurface(value) : value, ['files'], 'c.files({ … })').value
		const [collection] = args(at, 'c.files', 1, 1)
		const options = builderOptions(collection, at, 'c.files')
		const link = options.get('link')
		const scan = options.get('scan')
		return {
			kind: 'files',
			owner: text(options.get('owner'), at, 'owner'),
			read: text(options.get('read'), at, 'read'),
			write: text(options.get('write'), at, 'write'),
			delete: text(options.get('delete'), at, 'delete'),
			maxBytes: numeric(options.get('maxBytes'), at, 'maxBytes'),
			types: texts(options.get('types'), at, 'types'),
			maxPerOwner: optionalNumber(options.get('maxPerOwner'), 'maxPerOwner'),
			link: link === undefined ? undefined : fileLink(link, at),
			scan: scan === undefined ? undefined : boolean(scan, 'scan'),
			unknownOptions: optionKeys(options, 'files'),
		}
	}

	#cron(value: LiteralValue): CronJob<string, string> {
		const at = surfaceBuilder(value, ['cron'], "c.cron('<schedule>', { … })").value
		const [schedule, optionsValue] = args(at, 'c.cron', 2, 2)
		const options = builderOptions(optionsValue, at, 'c.cron')
		return {
			kind: 'cron',
			schedule: text(schedule, at, 'the schedule'),
			actions: texts(options.get('actions'), at, 'actions'),
			scope: text(options.get('scope'), at, 'scope'),
			timeout: optionalText(options.get('timeout'), 'timeout'),
			retries: optionalNumber(options.get('retries'), 'retries'),
			unknownOptions: optionKeys(options, 'cron'),
		}
	}

	/** A job of the kit: a const of `app.cron(schedule, { … })`, whose `.handle(…)` the slice removed. */
	#kitCron(value: LiteralValue): CronJob<string, string> {
		if (value.kind !== 'builder' || value.kit !== 'app' || value.name !== 'cron') {
			throw new Refused(value.at, `a ${describeKind(value)} where a job stands`, "a const of app.cron('<schedule>', { … })")
		}
		const job = this.#cron(asSurface(value))
		const options = builderOptions(value.args[1], { name: value.name, kit: value.kit, args: value.args, at: value.at }, 'app.cron')
		return { ...job, declared: declared(options), unknownOptions: kitOptionKeys(options, 'cron') }
	}

	/** An export of the kit: a const of `app.export({ …, procedures: (e) => ({ … }) })`. */
	#kitExport(value: LiteralValue): Export<QueryTree> {
		if (value.kind !== 'builder' || value.kit !== 'app' || value.name !== 'export') {
			throw new Refused(value.at, `a ${describeKind(value)} where an export stands`, 'a const of app.export({ … })')
		}
		const at = { name: value.name, kit: value.kit, args: value.args, at: value.at }
		const [definition] = args(at, 'app.export', 1, 1)
		const options = builderOptions(definition, at, 'app.export')
		const callback = options.get('procedures')
		if (callback?.kind !== 'callback') {
			throw new Refused(callback?.at ?? at.at, 'app.export needs procedures as a builder callback', 'procedures: (e) => ({ <name>: e.query({ … }) })')
		}
		return {
			kind: 'export',
			version: numeric(options.get('version'), at, 'version'),
			consumers: texts(options.get('consumers'), at, 'consumers'),
			audience: text(options.get('audience'), at, 'audience'),
			procedures: this.#tree(callback.result, at, 'endpoints', (leaf) => {
				const procedure = this.#procedure(leaf, 'endpoints', exportAccessDeclaration)
				if (procedure.type !== 'query') {
					throw new Refused(leaf.at, 'an export serves queries only', 'e.query')
				}
				return { ...procedure, type: procedure.type }
			}),
			unknownOptions: optionKeys(options, 'export'),
		}
	}

	#export(value: LiteralValue): Export<QueryTree> {
		const at = surfaceBuilder(value, ['export'], 'c.export({ … })').value
		const [definition] = args(at, 'c.export', 1, 1)
		const options = builderOptions(definition, at, 'c.export')
		return {
			kind: 'export',
			version: numeric(options.get('version'), at, 'version'),
			consumers: texts(options.get('consumers'), at, 'consumers'),
			audience: text(options.get('audience'), at, 'audience'),
			procedures: this.#tree(options.get('procedures'), at, 'surface', (leaf) => {
				const procedure = this.#procedure(leaf, 'surface', exportAccessDeclaration)
				if (procedure.type !== 'query') {
					throw new Refused(leaf.at, 'an export serves queries only', 'c.query')
				}
				return { ...procedure, type: procedure.type }
			}),
			unknownOptions: optionKeys(options, 'export'),
		}
	}
}

// ── Builders and their options ──────────────────────────────────────────────────────────────────

interface BuilderValue {
	readonly name: string
	readonly kit: Kit
	readonly args: readonly LiteralValue[]
	readonly at: Located
}

function surfaceBuilder<const Name extends string>(
	value: LiteralValue,
	names: readonly Name[],
	allowed: string,
): { readonly name: Name; readonly value: BuilderValue } {
	const name = value.kind === 'builder' && value.kit === 'surface' ? names.find((known) => known === value.name) : undefined
	if (value.kind !== 'builder' || name === undefined) {
		throw new Refused(value.at, `a ${describeKind(value)} where a builder call stands`, allowed)
	}
	return { name, value: { name: value.name, kit: value.kit, args: value.args, at: value.at } }
}

function args(
	builder: BuilderValue | Extract<LiteralValue, { kind: 'contract' | 'kit-contract' | 'attachment' }>,
	call: string,
	min: number,
	max: number,
): readonly (LiteralValue | undefined)[] {
	if (builder.args.length < min || builder.args.length > max) {
		throw new Refused(
			builder.at,
			`${call} takes ${min === max ? min : `${min} to ${max}`} arguments, not ${builder.args.length}`,
			`${call}(…) as its type declares`,
		)
	}
	return Array.from({ length: max }, (_, index) => builder.args[index])
}

/** A builder's options object; its keys are not checked here, `optionKeys` records the unknown ones. */
function builderOptions(value: LiteralValue | undefined, at: Owner, call: string): Entries {
	if (value?.kind !== 'object') {
		throw new Refused(value?.at ?? at.at, `${call} takes an options object`, `${call}(…, { … })`)
	}
	return value.entries
}

function optionKeys(options: Entries, builder: Builder): string[] {
	return unknownOptions(Object.fromEntries([...options.keys()].map((key) => [key, true])), builder)
}

function kitOptionKeys(options: Entries, builder: Builder): string[] {
	return kitUnknownOptions(Object.fromEntries([...options.keys()].map((key) => [key, true])), builder)
}

/** What a site of the kit declares, copied as `declaredOf` copies it; `buildArtifact` checks it. */
function declared(options: Entries): DeclaredDeclaration {
	return declaredOf({
		sql: plain(options.get('sql')),
		unscoped: plain(options.get('unscoped')),
		connect: plain(options.get('connect')),
		issues: plain(options.get('issues')),
		then: plain(options.get('then')),
		mailer: plain(options.get('mailer')),
	})
}

/** A literal as the plain value the evaluated module holds; a declared field holds no schema or builder. */
function plain(value: LiteralValue | undefined): unknown {
	if (value === undefined) {
		return undefined
	}
	switch (value.kind) {
		case 'string':
		case 'number':
		case 'boolean':
			return value.value
		case 'null':
			return null
		case 'array':
			return value.items.map(plain)
		case 'object':
			return Object.fromEntries([...value.entries].map(([key, entry]) => [key, plain(entry)]))
		default:
			throw new Refused(value.at, `a ${describeKind(value)} in a declared field`, DECLARED_ALLOWED)
	}
}

const DECLARED_ALLOWED =
	"sql: 'read' | 'write', unscoped: { <table>: 'read' | 'write' }, connect: ['<import>'], issues: '<link mount>', then: '<cron job>', mailer: 'installation' | 'own'"

/** A builder of the kit read as the `defineContract` builder of the same name, which builds the same declaration. */
const asSurface = (builder: BuilderValue): LiteralValue => ({
	kind: 'builder',
	kit: 'surface',
	name: builder.name,
	args: builder.args,
	at: builder.at,
})

interface ReadGroup {
	readonly callers: readonly [RpcCaller, ...RpcCaller[]]
	readonly unknownOptions: readonly string[]
}

const sameCallers = (left: readonly string[], right: readonly string[]): boolean =>
	left.length === right.length && left.every((caller, index) => caller === right[index])

/**
 * The kit's imports from `defineApp`'s options: each snapshot's identity, the procedures it calls, its deadline;
 * `undefined` without options, where the contract has no imports section.
 */
function kitImports(options: LiteralValue | undefined): Record<string, KitImportDeclaration> | undefined {
	if (options === undefined) {
		return undefined
	}
	const imports = strictFields(options, "defineApp's options", ['imports'], []).get('imports')
	return Object.fromEntries([...entries(imports, options, 'imports')].map(([name, value]) => {
		const where = `import '${name}'`
		const declaration = strictFields(value, where, ['snapshot', 'procedures'], ['timeoutMs'])
		const snapshotValue = declaration.get('snapshot')
		const snapshot = entries(snapshotValue, value, 'snapshot')
		const owner = snapshotValue ?? value
		const timeoutMs = optionalNumber(declaration.get('timeoutMs'), 'timeoutMs')
		return [name, {
			app: text(snapshot.get('app'), owner, 'the snapshot app'),
			export: text(snapshot.get('export'), owner, 'the snapshot export'),
			version: numeric(snapshot.get('version'), owner, 'the snapshot version'),
			digest: text(snapshot.get('digest'), owner, 'the snapshot digest'),
			procedures: texts(declaration.get('procedures'), value, 'procedures'),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		}]
	}))
}

const SECTIONS: ReadonlySet<string> = new Set(SURFACE_SECTIONS)

function isSection(name: string): boolean {
	return SECTIONS.has(name)
}

// ── Plain fields ────────────────────────────────────────────────────────────────────────────────

type Owner = BuilderValue | LiteralValue

function entries(value: LiteralValue | undefined, owner: Owner, field: string): Entries {
	if (value?.kind !== 'object') {
		throw new Refused(value?.at ?? owner.at, `${field} is not an object`, `${field}: { … }`)
	}
	return value.entries
}

/** An object whose keys are exactly `required` plus any of `optional`. */
function strictFields(value: LiteralValue, where: string, required: readonly string[], optional: readonly string[]): Entries {
	if (value.kind !== 'object') {
		throw new Refused(value.at, `${where} is a ${describeKind(value)}`, `${where} as an object literal`)
	}
	const allowed = [...required, ...optional]
	for (const [key, entry] of value.entries) {
		if (!allowed.includes(key)) {
			throw new Refused(entry.at, `'${key}' is not a field of ${where}`, `the fields ${allowed.join(', ')}`)
		}
	}
	for (const key of required) {
		if (!value.entries.has(key)) {
			throw new Refused(value.at, `${where} has no '${key}'`, `the fields ${allowed.join(', ')}`)
		}
	}
	return value.entries
}

function text(value: LiteralValue | undefined, owner: Owner, field: string): string {
	if (value?.kind !== 'string') {
		throw new Refused(
			value?.at ?? owner.at,
			value === undefined ? `${field} is missing` : `${field} is a ${describeKind(value)}`,
			`${field} as a string`,
		)
	}
	return value.value
}

/** The vocabulary's `locale`: one of the languages IAM speaks. */
function localeOf(value: LiteralValue, owner: Owner): Locale {
	const locale = text(value, owner, 'locale')
	if (!isLocale(locale)) {
		throw new Refused(value.at, `locale is '${locale}'`, LOCALES.map((allowed) => `locale: '${allowed}'`).join(' or '))
	}
	return locale
}

/** A role's `external`, which only `true` is. */
function externalOf(value: LiteralValue): true {
	if (!boolean(value, 'external')) {
		throw new Refused(value.at, 'external is false', 'external: true, or no external')
	}
	return true
}

/** A dimension's `directory`, which only `'labels'` is. */
function directoryOf(value: LiteralValue, owner: Owner): 'labels' {
	const directory = text(value, owner, 'directory')
	if (directory !== 'labels') {
		throw new Refused(value.at, `directory is '${directory}'`, "directory: 'labels'")
	}
	return directory
}

/** `crossOrigin` as written, `true` or a string; the build decides which a builder admits. Absent stays absent. */
function crossOriginOption(value: LiteralValue | undefined): { readonly crossOrigin?: boolean | string } {
	if (value === undefined) return {}
	if (value.kind === 'boolean' || value.kind === 'string') return { crossOrigin: value.value }
	throw new Refused(value.at, `crossOrigin is a ${describeKind(value)}`, "crossOrigin: true, or crossOrigin: '*' on a form")
}

function optionalText(value: LiteralValue | undefined, field: string): string | undefined {
	return value === undefined ? undefined : text(value, value, field)
}

function texts(value: LiteralValue | undefined, owner: Owner, field: string): string[] {
	if (value?.kind !== 'array') {
		throw new Refused(value?.at ?? owner.at, value === undefined ? `${field} is missing` : `${field} is a ${describeKind(value)}`, `${field}: ['…']`)
	}
	return value.items.map((item) => text(item, item, `an item of ${field}`))
}

function numeric(value: LiteralValue | undefined, owner: Owner, field: string): number {
	if (value?.kind !== 'number') {
		throw new Refused(
			value?.at ?? owner.at,
			value === undefined ? `${field} is missing` : `${field} is a ${describeKind(value)}`,
			`${field} as a number`,
		)
	}
	return value.value
}

function optionalNumber(value: LiteralValue | undefined, field: string): number | undefined {
	return value === undefined ? undefined : numeric(value, value, field)
}

function boolean(value: LiteralValue, field: string): boolean {
	if (value.kind !== 'boolean') {
		throw new Refused(value.at, `${field} is a ${describeKind(value)}`, `${field}: true or false`)
	}
	return value.value
}

/** A collection's `link`: `true` or `false`, or the link mounts it names; the build refuses an empty list. */
function fileLink(value: LiteralValue, owner: Owner): boolean | string[] {
	if (value.kind === 'boolean') return value.value
	if (value.kind !== 'array') throw new Refused(value.at, `link is a ${describeKind(value)}`, "link: true, or link: ['<link mount>']")
	return texts(value, owner, 'link')
}

function schema(value: LiteralValue | undefined, owner: Owner, field: string): Schema {
	if (value?.kind !== 'schema') {
		throw new Refused(
			value?.at ?? owner.at,
			value === undefined ? `${field} is missing` : `${field} is a ${describeKind(value)}`,
			`${field}: z.<schema>`,
		)
	}
	return value.schema
}

function isRpcCaller(caller: string): caller is RpcCaller {
	return caller === 'human' || caller === 'machine'
}

function rpcCallers(value: LiteralValue | undefined, at: BuilderValue): readonly [RpcCaller, ...RpcCaller[]] {
	const [first, ...rest] = texts(value, at, 'callers')
	const allowed = "callers: ['human'] or ['machine']; another application reaches only an export"
	if (first === undefined) {
		throw new Refused(value?.at ?? at.at, 'callers is empty', allowed)
	}
	const callers: RpcCaller[] = []
	for (const caller of [first, ...rest]) {
		if (!isRpcCaller(caller)) {
			throw new Refused(value?.at ?? at.at, `'${caller}' is not a caller of an RPC mount`, allowed)
		}
		callers.push(caller)
	}
	const [head, ...tail] = callers
	if (head === undefined) {
		throw new Refused(at.at, 'callers is empty', allowed)
	}
	return [head, ...tail]
}

// ── Access ──────────────────────────────────────────────────────────────────────────────────────

function accessFields(value: LiteralValue | undefined, at: BuilderValue, allowed: string): Entries {
	if (value?.kind !== 'object') {
		throw new Refused(value?.at ?? at.at, value === undefined ? 'access is missing' : `access is a ${describeKind(value)}`, allowed)
	}
	return value.entries
}

function hasKeys(fields: Entries, keys: readonly string[]): boolean {
	return fields.size === keys.length && keys.every((key) => fields.has(key))
}

function isMember(fields: Entries): boolean {
	const member = fields.get('member')
	return hasKeys(fields, ['member']) && member?.kind === 'boolean' && member.value
}

/** `{ action, app: true }`: `app` is the literal `true`, as `buildArtifact` reads it. */
function isApp(fields: Entries): boolean {
	const app = fields.get('app')
	return hasKeys(fields, ['action', 'app']) && app?.kind === 'boolean' && app.value
}

/** The one access form the object spells, with exactly its keys, as `buildArtifact` reads it. */
function accessDeclaration(value: LiteralValue | undefined, at: BuilderValue): AccessDeclaration {
	const fields = accessFields(value, at, ACCESS_ALLOWED)
	const field = (key: string): string => text(fields.get(key), value ?? at, `access.${key}`)
	if (isMember(fields)) {
		return { member: true }
	}
	if (hasKeys(fields, ['action', 'over'])) {
		return { action: field('action'), over: field('over') }
	}
	if (hasKeys(fields, ['action', 'in', 'from'])) {
		return { action: field('action'), in: field('in'), from: field('from') }
	}
	if (hasKeys(fields, ['action', 'on', 'from'])) {
		return { action: field('action'), on: field('on'), from: field('from') }
	}
	if (hasKeys(fields, ['action', 'creates'])) {
		return { action: field('action'), creates: field('creates') }
	}
	if (isApp(fields)) {
		return { action: field('action'), app: true }
	}
	throw new Refused(value?.at ?? at.at, 'access is not one access form', ACCESS_ALLOWED)
}

/**
 * An export procedure names its action in a dimension: the consumer's key holds exactly the actions, so `member` would
 * hold none, and a v1 export declares one dimension, which `app` names none of.
 */
function exportAccessDeclaration(value: LiteralValue | undefined, at: BuilderValue): ExportAccessDeclaration {
	const access = accessDeclaration(value, at)
	if ('member' in access) {
		throw new Refused(value?.at ?? at.at, 'an export procedure names its action', '{ action, over } (or in, on, creates)')
	}
	if ('app' in access) {
		throw new Refused(value?.at ?? at.at, 'an export procedure reads in one dimension', '{ action, over } (or in, on)')
	}
	return access
}

function linkAccessDeclaration(value: LiteralValue | undefined, at: BuilderValue): LinkAccessDeclaration {
	const fields = accessFields(value, at, "{ action: <one of the link's grants> }")
	if (!hasKeys(fields, ['action'])) {
		throw new Refused(value?.at ?? at.at, 'access is not a link access', "{ action: <one of the link's grants> }")
	}
	return { action: text(fields.get('action'), value ?? at, 'access.action') }
}

const SPA_ACCESS_ALLOWED = '{ member: true }, { action, over }, { action, app: true } or { public: true }'

function spaAccessDeclaration(value: LiteralValue | undefined, at: BuilderValue): SpaAccessDeclaration {
	const fields = accessFields(value, at, SPA_ACCESS_ALLOWED)
	if (isMember(fields)) {
		return { member: true }
	}
	const open = fields.get('public')
	if (hasKeys(fields, ['public']) && open?.kind === 'boolean' && open.value) {
		return { public: true }
	}
	if (hasKeys(fields, ['action', 'over'])) {
		return { action: text(fields.get('action'), value ?? at, 'access.action'), over: text(fields.get('over'), value ?? at, 'access.over') }
	}
	if (isApp(fields)) {
		return { action: text(fields.get('action'), value ?? at, 'access.action'), app: true }
	}
	throw new Refused(value?.at ?? at.at, 'access is not an SPA access', SPA_ACCESS_ALLOWED)
}

// ── Imports and CSP ─────────────────────────────────────────────────────────────────────────────

function importDeclaration(name: string, value: LiteralValue): ImportDeclaration {
	const where = `import '${name}'`
	const fields = strictFields(value, where, ['app', 'export', 'version', 'digest', 'procedures', 'usedBy'], ['timeoutMs'])
	return {
		app: text(fields.get('app'), value, 'app'),
		export: text(fields.get('export'), value, 'export'),
		version: numeric(fields.get('version'), value, 'version'),
		digest: text(fields.get('digest'), value, 'digest'),
		procedures: texts(fields.get('procedures'), value, 'procedures'),
		usedBy: texts(fields.get('usedBy'), value, 'usedBy'),
		timeoutMs: optionalNumber(fields.get('timeoutMs'), 'timeoutMs'),
	}
}

/** A form's `rate`, as `buildArtifact` reads it: per-minute counts, each optional. */
function formRate(value: LiteralValue | undefined): { perClient?: number; perForm?: number; bytesPerHour?: number } | undefined {
	if (value === undefined) {
		return undefined
	}
	const fields = strictFields(value, 'rate', [], ['perClient', 'perForm', 'bytesPerHour'])
	const perClient = optionalNumber(fields.get('perClient'), 'perClient')
	const perForm = optionalNumber(fields.get('perForm'), 'perForm')
	const bytesPerHour = optionalNumber(fields.get('bytesPerHour'), 'bytesPerHour')
	return {
		...(perClient === undefined ? {} : { perClient }),
		...(perForm === undefined ? {} : { perForm }),
		...(bytesPerHour === undefined ? {} : { bytesPerHour }),
	}
}

/** A form's `files`: each file field's collection and whether a submission must carry it; `buildArtifact` checks them. */
function formFiles(value: LiteralValue | undefined): { readonly files?: Record<string, { collection: string; required?: boolean }> } {
	if (value === undefined) {
		return {}
	}
	if (value.kind !== 'object') {
		throw new Refused(value.at, `files is a ${describeKind(value)}`, "files: { photo: { collection: '<collection>' } }")
	}
	const files: Record<string, { collection: string; required?: boolean }> = {}
	for (const [field, entry] of value.entries) {
		const fields = strictFields(entry, `file '${field}'`, ['collection'], ['required'])
		const required = fields.get('required')
		files[field] = {
			collection: text(fields.get('collection'), entry, 'collection'),
			...(required === undefined ? {} : { required: boolean(required, 'required') }),
		}
	}
	return { files }
}

/** A form's `challenge`: a provider of the closed list and the names of the application variables with its secret and site key. */
function formChallenge(value: LiteralValue | undefined): { provider: 'turnstile'; secret: string; siteKey?: string } | undefined {
	if (value === undefined) {
		return undefined
	}
	const fields = strictFields(value, 'challenge', ['provider', 'secret'], ['siteKey'])
	const provider = fields.get('provider')
	if (provider?.kind !== 'string' || provider.value !== 'turnstile') {
		throw new Refused(provider?.at ?? value.at, 'challenge needs a known provider', "provider: 'turnstile'")
	}
	const secret = text(fields.get('secret'), value, 'secret')
	const siteKey = fields.get('siteKey')
	return siteKey === undefined ? { provider: provider.value, secret } : { provider: provider.value, secret, siteKey: text(siteKey, value, 'siteKey') }
}

function cspDeclaration(value: LiteralValue): CspDeclaration {
	const fields = strictFields(value, 'csp', [], ['connectSrc', 'imgSrc', 'frameAncestors', 'scriptSrc', 'frameSrc', 'styleSrc', 'fontSrc'])
	const sources = (key: string): CspSource[] | undefined => {
		const list = fields.get(key)
		if (list === undefined) {
			return undefined
		}
		if (list.kind !== 'array') {
			throw new Refused(list.at, `csp ${key} is a ${describeKind(list)}`, `${key}: [{ origin: 'https://…', purpose: '…' }]`)
		}
		return list.items.map((item) => {
			const source = strictFields(item, `a csp ${key} source`, ['origin', 'purpose'], [])
			return { origin: text(source.get('origin'), item, 'origin'), purpose: text(source.get('purpose'), item, 'purpose') }
		})
	}
	return {
		connectSrc: sources('connectSrc'),
		imgSrc: sources('imgSrc'),
		frameAncestors: sources('frameAncestors'),
		scriptSrc: sources('scriptSrc'),
		frameSrc: sources('frameSrc'),
		styleSrc: sources('styleSrc'),
		fontSrc: sources('fontSrc'),
	}
}
