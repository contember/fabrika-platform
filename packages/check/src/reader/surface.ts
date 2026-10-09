// The `defineContract(…)` value as the evaluated module holds it: the vocabulary, and the surface each `c.*` builder
// builds. Every builder copies the fields `@fabrika/app`'s kit copies and records its other option keys in
// `unknownOptions`, so `buildArtifact` refuses them with the runtime's own words.

import {
	type AccessDeclaration,
	type AnyContract,
	type AnyMount,
	type Builder,
	type CronJob,
	type CspDeclaration,
	type DimensionDef,
	type Export,
	type FileCollection,
	type ImportDeclaration,
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
import type { CspSource, RpcCaller } from '@fabrika/auth-core'
import type { Located } from '../graph'
import { CONTRACT_LIMITS } from '../limits'
import type { ReaderProblems } from './problems'
import { describeKind, type Kit, type LiteralValue, schemaLimits } from './value'

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

const MOUNT_BUILDERS = ['rpc', 'link', 'spa', 'health', 'form', 'webhook'] as const
const MOUNT_ALLOWED = `one of c.${MOUNT_BUILDERS.join(', c.')}(…)`
const ACCESS_ALLOWED = '{ member: true }, { action, over }, { action, in, from }, { action, on, from } or { action, creates }'

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
			if (value.kind !== 'contract') {
				throw new Refused(value.at, `the contract is a ${describeKind(value)}`, 'export const contract = defineContract(vocabulary, (c) => ({ … }))')
			}
			const [vocabularyValue, callback] = args(value, 'defineContract', 2, 2)
			if (callback?.kind !== 'callback' || vocabularyValue === undefined) {
				throw new Refused(value.at, 'defineContract takes the vocabulary and a builder callback', 'defineContract(vocabulary, (c) => ({ … }))')
			}
			return { vocabulary: this.#vocabulary(vocabularyValue), surface: this.#surface(callback.result) }
		})
		if (read === null || !this.#complete) {
			return null
		}
		return { vocabulary: read.vocabulary, dimensions: read.vocabulary.dimensions, surface: read.surface }
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
		const fields = strictFields(value, 'the vocabulary', ['app', 'dimensions', 'actions', 'roles'], [])
		return {
			app: text(fields.get('app'), value, 'app'),
			dimensions: this.#each(entries(fields.get('dimensions'), value, 'dimensions'), (name, dimension) => this.#dimension(name, dimension)),
			actions: this.#each(entries(fields.get('actions'), value, 'actions'), (_, description) => text(description, description, 'an action description')),
			roles: this.#each(entries(fields.get('roles'), value, 'roles'), (name, role) => this.#role(name, role)),
		}
	}

	#dimension(name: string, value: LiteralValue): DimensionDef<string, string, string> {
		const fields = strictFields(value, `dimension '${name}'`, [], ['in', 'creator', 'members'])
		const members = fields.get('members')
		const memberFields = members === undefined ? undefined : strictFields(members, `dimension '${name}' members`, ['manage', 'list'], [])
		return {
			in: optionalText(fields.get('in'), 'in'),
			creator: optionalText(fields.get('creator'), 'creator'),
			members: memberFields === undefined
				? undefined
				: { manage: text(memberFields.get('manage'), value, 'manage'), list: text(memberFields.get('list'), value, 'list') },
		}
	}

	#role(name: string, value: LiteralValue): RoleDef<string, string, string> {
		const fields = strictFields(value, `role '${name}'`, ['grants'], ['member'])
		const member = fields.get('member')
		const memberFields = member === undefined ? undefined : strictFields(member, `role '${name}' member`, ['scope', 'assignableBy'], [])
		return {
			grants: texts(fields.get('grants'), value, 'grants'),
			member: memberFields === undefined
				? undefined
				: { scope: text(memberFields.get('scope'), value, 'scope'), assignableBy: texts(memberFields.get('assignableBy'), value, 'assignableBy') },
		}
	}

	// ── Surface ─────────────────────────────────────────────────────────────────────────────────

	#surface(value: LiteralValue): Surface {
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
			const mount = this.#attempt(() => this.#mount(entry))
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
		const imports = section('imports')
		const csp = value.entries.get('csp')
		return {
			...mounts,
			files: files === undefined ? undefined : this.#each(files, (_, entry) => this.#files(entry)),
			jobs: jobs === undefined ? undefined : this.#each(jobs, (_, entry) => this.#cron(entry)),
			exports: exports === undefined ? undefined : this.#each(exports, (_, entry) => this.#export(entry)),
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

	#tree<Leaf>(value: LiteralValue | undefined, owner: BuilderValue, kit: Kit, leaf: (builder: BuilderValue) => Leaf): Tree<Leaf> {
		if (value?.kind !== 'object') {
			throw new Refused(value?.at ?? owner.at, 'procedures are not an object', `{ <name>: ${kit === 'link' ? 'l' : 'c'}.query({ … }), <group>: { … } }`)
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
					`${kit === 'link' ? 'l' : 'c'}.query({ … }), c.mutation({ … }) or a group { … }`,
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
		const call = `${kit === 'link' ? 'l' : 'c'}.${builder.name}`
		if (builder.kit !== kit || (builder.name !== 'query' && builder.name !== 'mutation')) {
			throw new Refused(
				builder.at,
				`${call}(…) is not a procedure here`,
				`${kit === 'link' ? 'l' : 'c'}.query({ … }) or ${kit === 'link' ? 'l' : 'c'}.mutation({ … })`,
			)
		}
		const type: ProcedureType = builder.name
		const [definition] = args(builder, call, 1, 1)
		const options = builderOptions(definition, builder, call)
		const input = options.get('input')
		return {
			'~kind': 'procedure',
			type,
			input: input === undefined || input.kind === 'null' ? null : this.#schema(input, builder, 'input'),
			output: this.#schema(options.get('output'), builder, 'output'),
			access: access(options.get('access'), builder),
			unknownOptions: optionKeys(options, 'procedure'),
		}
	}

	// ── Sections ────────────────────────────────────────────────────────────────────────────────

	#files(value: LiteralValue): FileCollection<string> {
		const at = surfaceBuilder(value, ['files'], 'c.files({ … })').value
		const [collection] = args(at, 'c.files', 1, 1)
		const options = builderOptions(collection, at, 'c.files')
		const link = options.get('link')
		return {
			kind: 'files',
			owner: text(options.get('owner'), at, 'owner'),
			read: text(options.get('read'), at, 'read'),
			write: text(options.get('write'), at, 'write'),
			delete: text(options.get('delete'), at, 'delete'),
			maxBytes: numeric(options.get('maxBytes'), at, 'maxBytes'),
			types: texts(options.get('types'), at, 'types'),
			maxPerOwner: optionalNumber(options.get('maxPerOwner'), 'maxPerOwner'),
			link: link === undefined ? undefined : boolean(link, 'link'),
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
				const procedure = this.#procedure(leaf, 'surface', accessDeclaration)
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
	builder: BuilderValue | Extract<LiteralValue, { kind: 'contract' }>,
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
function builderOptions(value: LiteralValue | undefined, at: BuilderValue, call: string): Entries {
	if (value?.kind !== 'object') {
		throw new Refused(value?.at ?? at.at, `${call} takes an options object`, `${call}(…, { … })`)
	}
	return value.entries
}

function optionKeys(options: Entries, builder: Builder): string[] {
	return unknownOptions(Object.fromEntries([...options.keys()].map((key) => [key, true])), builder)
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
	throw new Refused(value?.at ?? at.at, 'access is not one access form', ACCESS_ALLOWED)
}

function linkAccessDeclaration(value: LiteralValue | undefined, at: BuilderValue): LinkAccessDeclaration {
	const fields = accessFields(value, at, "{ action: <one of the link's grants> }")
	if (!hasKeys(fields, ['action'])) {
		throw new Refused(value?.at ?? at.at, 'access is not a link access', "{ action: <one of the link's grants> }")
	}
	return { action: text(fields.get('action'), value ?? at, 'access.action') }
}

function spaAccessDeclaration(value: LiteralValue | undefined, at: BuilderValue): SpaAccessDeclaration {
	const fields = accessFields(value, at, '{ member: true } or { action, over }')
	if (isMember(fields)) {
		return { member: true }
	}
	if (hasKeys(fields, ['action', 'over'])) {
		return { action: text(fields.get('action'), value ?? at, 'access.action'), over: text(fields.get('over'), value ?? at, 'access.over') }
	}
	throw new Refused(value?.at ?? at.at, 'access is not an SPA access', '{ member: true } or { action, over }')
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

function cspDeclaration(value: LiteralValue): CspDeclaration {
	const fields = strictFields(value, 'csp', [], ['connectSrc', 'imgSrc', 'frameAncestors'])
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
	return { connectSrc: sources('connectSrc'), imgSrc: sources('imgSrc'), frameAncestors: sources('frameAncestors') }
}
