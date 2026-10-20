// The conservative classification of an access change (ADR-0050 §3). Pure: it compares the candidate snapshot with the
// environment's active one and answers plain-language lines for the approver. Anything it cannot show to narrow
// access widens it.

import { bodyDeadlineMs } from '@fabrika/app/contract'
import {
	type AdmissionRate,
	APP_CALLER_PREFIX,
	type AttachmentShape,
	canonicalizeArtifact,
	canonicalJson,
	type ColumnPolicyArtifact,
	type CompiledEndpointTable,
	compileEndpointTable,
	type ContractArtifact,
	type CrossOriginForm,
	type DeclaredReach,
	type DimensionArtifact,
	type EndpointAuthorization,
	type EndpointCache,
	endpointDelegation,
	type EndpointDirectory,
	endpointMembers,
	type EndpointRequirement,
	type EndpointRow,
	type FileCollectionArtifact,
	type FileKindArtifact,
	type FileShape,
	type FormMountArtifact,
	isAttachmentShape,
	isFileShape,
	isRedirectShape,
	isSchemaOutput,
	JOB_SITE_PREFIX,
	type JobMailer,
	LOCALES,
	MESSAGE_KINDS,
	type MountArtifact,
	type MountCompatibility,
	type NumberShape,
	type OutputShape,
	planEndpoint,
	type ProcedureArtifact,
	type ProcedureChallenge,
	type RedirectShape,
	type RoleArtifact,
	type SchemaShape,
	type StringShape,
	type TableActionArtifact,
	tableActions,
	type TablePolicyArtifact,
	type WebhookScheme,
} from '@fabrika/auth-core'
import type {
	ChangeAudienceDto,
	ChangeConsequenceDto,
	ChangeSubjectDto,
	ChangeSubjectKind,
	DeviationSubjectDto,
	ReviewReason,
	SurfaceReach,
} from '@fabrika/control-contract'
import type { MigrationDeviation } from '@fabrika/platform-node/sql'
import { type AccessSnapshot, deviationKey } from './snapshot'

/**
 * What one line does to access: `widens` when it can grant access the baseline did not, `narrows` when it can only take
 * access away, `neutral` when it admits no one new and takes nothing away, but changes what the approver should know
 * (a path answered by another endpoint for the same callers, a job a form starts).
 */
export type AccessEffect = 'widens' | 'narrows' | 'neutral'

/**
 * One plain-language line before it is placed: its effect and words. `review: 'closer'` marks a step off the paved road
 * (declared reach, database code) or a change the diff cannot classify, and `reason` says which: the approver reads the
 * code behind it, not only the line. `environmentOrigins` marks a line that opens an endpoint to the pages on the origins
 * the environment lists (`crossOrigin: 'environment'`): the list is the environment's, not the contract's, so the
 * approval page shows it beside this line.
 */
type Line =
	& {
		readonly effect: AccessEffect
		readonly line: string
		readonly environmentOrigins?: true
		readonly consequence?: ChangeConsequenceDto
	}
	& ({ readonly review?: undefined; readonly reason?: undefined } | { readonly review: 'closer'; readonly reason: ReviewReason })

/** A line and the comparison that produced it, a stable code (`endpoint.body-limit`). */
type RuledLine = Line & { readonly rule: string }

/**
 * One line of an access change, placed (ADR-0050 §3): its words, the comparison that produced it and what it is about.
 * An endpoint's line also says who reaches the endpoint. A line is built where its words are, so the two never drift.
 */
export type AccessChange = RuledLine & { readonly subject: ChangeSubjectDto; readonly audience?: ChangeAudienceDto }

/**
 * `none`: no line at all. `no-widening`: lines, none of which widens (they narrow or leave access unchanged). Both
 * publish at once; `widening` waits for a human on a protected environment.
 */
export type AccessOutcome = 'none' | 'no-widening' | 'widening'

export interface AccessClassification {
	readonly outcome: AccessOutcome
	readonly changes: readonly AccessChange[]
}

export function classifyAccess(baseline: AccessSnapshot, candidate: AccessSnapshot): AccessClassification {
	const changes = new Changes()
	compareContracts(changes, baseline.contract, candidate.contract)
	compareKeyed(changes, 'migration', byName(baseline.migrations), byName(candidate.migrations), {
		added: (name) => `New migration \`${name}\``,
		removed: (name) => `Migration \`${name}\` is removed`,
		changed: (
			name,
			before,
			after,
		) => (before.checksum === after.checksum ? [] : ruled('migration.changed', [widening(`Migration \`${name}\` changes`)])),
	})
	compareDatabaseCode(changes, baseline, candidate)
	compareFileAdoptions(changes, baseline, candidate)
	const list = changes.list.map((change) => withAudience(change, baseline.contract, candidate.contract))
	return { outcome: list.length === 0 ? 'none' : list.some((change) => change.effect === 'widens') ? 'widening' : 'no-widening', changes: list }
}

/** The lines of a classification, each placed on its subject. Only a ruled line is placed. */
class Changes {
	readonly list: AccessChange[] = []

	add(subject: ChangeSubjectDto, ...changes: readonly RuledLine[]): void {
		this.list.push(...changes.map((change) => ({ ...change, subject })))
	}
}

const widening = (line: string): Line => ({ effect: 'widens', line })
const neutral = (line: string): Line => ({ effect: 'neutral', line })
const narrowing = (line: string): Line => ({ effect: 'narrows', line })
/** A line the approver reads the code behind; it widens unless it can only take access away. */
const closer = (reason: ReviewReason, line: string, effect: AccessEffect = 'widens'): Line => ({ effect, line, review: 'closer', reason })

/** The lines one comparison produced, under its rule. */
function ruled(rule: string, lines: readonly Line[]): RuledLine[] {
	return lines.map((line) => ({ ...line, rule }))
}

const subjectOf = (kind: ChangeSubjectKind, name: string): ChangeSubjectDto => ({ kind, name })

/**
 * An endpoint's route and audience, read from the candidate's row, or the baseline's for a removed endpoint: the
 * approval page groups an endpoint's lines by who reaches it.
 */
function withAudience(change: AccessChange, baseline: ContractArtifact | null, candidate: ContractArtifact | null): AccessChange {
	if (change.subject.kind !== 'endpoint') return change
	const id = change.subject.name
	const row = candidate?.endpoints.find((endpoint) => endpoint.id === id) ?? baseline?.endpoints.find((endpoint) => endpoint.id === id)
	if (row === undefined) return change
	const reach = endpointReach(row)
	const audience: ChangeAudienceDto = {
		reach,
		...(reach === 'link' && row.source.kind === 'mount' ? { mount: row.source.name } : {}),
		requirement: row.requirement === null ? null : requirementPhrase(row.requirement),
	}
	return { ...change, subject: { ...change.subject, method: row.method, path: row.path }, audience }
}

/** Who reaches an endpoint, its most exposed caller: anyone for an anonymous kind, `app` for an `app:<id>` caller. */
export function endpointReach(row: EndpointRow): SurfaceReach {
	if (row.requirement === null) return 'anyone'
	if (row.callers.includes('link')) return 'link'
	if (row.callers.some((caller) => caller.startsWith(APP_CALLER_PREFIX))) return 'app'
	return row.callers.includes('machine') ? 'machine' : 'human'
}

function compareContracts(changes: Changes, before: ContractArtifact | null, after: ContractArtifact | null): void {
	if (before === null && after === null) return
	if (after === null) {
		const app = before === null ? '' : before.app
		changes.add(
			subjectOf('application', app),
			...ruled('application.contract', [widening('The contract is removed: the proxy no longer applies an endpoint table to this application')]),
		)
		return
	}
	const candidate = canonicalizeArtifact(after)
	const baseline = before === null ? emptyArtifact(candidate) : canonicalizeArtifact(before)
	const application = subjectOf('application', candidate.app)
	if (before === null) {
		changes.add(application, ...ruled('application.contract', [widening(`The application becomes the contract application \`${candidate.app}\``)]))
	} else if (baseline.app !== candidate.app) {
		changes.add(
			application,
			...ruled('application.contract', [widening(`The contract's application changes from \`${baseline.app}\` to \`${candidate.app}\``)]),
		)
	}
	changes.add(application, ...presentationChanges(baseline, candidate))
	changes.add(application, ...peopleChanges(baseline, candidate))
	const mountsShown = compareEndpoints(changes, baseline, candidate)
	changes.add(
		application,
		...ruled(
			'application.reserved-prefix',
			setLines(baseline.reservedPrefixes, candidate.reservedPrefixes, {
				// A reserved prefix restricts which endpoints compete under it, so losing one widens.
				added: (prefix) => narrowing(`Reserved prefix \`${prefix}\` is added`),
				removed: (prefix) => widening(`Reserved prefix \`${prefix}\` is removed`),
			}),
		),
	)
	compareKeyed(changes, 'dimension', record(baseline.dimensions), record(candidate.dimensions), {
		added: (name) => `New dimension \`${name}\``,
		removed: (name) => `Dimension \`${name}\` is removed`,
		changed: dimensionChanges,
	})
	for (const [name, dimension] of Object.entries(candidate.dimensions)) {
		if (!Object.hasOwn(baseline.dimensions, name)) changes.add(subjectOf('dimension', name), ...directoryChange(name, undefined, dimension.directory))
	}
	compareKeyed(changes, 'action', record(baseline.actions), record(candidate.actions), {
		added: (name) => `New action \`${name}\``,
		removed: (name) => `Action \`${name}\` is removed`,
		changed: () => [],
	})
	compareKeyed(changes, 'role', record(baseline.roles), record(candidate.roles), {
		added: (name, role) => `New role \`${name}\` with ${listOf(role.grants, 'no actions')}`,
		removed: (name) => `Role \`${name}\` is removed`,
		changed: roleChanges,
	})
	for (const [name, role] of Object.entries(candidate.roles)) {
		if (!Object.hasOwn(baseline.roles, name)) changes.add(subjectOf('role', name), ...externalChange(name, undefined, role.external))
	}
	compareKeyed(changes, 'mount', record(baseline.mounts), record(candidate.mounts), {
		added: (name, mount) => `New ${mount.kind} mount \`${name}\`${servedVariables(mount)}${takenFiles(mount)}${webhookPhrase(mount)}`,
		removed: (name) => (mountsShown.has(name) ? [] : `Mount \`${name}\` is removed`),
		changed: mountChanges,
	})
	compareKeyed(changes, 'file-collection', record(baseline.files), record(candidate.files), {
		added: (name, files) => `New file collection \`${name}\`${files.link === false ? '' : `, reachable through ${linkReach(files.link)}`}`,
		removed: (name) => `File collection \`${name}\` is removed`,
		changed: fileChanges,
	})
	// A file kind adds no authority of its own: who writes and reads its files is the reach of the columns that hold them.
	compareKeyed(changes, 'file-kind', record(baseline.fileKinds ?? {}), record(candidate.fileKinds ?? {}), {
		added: (name, kind) => neutral(`New file kind \`${name}\`: ${fileKindPhrase(kind)}`),
		removed: (name) => `File kind \`${name}\` is removed`,
		changed: fileKindChanges,
	})
	compareKeyed(changes, 'job', record(baseline.jobs), record(candidate.jobs), {
		added: (name, job) => `New job \`${name}\` with ${listOf(job.actions, 'no actions')}, running at most ${seconds(job.timeoutMs)}`,
		removed: (name) => `Job \`${name}\` is removed`,
		changed: (name, from, to) => [
			...ruled('job.actions', setChanges(`Job \`${name}\``, from.actions, to.actions, 'gains action', 'loses action')),
			...ruled('job.scope', valueChange(`Job \`${name}\` scope`, from.scope, to.scope)),
			...ruled('job.time-limit', timeLimitChange(`Job \`${name}\``, from.timeoutMs, to.timeoutMs)),
		],
	})
	compareKeyed(changes, 'export', record(baseline.exports), record(candidate.exports), {
		added: (name, declaration) => `New export \`${name}\` for ${listOf(declaration.consumers, 'no consumers')}`,
		removed: (name) => `Export \`${name}\` is removed`,
		changed: (name, from, to) => [
			...ruled('export.consumers', setChanges(`Export \`${name}\``, from.consumers, to.consumers, 'gains consumer', 'loses consumer')),
			...ruled('export.audience', valueChange(`Export \`${name}\` audience`, from.audience, to.audience)),
			...ruled('export.version', valueChange(`Export \`${name}\` version`, from.version, to.version)),
		],
	})
	compareKeyed(changes, 'import', record(baseline.imports), record(candidate.imports), {
		added: (name, declaration) => `New import \`${name}\` of \`${declaration.app}\`'s export \`${declaration.export}\``,
		removed: (name) => `Import \`${name}\` is removed`,
		changed: (name, from, to) => [
			...ruled('import.procedures', setChanges(`Import \`${name}\``, from.procedures, to.procedures, 'gains procedure', 'loses procedure')),
			...ruled('import.used-by', setChanges(`Import \`${name}\``, from.usedBy, to.usedBy, 'is used by', 'is no longer used by')),
			...ruled(
				'import.declaration',
				valueChange(`Import \`${name}\``, { ...from, procedures: [], usedBy: [], timeoutMs: null }, {
					...to,
					procedures: [],
					usedBy: [],
					timeoutMs: null,
				}),
			),
		],
	})
	for (const directive of ['connectSrc', 'imgSrc', 'frameAncestors', 'scriptSrc', 'frameSrc', 'styleSrc', 'fontSrc', 'workerSrc'] as const) {
		changes.add(
			subjectOf('csp', directive),
			...ruled(
				'csp.source',
				setLines(
					(baseline.csp[directive] ?? []).map((source) => source.origin),
					(candidate.csp[directive] ?? []).map((source) => source.origin),
					{
						added: (origin) => widening(`CSP \`${directive}\` allows \`${origin}\``),
						removed: (origin) => narrowing(`CSP \`${directive}\` no longer allows \`${origin}\``),
					},
				),
			),
		)
	}
	compareKeyed(changes, 'table', record(baseline.tables), record(candidate.tables), {
		added: (name, table) => newTableLine(name, table),
		removed: (name) => `Table policy \`${name}\` is removed`,
		changed: tableChanges,
	})
	for (const [name, table] of Object.entries(candidate.tables)) {
		const before = Object.hasOwn(baseline.tables, name) ? baseline.tables[name] : undefined
		const shown = new Set(before === undefined ? [] : fileColumnLines(name, before).map((change) => change.line))
		changes.add(subjectOf('table', name), ...ruled('table.file-writers', fileColumnLines(name, table).filter((change) => !shown.has(change.line))))
	}
	compareKeyed(changes, 'token', record(baseline.tokens ?? {}), record(candidate.tokens ?? {}), {
		added: (name, purpose) => `New token purpose \`${name}\`, a token of it valid up to ${purpose.maxDays} days`,
		removed: (name) => `Token purpose \`${name}\` is removed`,
		changed: (name, from, to) => [
			...ruled(
				'token.lifetime',
				from.maxDays === to.maxDays
					? []
					: [(to.maxDays > from.maxDays ? widening : narrowing)(`Token purpose \`${name}\` lifetime changes from ${from.maxDays} to ${to.maxDays} days`)],
			),
			...ruled('token.claims', schemaChanges({ endpoint: `Token purpose \`${name}\` claims`, side: 'input', path: '' }, from.claims, to.claims)),
		],
	})
	compareDeclared(changes, application, baseline.declared, candidate.declared)
	compareProcedures(changes, baseline, candidate)
	compareDirectories(changes, baseline, candidate)
}

// ── Procedure admission and limits ──────────────────────────────────────────────────────────────

/**
 * Each procedure's admission and time limit (ADR-0050): a procedure whose rules the baseline does not record (a new one,
 * or every one of an older release's contract) is shown with its effective values; a changed bound widens when it
 * admits more or runs longer, and narrows otherwise.
 */
function compareProcedures(changes: Changes, baseline: ContractArtifact, candidate: ContractArtifact): void {
	const before = baseline.procedures ?? {}
	for (const [id, rules] of Object.entries(candidate.procedures ?? {})) {
		const row = candidate.endpoints.find((endpoint) => endpoint.id === id)
		const from = Object.hasOwn(before, id) ? before[id] : undefined
		const subject = subjectOf('endpoint', id)
		if (from === undefined) {
			changes.add(
				subject,
				...ruled('procedure.admission', [
					neutral(`\`${id}\` admits ${ratePhrase(rules.rate)}${challengePhrase(rules.challenge)}; it ${runPhrase(row, rules.timeoutMs)}`),
				]),
				...ruled('procedure.get-mutation', rules.changesStateOnGet === true ? [closer('get-mutation', stateOnGet(`\`${id}\``))] : []),
			)
			continue
		}
		changes.add(subject, ...procedureChanges(`\`${id}\``, from, rules))
	}
}

const BUCKETS = [
	['perClient', 'per client'],
	['perCaller', 'per caller'],
	['perEndpoint', 'in all'],
	['bytesPerHour', 'bytes per hour'],
] as const

/** `10 calls per minute per client and 100 in all`, or `any number of calls` without a bucket. */
function ratePhrase(rate: AdmissionRate): string {
	const counted = BUCKETS.flatMap(([bucket, words]) => {
		const value = rate[bucket]
		if (value === null) return []
		if (bucket === 'bytesPerHour') return [`${value} ${words}`]
		// On Zerops the proxy sees the balancer, not the visitor, until its range is trusted.
		return [bucket === 'perClient' ? `${value} ${words} (one client on Zerops)` : `${value} ${words}`]
	})
	return counted.length === 0 ? 'any number of calls' : `calls per minute: ${andList(counted)}`
}

function challengePhrase(challenge: ProcedureChallenge | null): string {
	if (challenge === null) return ''
	// The work and the lifetime are what an ALTCHA challenge costs a visitor and how long a solution may be used.
	return challenge.provider === 'altcha'
		? `, after an altcha challenge of ${challenge.cost} iterations per attempt, solvable within ${seconds(challenge.maxAgeMs)}`
		: `, after a ${challenge.provider} challenge`
}

/**
 * How long a call may take: the body's deadline, which the runtime derives from its limit, then the handler's time
 * limit, which starts after the last byte.
 */
function runPhrase(row: EndpointRow | undefined, timeoutMs: number): string {
	const limit = row?.admission?.maxBytes ?? null
	const runs = `runs at most ${seconds(timeoutMs)}`
	return limit === null ? runs : `waits at most ${seconds(bodyDeadlineMs(limit))} for a body of at most ${bytes(limit)}, then ${runs}`
}

function seconds(ms: number): string {
	return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
}

/** A longer time limit widens: the site holds its connection, its lease or its claim longer. */
function timeLimitChange(name: string, before: number, after: number): Line[] {
	if (before === after) return []
	return [(after > before ? widening : narrowing)(`${name} time limit changes from ${seconds(before)} to ${seconds(after)}`)]
}

function procedureChanges(name: string, from: ProcedureArtifact, to: ProcedureArtifact): RuledLine[] {
	const buckets = BUCKETS.flatMap(([bucket, words]): Line[] => {
		const before = from.rate[bucket]
		const after = to.rate[bucket]
		if (before === after) return []
		// A bucket removed or raised admits more calls.
		const more = after === null || (before !== null && after > before)
		return [(more ? widening : narrowing)(`${name} bucket ${words} changes from ${before ?? 'none'} to ${after ?? 'none'}`)]
	})
	const challenge = canonicalJson(from.challenge) === canonicalJson(to.challenge)
		? []
		: to.challenge === null
		? [widening(`${name} no longer asks for a challenge`)]
		: from.challenge === null
		? [narrowing(`${name} asks for a ${to.challenge.provider} challenge`)]
		: valueChange(`${name} challenge`, from.challenge, to.challenge)
	const time = timeLimitChange(name, from.timeoutMs, to.timeoutMs)
	const query = schemaChanges({ endpoint: `${name} URL query`, side: 'input', path: '' }, from.query ?? null, to.query ?? null)
	const onGet = from.changesStateOnGet === to.changesStateOnGet
		? []
		: to.changesStateOnGet === true
		? [closer('get-mutation', stateOnGet(name))]
		: [narrowing(`${name} no longer changes state on GET`)]
	return [
		...ruled('procedure.bucket', buckets),
		...ruled('procedure.challenge', challenge),
		...ruled('procedure.time-limit', time),
		...ruled('procedure.query', query),
		...ruled('procedure.get-mutation', onGet),
	]
}

/** What a public mutation served on `GET` means: whoever follows its URL, a mail client's link scanner too, changes state. */
function stateOnGet(name: string): string {
	return `${name} changes state on GET; link scanners may trigger it`
}

// ── Member directories ──────────────────────────────────────────────────────────────────────────

type Directories = Readonly<Record<string, EndpointDirectory>>

/**
 * The directory reach of the baseline: what it records, or, for an artifact compiled before it recorded any, the one
 * reach the runtime gave then: `list()` of an endpoint whose action is its own dimension's `members.list`.
 */
function baselineDirectories(artifact: ContractArtifact): Directories {
	if (artifact.directories !== undefined) return artifact.directories
	const implied: Record<string, EndpointDirectory> = {}
	for (const row of artifact.endpoints) {
		if (row.requirement?.kind === 'action' && row.requirement.access.form !== 'app' && endpointMembers(artifact, row) === 'list') {
			implied[row.id] = { dimension: row.requirement.access.dimension, lists: true }
		}
	}
	return implied
}

/**
 * The member directory each endpoint reads. A new reach widens: an endpoint that looks a member up learns whether a
 * person it names is a member, one that lists learns them all; where the dimension shows labels, the approver reads
 * the code behind it, because a label spells an email address. A removed reach narrows.
 */
function compareDirectories(changes: Changes, baseline: ContractArtifact, candidate: ContractArtifact): void {
	const before = baselineDirectories(baseline)
	const after = candidate.directories ?? {}
	const reachOf = (reach: EndpointDirectory): string =>
		reach.lists ? `lists the members of \`${reach.dimension}\`` : `looks up one member of \`${reach.dimension}\``
	for (const endpoint of union(Object.keys(before), Object.keys(after))) {
		const from = before[endpoint]
		const to = after[endpoint]
		const place = (line: Line) => changes.add(subjectOf('endpoint', endpoint), ...ruled('endpoint.directory', [line]))
		if (to === undefined) {
			if (from !== undefined) place(narrowing(`Endpoint \`${endpoint}\` no longer reads the members of \`${from.dimension}\``))
			continue
		}
		if (from !== undefined && from.dimension === to.dimension && (from.lists || !to.lists)) {
			if (from.lists && !to.lists) place(narrowing(`Endpoint \`${endpoint}\` no longer lists the members of \`${to.dimension}\``))
			continue
		}
		const labels = candidate.dimensions[to.dimension]?.directory === 'labels'
		place(
			labels
				? closer('people', `Endpoint \`${endpoint}\` ${reachOf(to)}, with their labels, which spell users' email addresses`)
				: widening(`Endpoint \`${endpoint}\` ${reachOf(to)}`),
		)
	}
}

// ── Steps off the paved road ────────────────────────────────────────────────────────────────────

/**
 * The reach each site declares (`sql`, `unscoped`, `connect`, link issuing, a job's mail transport, a public procedure's
 * workload actions, the token purposes it signs, the origins it calls). A site is keyed by its endpoint id or job, so a handler that moves keeps its site; each effect is
 * compared on its own. A new site, table, connector, mount or workload action and `read` → `write` widen with closer
 * review; a removal and `write` → `read` narrow. A mutation's kick (`then`) is shown and widens nothing.
 */
function compareDeclared(
	changes: Changes,
	application: ChangeSubjectDto,
	before: Readonly<Record<string, DeclaredReach>> | undefined,
	after: Readonly<Record<string, DeclaredReach>> | undefined,
): void {
	if (before !== undefined && after === undefined) {
		// A `defineContract` contract records no reach: its sites reach what the handlers say, unreviewed.
		changes.add(
			application,
			...ruled('application.staged-kit', [
				closer('off-road', "The contract leaves the staged kit: its sites' reach off the paved road is no longer declared"),
			]),
		)
		return
	}
	if (after === undefined) return
	if (before === undefined) {
		changes.add(
			application,
			...ruled('application.staged-kit', [narrowing('The contract moves to the staged kit: each site reaches only what it declares')]),
		)
	}
	const sites = before ?? {}
	for (const site of union(Object.keys(sites), Object.keys(after))) {
		changes.add(
			siteSubject(site),
			...reachChanges(site, sites[site] ?? NO_REACH, after[site] ?? NO_REACH),
			...endpointKickChange(site, sites[site]?.then, after[site]?.then),
			...kicksChanges(site, sites[site]?.kicks ?? [], after[site] ?? NO_REACH),
			...workloadActionChanges(site, sites[site]?.actions ?? [], after[site]?.actions ?? []),
			...bindsChange(site, sites[site]?.binds, after[site]?.binds),
			...signsChanges(site, sites[site]?.signs ?? [], after[site]?.signs ?? []),
			...egressChanges(site, sites[site]?.egress ?? [], after[site]?.egress ?? []),
		)
	}
}

/**
 * The origins a site's code calls (`egress`): a new one is a place the site's data may go, so it widens with closer
 * review; a dropped one narrows.
 */
function egressChanges(site: string, from: readonly string[], to: readonly string[]): RuledLine[] {
	const name = siteName(site)
	return ruled(
		'reach.egress',
		union(from, to).flatMap((origin) => {
			if (!from.includes(origin)) return [closer('off-road', `${name} calls ${origin}`)]
			if (!to.includes(origin)) return [narrowing(`${name} no longer calls ${origin}`)]
			return []
		}),
	)
}

/**
 * The token purposes a site signs (`signs`): whoever holds a token it signs may call what verifies one, a public
 * procedure included, so a new purpose widens; a dropped one narrows, while the tokens already signed stay valid.
 */
function signsChanges(site: string, from: readonly string[], to: readonly string[]): RuledLine[] {
	const name = siteName(site)
	return ruled(
		'reach.signs',
		union(from, to).flatMap((purpose) => {
			if (!from.includes(purpose)) return [widening(`${name} signs \`${purpose}\` tokens`)]
			if (!to.includes(purpose)) return [narrowing(`${name} no longer signs \`${purpose}\` tokens`)]
			return []
		}),
	)
}

/**
 * The webhook whose bindings a mutation creates and removes (`binds`): each binding it creates admits a provider's
 * deliveries, which run as the webhook's workload, and the mutation sees the binding's secret once or sets the one the
 * provider issued.
 */
function bindsChange(site: string, before: string | undefined, after: string | undefined): RuledLine[] {
	if (before === after) return []
	const name = siteName(site)
	return ruled('reach.binds', [
		...(after === undefined
			? []
			: [
				closer(
					'off-road',
					`${name} binds webhook \`${after}\`: it creates and removes its bindings, replaces a binding's secret with one the provider issued, and sees each new binding's secret`,
				),
			]),
		...(before === undefined ? [] : [narrowing(`${name} no longer binds webhook \`${before}\``)]),
	])
}

/**
 * A public procedure's workload actions: what its handler holds through the key Control issues for the endpoint, for
 * anyone who calls it. A gained action widens with closer review; a lost one narrows. They are no step off the paved
 * road, so `snapshotDeviations` does not list them.
 */
function workloadActionChanges(site: string, from: readonly string[], to: readonly string[]): RuledLine[] {
	const name = siteName(site)
	return ruled(
		'reach.actions',
		union(from, to).flatMap((action) => {
			if (!from.includes(action)) return [closer('anyone-calls', `${name} runs as its own workload with \`${action}\`, for anyone who calls it`)]
			if (!to.includes(action)) return [narrowing(`${name} no longer runs with \`${action}\``)]
			return []
		}),
	)
}

const NO_REACH: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }

function reachChanges(site: string, from: DeclaredReach, to: DeclaredReach): RuledLine[] {
	const name = siteName(site)
	return reachSteps(from, to).map((step) => ({ ...step, line: `${name} ${step.line}` }))
}

/** The changes of one site's declared reach, each line phrased to follow the site's name. */
function reachSteps(from: DeclaredReach, to: DeclaredReach): RuledLine[] {
	const changes: RuledLine[] = [...ruled('reach.sql', modeChange('raw SQL', from.sql, to.sql))]
	for (const table of union(Object.keys(from.unscoped), Object.keys(to.unscoped))) {
		changes.push(...ruled('reach.unscoped', modeChange(`table \`${table}\` unscoped`, from.unscoped[table] ?? null, to.unscoped[table] ?? null)))
	}
	const connect: Line[] = []
	for (const connector of union(from.connect, to.connect)) {
		if (!from.connect.includes(connector)) connect.push(closer('off-road', `calls connector \`${connector}\``))
		else if (!to.connect.includes(connector)) connect.push(narrowing(`no longer calls connector \`${connector}\``))
	}
	changes.push(...ruled('reach.connect', connect))
	if (from.issues !== to.issues) {
		const issues: Line[] = []
		if (to.issues !== null) issues.push(closer('off-road', `issues share links of mount \`${to.issues}\``))
		if (from.issues !== null) issues.push(narrowing(`no longer issues share links of mount \`${from.issues}\``))
		changes.push(...ruled('reach.issues', issues))
	}
	changes.push(...ruled('reach.mailer', mailerChange(from.mailer, to.mailer)))
	return changes
}

/** Undeclared reaches no transport, `own` the application's, and `installation` the installation's credentials. */
function mailerChange(from: JobMailer | undefined, to: JobMailer | undefined): Line[] {
	if (from === to) return []
	if (to === undefined) return [narrowing('no longer sends e-mail')]
	if (to === 'installation') return [closer('off-road', "sends e-mail through the installation's mail transport")]
	if (from === undefined) return [widening('sends e-mail through its own transport')]
	return [narrowing("sends e-mail through its own transport, no longer the installation's")]
}

/** A kick starts a job the contract already schedules, so it widens nothing, like a form's `then`. */
function endpointKickChange(site: string, before: string | undefined, after: string | undefined): RuledLine[] {
	if (before === after) return []
	const name = siteName(site)
	return ruled('reach.then', [
		after === undefined
			? neutral(`${name} no longer starts job \`${before}\` after a call`)
			: startsJob(neutral(`${name} starts job \`${after}\` after each committed call, beside its schedule`), after),
	])
}

/** A line that says a call sets off a job. */
function startsJob(line: Line, job: string): Line {
	return { ...line, consequence: { kind: 'starts-job', job } }
}

/**
 * The jobs a site kicks after its commit (`kicks`). A job runs under its own approved actions, so a kick widens nothing,
 * except from a public procedure: anyone who calls it then decides when the job runs, which widens with closer review.
 */
function kicksChanges(site: string, from: readonly string[], to: DeclaredReach): RuledLine[] {
	const name = siteName(site)
	const kicks = to.kicks ?? []
	return ruled(
		'reach.kicks',
		union(from, kicks).flatMap((job) => {
			if (!from.includes(job)) {
				return [
					startsJob(
						to.actions === undefined
							? neutral(`${name} starts job \`${job}\` after each committed run, beside its schedule`)
							: closer('anyone-calls', `${name} starts job \`${job}\` whenever anyone calls it`),
						job,
					),
				]
			}
			if (!kicks.includes(job)) return [narrowing(`${name} no longer starts job \`${job}\``)]
			return []
		}),
	)
}

/** `null` is undeclared; `write` reaches more than `read`. */
function modeChange(reach: string, from: 'read' | 'write' | null, to: 'read' | 'write' | null): Line[] {
	if (from === to) return []
	if (to === null) return [narrowing(`no longer declares ${reach}`)]
	if (from === null) return [closer('off-road', `declares ${reach} (\`${to}\`)`)]
	return [
		to === 'write'
			? closer('off-road', `${reach} changes from \`read\` to \`write\``)
			: narrowing(`${reach} changes from \`write\` to \`read\``),
	]
}

function siteName(site: string): string {
	return site.startsWith(JOB_SITE_PREFIX) ? `Job \`${site.slice(JOB_SITE_PREFIX.length)}\`` : `Endpoint \`${site}\``
}

/** A site is an endpoint by its id, or a job (`job:<name>`). */
function siteSubject(site: string): ChangeSubjectDto {
	return site.startsWith(JOB_SITE_PREFIX) ? subjectOf('job', site.slice(JOB_SITE_PREFIX.length)) : subjectOf('endpoint', site)
}

/**
 * The database code the migrations declare, keyed by file, kind and object. New code widens with closer review, and so
 * does code in a file whose text changed, since the diff cannot tell what changed in it; removed code narrows.
 */
function compareDatabaseCode(changes: Changes, baseline: AccessSnapshot, candidate: AccessSnapshot): void {
	const before = new Map((baseline.databaseCode ?? []).map((deviation) => [deviationKey(deviation), deviation]))
	const after = new Map((candidate.databaseCode ?? []).map((deviation) => [deviationKey(deviation), deviation]))
	const beforeFiles = byName(baseline.migrations)
	const afterFiles = byName(candidate.migrations)
	for (const key of union([...before.keys()], [...after.keys()])) {
		const from = before.get(key)
		const to = after.get(key)
		const place = (file: string, line: Line) => changes.add(subjectOf('migration', file), ...ruled('migration.database-code', [line]))
		if (to === undefined) {
			if (from !== undefined) place(from.file, narrowing(`${migrationName(from.file)} no longer declares ${databaseObject(from)}`))
		} else if (from === undefined) place(to.file, closer('off-road', `${migrationName(to.file)} declares ${databaseObject(to)}`))
		else if (beforeFiles.get(to.file)?.checksum !== afterFiles.get(to.file)?.checksum) {
			place(to.file, closer('off-road', `${migrationName(to.file)} changes, and declares ${databaseObject(to)}`))
		}
	}
}

/**
 * The adoption steps of a migration file that is new or changed (ADR-0061). An adopted file is read under its table's
 * policy from then on, and a release deletes every file of the collection no column adopted, so each needs closer
 * review. A file the baseline holds unchanged has run already: the classifier may only have learned to report it.
 */
function compareFileAdoptions(changes: Changes, baseline: AccessSnapshot, candidate: AccessSnapshot): void {
	const beforeFiles = byName(baseline.migrations)
	const afterFiles = byName(candidate.migrations)
	for (const adoption of candidate.fileAdoptions ?? []) {
		if (beforeFiles.get(adoption.file)?.checksum === afterFiles.get(adoption.file)?.checksum) continue
		const name = migrationName(adoption.file)
		changes.add(
			subjectOf('migration', adoption.file),
			...(adoption.step === 'adopt'
				? ruled('migration.adopt', [
					closer(
						'adoption',
						`${name} adopts the files of collection \`${adoption.collection}\` into \`${adoption.table}\`: whoever the policy of \`${adoption.table}\` lets read a row reads its file`,
					),
				])
				: ruled('migration.release', [
					closer(
						'adoption',
						`${name} releases file collection \`${adoption.collection}\`: its table is dropped, with every file no column adopted`,
						'narrows',
					),
				])),
		)
	}
}

function migrationName(file: string): string {
	return `Migration \`${file}\``
}

function databaseObject(deviation: MigrationDeviation): string {
	if (deviation.kind === 'do') return `a \`DO\` block (\`${deviation.object}\`)`
	if (deviation.kind === 'expression') return `an expression that calls database code (\`${deviation.object}\`)`
	return `${deviation.kind} \`${deviation.object}\``
}

/**
 * Every step off the paved road a snapshot holds, grouped by the site or migration that takes it: the reach its sites
 * declare and the database code its migrations declare. The environment page lists them for the published snapshot.
 */
export function snapshotDeviations(snapshot: AccessSnapshot): DeviationSubjectDto[] {
	const sites = Object.entries(snapshot.contract?.declared ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	const declared = sites.map(([site, reach]) => ({
		subject: siteName(site),
		steps: reachSteps(NO_REACH, reach).map((change) => change.line),
	}))
	const migrations = new Map<string, string[]>()
	for (const deviation of snapshot.databaseCode ?? []) {
		const steps = migrations.get(deviation.file) ?? []
		steps.push(`declares ${databaseObject(deviation)}`)
		migrations.set(deviation.file, steps)
	}
	const databaseCode = [...migrations].map(([file, steps]) => ({ subject: migrationName(file), steps }))
	return [...declared, ...databaseCode].filter((subject) => subject.steps.length > 0)
}

// ── Endpoints ───────────────────────────────────────────────────────────────────────────────────

/**
 * Endpoints by id, and where the paths of a removed one go. Answers the removed mounts whose rows it already showed,
 * so the mount comparison does not show them a second time.
 */
function compareEndpoints(changes: Changes, baseline: ContractArtifact, candidate: ContractArtifact): ReadonlySet<string> {
	compareKeyed(changes, 'endpoint', endpointMap(baseline.endpoints), endpointMap(candidate.endpoints), {
		added: (id, row) => {
			const line = `New endpoint \`${id}\` (${route(row)}) ${audience(row)}${answersFile(row)}${callableFrom(row)}${reusedFor(row.cache)}`
			// Code anyone can call gets a closer review than code a signed-in caller reaches.
			const change = row.kind === 'public' ? closer('anyone-calls', line) : widening(line)
			return row.crossOrigin === 'environment' ? { ...change, environmentOrigins: true } : change
		},
		removed: () => [],
		changed: endpointChanges,
	})
	const remaining = endpointMap(candidate.endpoints)
	// A removed mount takes all its rows with it: one line for the mount says where each of its paths goes.
	const removedMounts = new Map<string, EndpointRow[]>()
	for (const row of baseline.endpoints) {
		if (remaining.has(row.id)) continue
		if (row.source.kind === 'mount' && Object.hasOwn(baseline.mounts, row.source.name) && !Object.hasOwn(candidate.mounts, row.source.name)) {
			removedMounts.set(row.source.name, [...(removedMounts.get(row.source.name) ?? []), row])
			continue
		}
		const fate = fallThrough(row, baseline, candidate)
		changes.add(
			subjectOf('endpoint', row.id),
			...ruled('endpoint.removed', [
				withOrigins({ effect: fate.effect, line: `Endpoint \`${row.id}\` (${route(row)}) is removed; its paths ${fate.words(true)}` }, fate),
			]),
		)
	}
	for (const [mount, rows] of removedMounts) {
		changes.add(subjectOf('mount', mount), ...ruled('mount.removed', [removedMountChange(mount, rows, baseline, candidate)]))
	}
	return new Set(removedMounts.keys())
}

/**
 * One line for a removed mount: its routes, grouped by where they go now and by their effect, so two routes worded
 * alike but classified apart never share a group. The strongest effect of any route is the line's. The mount takes
 * more than its routes with it (the public variables its pages read, a form's admission, a link mount's grants), so
 * only an SPA mount that served no public variable can leave access unchanged; any other narrows at least.
 */
function removedMountChange(mount: string, rows: readonly EndpointRow[], baseline: ContractArtifact, candidate: ContractArtifact): Line {
	const artifact: MountArtifact | undefined = baseline.mounts[mount]
	const groups = new Map<string, { readonly fate: Fate; readonly routes: string[] }>()
	for (const row of rows) {
		const fate = fallThrough(row, baseline, candidate)
		const key = `${fate.effect} ${fate.words(true)}`
		const group = groups.get(key)
		if (group === undefined) groups.set(key, { fate, routes: [route(row)] })
		else group.routes.push(route(row))
	}
	const parts = [...groups.values()].map(({ fate, routes }) => ({ effect: fate.effect, text: `${andList(routes)} ${fate.words(routes.length > 1)}` }))
	const served = artifact === undefined ? [] : servedNames(artifact)
	if (served.length > 0) {
		parts.push({ effect: 'narrows', text: `its pages no longer get the public variable${served.length === 1 ? '' : 's'} ${listOf(served, 'none')}` })
	}
	const keepsAccess = artifact?.kind === 'spa' && served.length === 0
	const effect = parts.some((part) => part.effect === 'widens')
		? 'widens'
		: !keepsAccess || parts.some((part) => part.effect === 'narrows')
		? 'narrows'
		: 'neutral'
	const line = `Mount \`${mount}\` is removed: ${parts.map((part) => part.text).join('; ')}`
	return withOrigins({ effect, line }, { environmentOrigins: [...groups.values()].some(({ fate }) => fate.environmentOrigins) })
}

/** A change, marked when its paths now reach an endpoint open to the environment's cross-origin list. */
function withOrigins(change: Line, fate: Pick<Fate, 'environmentOrigins'>): Line {
	return fate.environmentOrigins ? { ...change, environmentOrigins: true } : change
}

/**
 * Where a removed endpoint's paths go: the effect, the words that follow the routes (for one route or several), and
 * whether the paths now reach an endpoint open to the environment's cross-origin list that the removed one was not.
 */
interface Fate {
	readonly effect: AccessEffect
	words(plural: boolean): string
	readonly environmentOrigins: boolean
}

/**
 * Where the paths of a removed endpoint go. The proxy selects the most specific endpoint, so a removed one may have
 * shadowed a broader one (ADR-0050 §3), which then answers all of its paths, some or none. The canonical matcher says
 * which endpoint each path reaches before and after (`probePaths`), so an endpoint that only ever answered its own paths
 * is never taken for one that answers the removed one's. The paths answer the callers the endpoints that reach them
 * admit: no endpoint narrows, endpoints that admit exactly the removed one's callers change nothing, endpoints that
 * admit no caller more narrow, and any other widens. Paths of which some are denied narrow at least.
 */
function fallThrough(row: EndpointRow, baseline: ContractArtifact, candidate: ContractArtifact): Fate {
	const before = compiledTable(baseline)
	const after = compiledTable(candidate)
	const reached = new Map<string, EndpointRow>()
	let denied = false
	for (const path of probePaths(row.path, [...baseline.endpoints, ...candidate.endpoints].map((other) => other.path))) {
		const then = planEndpoint(before, row.method, path)
		if (then.outcome !== 'endpoint' || then.endpoint.id !== row.id) continue
		const now = planEndpoint(after, row.method, path)
		if (now.outcome === 'endpoint') reached.set(now.endpoint.id, now.endpoint)
		else denied = true
	}
	if (reached.size === 0) return { effect: 'narrows', words: (plural) => (plural ? 'are denied' : 'is denied'), environmentOrigins: false }
	const answering = [...reached.values()]
	const reach = (plural: boolean) => (plural ? 'now reach' : 'now reaches')
	const rest = (plural: boolean) => (denied ? `, and ${plural ? 'are' : 'is'} otherwise denied` : '')
	const was = audience(row)
	const environmentOrigins = row.crossOrigin === undefined && answering.some((other) => other.crossOrigin === 'environment')
	const removed = { row, artifact: baseline }
	const sided = answering.map((other) => ({ row: other, artifact: candidate }))
	const fewer = sided.every((other) => admitsNoMoreThan(other, removed))
	const same = fewer && sided.every((other) => admitsNoMoreThan(removed, other))
	const effect: AccessEffect = !fewer ? 'widens' : same && !denied ? 'neutral' : 'narrows'
	if (same && answering.every((other) => audience(other) === was)) {
		const ids = listOf(answering.map((other) => other.id), 'none')
		return { effect, words: (plural) => `${reach(plural)} ${ids} ${was}, as before${rest(plural)}`, environmentOrigins }
	}
	const answers = answering.map((other) => `\`${other.id}\` ${audience(other)}`).join(', ')
	return {
		effect,
		words: (plural) => `${reach(plural)} ${answers}, where ${plural ? 'they were' : 'it was'} ${was}${rest(plural)}`,
		environmentOrigins,
	}
}

const COMPILED = new WeakMap<ContractArtifact, CompiledEndpointTable>()

/** An artifact's endpoint table for the canonical matcher, compiled once per artifact. */
function compiledTable(artifact: ContractArtifact): CompiledEndpointTable {
	const known = COMPILED.get(artifact)
	if (known !== undefined) return known
	const table = compileEndpointTable(artifact)
	COMPILED.set(artifact, table)
	return table
}

/**
 * Request paths that stand for every path `pattern` matches, as finely as `patterns` tell paths apart. A segment matters
 * only where a pattern that may still match has a literal: each such literal is tried, one fresh value stands for every
 * other segment, and an empty last segment (a trailing `/`) for itself. Once every pattern that may still match has
 * passed its wildcard, longer paths behave alike, so the path goes no deeper. The paths only enumerate: which endpoint
 * one reaches is the canonical matcher's to say (`planEndpoint`), so they may include paths `pattern` does not match.
 */
export function probePaths(pattern: string, patterns: readonly string[]): string[] {
	const own = segmentsOf(pattern)
	const all = [own, ...patterns.map(segmentsOf)]
	const literals = new Set(all.flat().filter(isLiteral))
	let fresh = 'x'
	while (literals.has(fresh)) fresh += 'x'
	const paths: string[] = []
	const extend = (prefix: readonly string[], live: readonly (readonly string[])[]): void => {
		paths.push(`/${prefix.join('/')}`)
		const index = prefix.length
		const mine = own[index]
		const pastWildcard = own.at(-1) === '*' && index >= own.length - 1
		// A trailing `/` ends the path; past the end of `pattern`, or of every pattern that may still match, nothing differs.
		if (prefix.at(-1) === '' || (mine === undefined && !pastWildcard)) return
		if (live.every((segments) => segments.at(-1) === '*' && segments.length <= index)) return
		const values = mine !== undefined && isLiteral(mine) ? [mine] : [
			...new Set(live.flatMap((segments) => {
				const segment = segments[index]
				return segment !== undefined && isLiteral(segment) && (segment !== '' || pastWildcard) ? [segment] : []
			})),
			fresh,
			...(pastWildcard && index > 0 ? [''] : []),
		]
		for (const value of new Set(values)) extend([...prefix, value], live.filter((segments) => mayMatch(segments, index, value)))
	}
	extend([], all)
	return [...new Set(paths)]
}

/** Whether a pattern that may match a path's first `index` segments may still match it with `value` as the next one. */
function mayMatch(segments: readonly string[], index: number, value: string): boolean {
	const segment = segments[index]
	if (segment === undefined) return segments.at(-1) === '*' && segments.length <= index
	if (segment === '*') return true
	return segment.startsWith(':') ? value !== '' : segment === value
}

function isLiteral(segment: string): boolean {
	return segment !== '*' && !segment.startsWith(':')
}

/** A row and the artifact it is read from, for what the proxy derives from the artifact (its delegation). */
interface SidedRow {
	readonly row: EndpointRow
	readonly artifact: ContractArtifact
}

/**
 * Whether `after` admits only callers `before` admitted on the same paths. Conservative: any difference it cannot show
 * to admit no one more admits more. Every field of the row has its say (`ADMITS_NO_MORE`), and so does the one input of
 * the proxy's decision a row does not carry: its delegation, derived from the artifact (`endpointDelegation`). The
 * delegation is compared only after a signed-in endpoint: after one anyone opens, no delegation admits more.
 */
function admitsNoMoreThan(after: SidedRow, before: SidedRow): boolean {
	if (!Object.values(ADMITS_NO_MORE).every((admits) => admits(after.row, before.row))) return false
	if (before.row.requirement === null) return true
	return canonicalJson(endpointDelegation(after.artifact, after.row)) === canonicalJson(endpointDelegation(before.artifact, before.row))
}

/**
 * How each field of an endpoint row bears on who may call it: whether `after` admits no one `before` did not, as far as
 * that field goes. The record is total over the row's fields, so a field auth-core adds to `EndpointRow` fails this
 * file's typecheck until it is placed here. A field the proxy applies (ADR-0022; `requirementDigest` covers them) is
 * compared, never waved through: a removal it would let pass unapproved must not slip in through a new field.
 *
 * - An anonymous endpoint anyone opens (a health check, a public SPA) admits no one more than any endpoint does after
 *   it: a signed-in one admits fewer, another one anyone opens the same. A form and a webhook turn callers away
 *   themselves (a challenge, a signature), so no other endpoint is shown to admit no one more than they did.
 * - A signed-in endpoint: the same kind and requirement and no caller kind more. A requirement whose scope is read from
 *   a path parameter (`from`) is read from another segment of a broader route, so it is never the same. A `link`
 *   caller holds one link mount's keys, so it is the same caller only on a row of the same mount.
 * - Neither may admit a body or another origin `before` refused.
 */
const ADMITS_NO_MORE: { readonly [Field in keyof EndpointRow]-?: (after: EndpointRow, before: EndpointRow) => boolean } = {
	// Applied by the proxy.
	kind: (after, before) =>
		before.requirement === null ? opensToAnyone(before) && (after.requirement !== null || opensToAnyone(after)) : after.kind === before.kind,
	requirement: (after, before) => {
		if (before.requirement === null) return opensToAnyone(before)
		if (after.requirement === null || readsPathParameter(after) || readsPathParameter(before)) return false
		return canonicalJson(after.requirement) === canonicalJson(before.requirement)
	},
	callers: (after, before) => {
		if (before.requirement === null) return opensToAnyone(before)
		const sameMount = after.source.kind === before.source.kind && after.source.name === before.source.name
		return after.callers.every((caller: string) => (caller !== 'link' || sameMount) && before.callers.some((other: string) => other === caller))
	},
	admission: (after, before) => after.admission === null || canonicalJson(after.admission) === canonicalJson(before.admission),
	crossOrigin: (after, before) => crossOriginRank(after.crossOrigin) <= crossOriginRank(before.crossOrigin),
	// The file treatment the proxy gives every answer of a file procedure, denials included.
	response: (after, before) => after.response === before.response,
	// A cache keeps a copy of a public answer beyond a change: a row that caches where the removed one did not is shown.
	cache: (after, before) => canonicalJson(after.cache ?? null) === canonicalJson(before.cache ?? null),
	// A forwarded `Authorization` reaches application code: a row that forwards where the removed one did not is shown.
	authorization: (after, before) => after.authorization === undefined || after.authorization === before.authorization,
	// The rows that answer the removed row's paths now were selected by its method; the paths are the removed row's.
	method: (after, before) => after.method === before.method,
	path: () => true,
	// Not applied by the proxy. The id names the row; its mount matters only to a `link` caller (`callers`). The
	// handler of the answering row, schemas included, was approved for its whole route.
	id: () => true,
	source: () => true,
	input: () => true,
	output: () => true,
}

/** An anonymous endpoint that turns no caller away: anyone who asks gets the answer. */
function opensToAnyone(row: EndpointRow): boolean {
	return row.kind === 'health' || row.kind === 'public-spa' || row.kind === 'public'
}

/** Whether the row's requirement takes its scope from one of the row's path parameters. */
function readsPathParameter(row: EndpointRow): boolean {
	if (row.requirement?.kind !== 'action') return false
	const { access } = row.requirement
	if (access.form !== 'in' && access.form !== 'on') return false
	return access.from !== null && segmentsOf(row.path).includes(`:${access.from}`)
}

/** No other origin, the environment's list, any origin: each admits every page the one before it does. */
function crossOriginRank(form: CrossOriginForm | undefined): number {
	return form === undefined ? 0 : form === 'environment' ? 1 : 2
}

function route(row: EndpointRow): string {
	return `${row.method} ${row.path}`
}

function andList(values: readonly string[]): string {
	return values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`
}

function endpointChanges(id: string, from: EndpointRow, to: EndpointRow): RuledLine[] {
	const name = `Endpoint \`${id}\``
	const becomesPublic = from.requirement !== null && (to.kind === 'public-spa' || to.kind === 'public')
	return [
		...ruled(
			'endpoint.public',
			!becomesPublic ? [] : to.kind === 'public'
				? [closer('anyone-calls', `${name} becomes public: anyone calls it without signing in`)]
				: [widening(`${name} becomes public: anyone opens it without signing in`)],
		),
		...ruled('endpoint.kind', valueChange(`${name} kind`, from.kind, to.kind)),
		...ruled('endpoint.route', valueChange(`${name} route`, `${from.method} ${from.path}`, `${to.method} ${to.path}`)),
		...ruled('endpoint.callers', setChanges(name, from.callers, to.callers, 'gains caller', 'loses caller')),
		...ruled('endpoint.requirement', valueChange(`${name} requirement`, from.requirement, to.requirement)),
		...admissionChanges(name, from, to),
		...ruled('endpoint.cross-origin', crossOriginChanges(name, from.crossOrigin, to.crossOrigin)),
		...ruled('endpoint.cache', cacheChange(name, from.cache, to.cache)),
		...ruled('endpoint.authorization', authorizationChange(name, from.authorization, to.authorization)),
		...ruled('endpoint.input', schemaChanges({ endpoint: name, side: 'input', path: '' }, from.input, to.input)),
		...ruled('endpoint.output', outputChanges(name, from.output, to.output)),
	]
}

/**
 * `, callable from …` for an endpoint a page on another origin may call (ADR-0022 "Cross-origin endpoints"): the
 * approver sees which pages the contract lets in, the environment's list or every site.
 */
function callableFrom(row: EndpointRow): string {
	return row.crossOrigin === undefined ? '' : `, callable from ${crossOriginReach(row.crossOrigin)}`
}

export function crossOriginReach(form: CrossOriginForm): string {
	return form === 'any' ? 'a page on any origin' : 'a page on an origin the environment lists'
}

/** Opening an endpoint to another origin widens, and so does `environment` → `any`; the reverse narrows. */
function crossOriginChanges(name: string, from: CrossOriginForm | undefined, to: CrossOriginForm | undefined): Line[] {
	if (from === to) return []
	if (to === undefined) return [narrowing(`${name} is no longer callable from another origin`)]
	const line = from === 'any'
		? narrowing(`${name} is callable only from ${crossOriginReach(to)}`)
		: widening(`${name} becomes callable from ${crossOriginReach(to)}`)
	return [to === 'environment' ? { ...line, environmentOrigins: true } : line]
}

/**
 * `, whose answers … may reuse` for a public query that declares `http.cache`: a copy outlives a change the application
 * makes, and `immutable` is right only when the input names a value that never changes, which the approver checks.
 */
function reusedFor(cache: EndpointCache | undefined): string {
	if (cache === undefined) return ''
	return cache === 'immutable'
		? ', whose successful answers a browser or a CDN reuses for a year: its input must name a value that never changes'
		: `, whose successful answers a browser or a CDN reuses for ${seconds(cache.maxAgeSeconds * 1000)}`
}

/** A changed `http.cache` reaches no data: the line shows how long a copy may outlive a change. */
function cacheChange(name: string, from: EndpointCache | undefined, to: EndpointCache | undefined): Line[] {
	if (canonicalJson(from ?? null) === canonicalJson(to ?? null)) return []
	return [neutral(to === undefined ? `${name} answers are no longer reused` : `${name}${reusedFor(to)}`)]
}

/** A webhook row that forwards the sender's `Authorization` hands application code a credential the proxy never reads. */
function authorizationChange(name: string, from: EndpointAuthorization | undefined, to: EndpointAuthorization | undefined): Line[] {
	if (from === to) return []
	return to === undefined
		? [narrowing(`${name} no longer receives the sender's own Authorization header`)]
		: [widening(`${name} receives the sender's own Authorization header, unless it carries a platform key`)]
}

/** `, answering the file …` for an endpoint whose output is an attachment: the approver sees that data leaves as a file. */
function answersFile(row: EndpointRow): string {
	if (row.output !== null && isRedirectShape(row.output)) return `, answering ${redirectReach(row.output)}`
	if (row.output !== null && isFileShape(row.output)) return `, answering ${storedFileName(row.output)}`
	const file = attachmentName(row)
	return file === null ? '' : `, answering ${file}`
}

/** `the CSV file \`notes.csv\`` for an endpoint whose output is an attachment, otherwise null. */
export function attachmentName(row: EndpointRow): string | null {
	return row.output !== null && isAttachmentShape(row.output) ? `the ${row.output.format.toUpperCase()} file \`${row.output.filename}\`` : null
}

/**
 * An output: two schemas compare as schemas; two attachments by their limits and columns; a change between a JSON
 * answer and a file widens. A file's name and its column order grant nothing, so they narrow at most.
 */
function outputChanges(name: string, from: OutputShape | null, to: OutputShape | null): Line[] {
	if (from !== null && isFileShape(from) && to !== null && isFileShape(to)) {
		return valueChange(`${name} file kind`, from.kind, to.kind)
	}
	if (from !== null && isAttachmentShape(from) && to !== null && isAttachmentShape(to)) {
		return attachmentChanges(name, from, to)
	}
	if (from !== null && isRedirectShape(from) && to !== null && isRedirectShape(to)) {
		// A redirect may go to more places: an added origin widens, a dropped one narrows.
		return setChanges(`${name} redirect`, from.origins, to.origins, 'may go to', 'no longer goes to')
	}
	if ((from === null || isSchemaOutput(from)) && (to === null || isSchemaOutput(to))) {
		return schemaChanges({ endpoint: name, side: 'output', path: '' }, from, to)
	}
	return [widening(`${name} output changes from ${outputKind(from)} to ${outputKind(to)}`)]
}

function outputKind(shape: OutputShape | null): string {
	if (shape === null) return 'none'
	if (isRedirectShape(shape)) return redirectReach(shape)
	if (isFileShape(shape)) return storedFileName(shape)
	return isAttachmentShape(shape) ? `the ${shape.format.toUpperCase()} file \`${shape.filename}\`` : 'JSON'
}

/** `a stored file of kind \`attachments\``: a file a handler wrote or read, streamed. */
export function storedFileName(shape: FileShape): string {
	return `a stored file of kind \`${shape.kind}\``
}

/** `a redirect to its own origin` or `… or https://partner.example`: where anyone who calls it may be sent. */
function redirectReach(shape: RedirectShape): string {
	return shape.origins.length === 0 ? 'a redirect to its own origin' : `a redirect to its own origin or ${listOf(shape.origins, '')}`
}

function attachmentChanges(name: string, from: AttachmentShape, to: AttachmentShape): Line[] {
	const file = `${name} file`
	const renamed = from.filename === to.filename ? [] : [narrowing(`${file} name changes from \`${from.filename}\` to \`${to.filename}\``)]
	const columns = (shape: AttachmentShape) => Object.fromEntries(shape.columns.map((column) => [column.name, column.shape]))
	return [
		...valueChange(`${file} format`, from.format, to.format),
		...renamed,
		...limitChange(`${file} size limit`, from.maxBytes, to.maxBytes),
		...limitChange(`${file} row limit`, from.maxRows, to.maxRows),
		...fieldChanges({ endpoint: name, side: 'output', path: '' }, columns(from), columns(to)),
	]
}

function admissionChanges(name: string, from: EndpointRow, to: EndpointRow): RuledLine[] {
	const before = from.admission
	const after = to.admission
	if (before === null || after === null) {
		if (before === after) return []
		return ruled('endpoint.body', [
			after === null ? narrowing(`${name} no longer admits a body`) : widening(`${name} admits a body of ${after.contentTypes.join(', ')}`),
		])
	}
	const bigger = after.maxBytes === null ? before.maxBytes !== null : before.maxBytes !== null && after.maxBytes > before.maxBytes
	const sizeChange = before.maxBytes === after.maxBytes
		? []
		: [(bigger ? widening : narrowing)(`${name} body limit changes from ${bytes(before.maxBytes)} to ${bytes(after.maxBytes)}`)]
	return [
		...ruled('endpoint.body-types', setChanges(name, before.contentTypes, after.contentTypes, 'admits', 'no longer admits')),
		...ruled('endpoint.body-limit', sizeChange),
	]
}

// ── Schemas ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a schema change lies: the endpoint, its input or output, and the field path (`items[].stage`). The two sides
 * differ only for a removed required field: an input without it was refused before, an output without it tells less.
 */
interface SchemaSite {
	readonly endpoint: string
	readonly side: 'input' | 'output'
	readonly path: string
}

function siteLabel(site: SchemaSite): string {
	return site.path === '' ? `${site.endpoint} ${site.side}` : `${site.endpoint} ${site.side} \`${site.path}\``
}

function fieldSite(site: SchemaSite, field: string): SchemaSite {
	return { ...site, path: site.path === '' ? field : `${site.path}.${field}` }
}

function itemsSite(site: SchemaSite): SchemaSite {
	return { ...site, path: `${site.path}[]` }
}

/**
 * The values a schema admits, compared structurally: a change that can only admit fewer values narrows, any other
 * change widens. No logical implication between schemas is attempted, so an equivalent rewrite widens too.
 */
function schemaChanges(site: SchemaSite, from: SchemaShape | null, to: SchemaShape | null): Line[] {
	if (canonicalJson(from) === canonicalJson(to)) return []
	if (from === null || to === null) return valueChange(siteLabel(site), from, to)
	const before = unwrapped(from)
	const after = unwrapped(to)
	const label = siteLabel(site)
	return [
		...flagChange(before.optional, after.optional, widening(`${label} becomes optional`), narrowing(`${label} becomes required`)),
		...flagChange(before.nullable, after.nullable, widening(`${label} admits null`), narrowing(`${label} no longer admits null`)),
		...coreChanges(site, before.core, after.core),
	]
}

interface Unwrapped {
	readonly optional: boolean
	readonly nullable: boolean
	readonly core: SchemaShape
}

function unwrapped(shape: SchemaShape): Unwrapped {
	let optional = false
	let nullable = false
	let core = shape
	for (;;) {
		if (core.type === 'optional') optional = true
		else if (core.type === 'nullable') nullable = true
		else return { optional, nullable, core }
		core = core.inner
	}
}

function flagChange(before: boolean, after: boolean, gained: Line, lost: Line): Line[] {
	return before === after ? [] : [after ? gained : lost]
}

function coreChanges(site: SchemaSite, from: SchemaShape, to: SchemaShape): Line[] {
	if (canonicalJson(from) === canonicalJson(to)) return []
	const label = siteLabel(site)
	const fromValues = finiteValues(from)
	const toValues = finiteValues(to)
	if (fromValues !== null && toValues !== null) return valueSetChanges(label, fromValues, toValues)
	if (from.type === 'object' && to.type === 'object') return fieldChanges(site, from.fields, to.fields)
	if (from.type === 'string' && to.type === 'string') return stringChanges(label, from, to)
	if (from.type === 'number' && to.type === 'number') return numberChanges(label, from, to)
	if (from.type === 'array' && to.type === 'array') {
		return [
			...lowerLimitChange(`${label} minimum items`, from.minItems, to.minItems),
			...limitChange(`${label} maximum items`, from.maxItems, to.maxItems),
			...schemaChanges(itemsSite(site), from.items, to.items),
		]
	}
	// Every union change widens, a removed or reordered option too: the first option that accepts a value decides what
	// projection keeps of it, so another option can pass on fields the old one stripped.
	return valueChange(label, from, to)
}

function fieldChanges(site: SchemaSite, from: Readonly<Record<string, SchemaShape>>, to: Readonly<Record<string, SchemaShape>>): Line[] {
	const label = siteLabel(site)
	const changes: Line[] = []
	for (const field of union(Object.keys(from), Object.keys(to))) {
		const before = from[field]
		const after = to[field]
		if (before === undefined) changes.push(widening(`${label} gains field \`${field}\``))
		else if (after === undefined) {
			const required = site.side === 'input' && !unwrapped(before).optional
			changes.push(required ? widening(`${label} loses required field \`${field}\``) : narrowing(`${label} loses field \`${field}\``))
		} else changes.push(...schemaChanges(fieldSite(site, field), before, after))
	}
	return changes
}

/** The values of a literal or an enum, as canonical JSON; `null` for a schema that admits more than a listed set. */
function finiteValues(shape: SchemaShape): string[] | null {
	if (shape.type === 'literal') return [canonicalJson(shape.value)]
	if (shape.type === 'enum') return shape.values.map((value) => canonicalJson(value))
	return null
}

function valueSetChanges(label: string, from: readonly string[], to: readonly string[]): Line[] {
	return setLines(from, to, {
		added: (value) => widening(`${label} admits ${shownValue(value)}`),
		removed: (value) => narrowing(`${label} no longer admits ${shownValue(value)}`),
	})
}

function stringChanges(label: string, from: StringShape, to: StringShape): Line[] {
	return [
		...constraintChange(`${label} format`, from.format, to.format),
		...lowerLimitChange(`${label} minimum length`, from.minLength, to.minLength),
		...limitChange(`${label} maximum length`, from.maxLength, to.maxLength),
		...constraintChange(`${label} pattern`, from.pattern, to.pattern),
		...constraintChange(`${label} prefix`, from.startsWith, to.startsWith),
		...constraintChange(`${label} suffix`, from.endsWith, to.endsWith),
		...constraintChange(`${label} required substring`, from.includes, to.includes),
	]
}

function numberChanges(label: string, from: NumberShape, to: NumberShape): Line[] {
	const integer = flagChange(from.int, to.int, narrowing(`${label} admits only integers`), widening(`${label} admits non-integers`))
	return [
		...integer,
		...boundChange(`${label} minimum`, { value: from.min, exclusive: from.exclusiveMin }, { value: to.min, exclusive: to.exclusiveMin }, 1),
		...boundChange(`${label} maximum`, { value: from.max, exclusive: from.exclusiveMax }, { value: to.max, exclusive: to.exclusiveMax }, -1),
		...constraintChange(`${label} multiple`, from.multipleOf, to.multipleOf),
	]
}

/** A constraint added where there was none narrows; any other change of it widens. */
function constraintChange(subject: string, before: string | number | null, after: string | number | null): Line[] {
	if (before === after) return []
	return [
		(before === null ? narrowing : widening)(`${subject} changes from ${shownValue(canonicalJson(before))} to ${shownValue(canonicalJson(after))}`),
	]
}

interface Bound {
	readonly value: number | null
	readonly exclusive: boolean
}

/**
 * A numeric bound: `direction` is 1 for a minimum (a higher one narrows) and -1 for a maximum. At the same value an
 * exclusive bound is the tighter one.
 */
function boundChange(subject: string, before: Bound, after: Bound, direction: 1 | -1): Line[] {
	if (before.value === after.value && before.exclusive === after.exclusive) return []
	const tighter = after.value !== null && (before.value === null || (after.value - before.value) * direction > 0
		|| (after.value === before.value && after.exclusive))
	return [(tighter ? narrowing : widening)(`${subject} changes from ${boundText(before)} to ${boundText(after)}`)]
}

function boundText(bound: Bound): string {
	return bound.value === null ? 'none' : `${bound.value}${bound.exclusive ? ' (exclusive)' : ''}`
}

/** A higher minimum narrows; a lower or removed one widens. `null` is no limit. */
function lowerLimitChange(subject: string, before: number | null, after: number | null): Line[] {
	if (before === after) return []
	const higher = after !== null && (before === null || after > before)
	return [(higher ? narrowing : widening)(`${subject} changes from ${before ?? 'none'} to ${after ?? 'none'}`)]
}

/** A string value bare, any other JSON value as written. */
function shownValue(json: string): string {
	const value: unknown = JSON.parse(json)
	return typeof value === 'string' ? `\`${value}\`` : shown(json)
}

function segmentsOf(path: string): string[] {
	return path === '/' ? [] : path.slice(1).split('/')
}

function audience(row: EndpointRow): string {
	if (row.kind === 'public-spa' || row.kind === 'public') return 'for anyone, without signing in'
	if (row.requirement === null) return `for anonymous ${row.kind} requests`
	return `for ${row.callers.join(', ')} callers ${requirementPhrase(row.requirement)}`
}

/** What a credentialed caller must hold: `who are members`, or `` with `notes.read` (on `note`) ``. */
export function requirementPhrase(requirement: EndpointRequirement): string {
	if (requirement.kind === 'member') return 'who are members'
	if (requirement.kind === 'capabilities') {
		const each = Object.entries(requirement.capabilities).map(([name, { action, access }]) =>
			`\`${action}\` (${access.form} \`${access.dimension}\`, as \`${name}\`)`
		)
		return `with each of ${andList(each)}`
	}
	const { action, access } = requirement
	return access.form === 'app' ? `with \`${action}\` (app-wide: a global grant)` : `with \`${action}\` (${access.form} \`${access.dimension}\`)`
}

function endpointMap(rows: readonly EndpointRow[]): Map<string, EndpointRow> {
	return new Map(rows.map((row) => [row.id, row]))
}

// ── Roles, files, tables ────────────────────────────────────────────────────────────────────────

function roleChanges(name: string, from: RoleArtifact, to: RoleArtifact): RuledLine[] {
	const role = `Role \`${name}\``
	const external = externalChange(name, from.external, to.external)
	const grants = ruled('role.grants', setChanges(role, from.grants, to.grants, 'gains', 'loses'))
	if (from.member === null || to.member === null || from.member.scope !== to.member.scope) {
		return [...grants, ...ruled('role.membership', valueChange(`${role} membership`, from.member, to.member)), ...external]
	}
	return [
		...grants,
		...ruled(
			'role.assignable-by',
			setChanges(role, from.member.assignableBy, to.member.assignableBy, 'can be assigned by', 'can no longer be assigned by'),
		),
		...external,
	]
}

/** An external role may be held by a person from outside the organization (ADR-0051). */
function externalChange(name: string, before: true | undefined, after: true | undefined): RuledLine[] {
	if (before === after) return []
	return ruled('role.external', [
		after === true
			? widening(`Role \`${name}\` may be held by external principals, people from outside the organization`)
			: narrowing(`Role \`${name}\` may no longer be held by external principals`),
	])
}

/** `image/png, at most 262144 bytes, served only after a clean scan`. */
function fileKindPhrase(kind: FileKindArtifact): string {
	return `${listOf(kind.types, 'no types')}, at most ${bytes(kind.maxBytes)}${kind.scan === true ? ', served only after a clean scan' : ''}`
}

function fileKindChanges(name: string, from: FileKindArtifact, to: FileKindArtifact): RuledLine[] {
	const kind = `File kind \`${name}\``
	return [
		...ruled('file-kind.types', setChanges(kind, from.types, to.types, 'admits', 'no longer admits')),
		...ruled('file-kind.size-limit', limitChange(`${kind} size limit`, from.maxBytes, to.maxBytes)),
		...ruled(
			'file-kind.scan',
			flagChange(
				from.scan === true,
				to.scan === true,
				narrowing(`${kind} serves a file only after a clean scan`),
				widening(`${kind} no longer waits for a scan`),
			),
		),
	]
}

/**
 * `` `deals.write` writes `deal_attachments.file` (attachments) ``, for each action that inserts or updates the column: a
 * file's reach is the reach of the column that holds it.
 */
function fileColumnLines(name: string, table: TablePolicyArtifact): Line[] {
	return Object.entries(table.files ?? {}).map(([column, kind]) => {
		const ownWrite = table.columns[column]?.write
		const writers = [
			...(table.insert.includes(column) ? tableActions(table.actions.insert) : []),
			...(table.update.includes(column) ? tableActions(table.actions.update) : []),
			...(ownWrite === undefined ? [] : [ownWrite]),
		]
		const holder = `\`${name}.${column}\` (${kind})`
		return neutral(
			writers.length === 0 ? `No action writes ${holder}` : `${[...new Set(writers)].map((action) => `\`${action}\``).join(' and ')} writes ${holder}`,
		)
	})
}

function fileChanges(name: string, from: FileCollectionArtifact, to: FileCollectionArtifact): RuledLine[] {
	const files = `File collection \`${name}\``
	const linkChange = fileLinkChanges(files, from.link, to.link)
	// Without scanning, an upload is served the moment it is written.
	const scanChange = (from.scan === true) === (to.scan === true)
		? []
		: [
			to.scan === true
				? narrowing(`${files} scans every upload for malware before serving it`)
				: widening(`${files} stops scanning uploads for malware`),
		]
	return [
		...ruled('file-collection.owner', valueChange(`${files} owner`, from.owner, to.owner)),
		...ruled('file-collection.read', valueChange(`${files} read action`, from.read, to.read)),
		...ruled('file-collection.write', valueChange(`${files} write action`, from.write, to.write)),
		...ruled('file-collection.delete', valueChange(`${files} delete action`, from.delete, to.delete)),
		...ruled('file-collection.size-limit', limitChange(`${files} size limit`, from.maxBytes, to.maxBytes)),
		...ruled('file-collection.per-owner', limitChange(`${files} limit per owner`, from.maxPerOwner, to.maxPerOwner)),
		...ruled('file-collection.types', setChanges(files, from.types, to.types, 'accepts', 'no longer accepts')),
		...ruled('file-collection.link', linkChange),
		...ruled('file-collection.scan', scanChange),
	]
}

/** The share links a collection's `link` reaches it through: every link mount of its owner, or the named ones. */
function linkReach(link: true | readonly string[]): string {
	return link === true ? 'share links' : `the share links of mount ${listOf(link, 'none')}`
}

function fileLinkChanges(files: string, from: boolean | readonly string[], to: boolean | readonly string[]): Line[] {
	if (from === to) return []
	if (to === false) return [narrowing(`${files} is no longer reachable through share links`)]
	if (from === false) return [widening(`${files} becomes reachable through ${linkReach(to)}`)]
	if (to === true) return [widening(`${files} becomes reachable through the share links of every link mount bound to its owner`)]
	if (from === true) return [narrowing(`${files} is reachable only through ${linkReach(to)}`)]
	return setChanges(files, from, to, 'becomes reachable through the share links of mount', 'is no longer reachable through the share links of mount')
}

/**
 * A new table's line. An application table names its reason and every action, because each one reaches every row of
 * it for a global holder.
 */
/** The actions besides the read action with which an `app` endpoint reads every row, or counts it only. */
function appReachClauses(table: TablePolicyArtifact): string {
	const { appRead = [], appCount = [] } = table.actions
	return [
		...(appRead.length === 0 ? [] : [`, read app-wide with ${listOf(appRead, '')}`]),
		...(appCount.length === 0 ? [] : [`, counted app-wide with ${listOf(appCount, '')}`]),
	].join('')
}

/** One operation's actions as the approver reads them: `` `a` `` or `` `a` or `b` ``. */
function actionsText(actions: TableActionArtifact): string {
	return tableActions(actions).map((action) => `\`${action}\``).join(' or ')
}

function newTableLine(name: string, table: TablePolicyArtifact): string {
	if (table.scope.mode !== 'app') return `New table policy \`${name}\` read with ${actionsText(table.actions.read)}${appReachClauses(table)}`
	const { read, insert, update, delete: remove } = table.actions
	const writes = [
		...(insert === null ? [] : [`inserted with ${actionsText(insert)}`]),
		...(update === null ? [] : [`updated with ${actionsText(update)}`]),
		...(remove === null ? [] : [`removed with ${actionsText(remove)}`]),
	]
	return `New application table \`${name}\` (${table.scope.reason}), read with ${actionsText(read)}${writes.map((write) => `, ${write}`).join('')}`
}

/**
 * One operation's actions: a single action replaced by another reads as the change it always was; otherwise each action
 * the operation gains widens and each it loses narrows.
 */
function operationChanges(table: string, operation: string, from: TableActionArtifact | null, to: TableActionArtifact | null): Line[] {
	if ((from === null || typeof from === 'string') && (to === null || typeof to === 'string')) {
		return valueChange(`${table} ${operation} action`, from, to)
	}
	const verb = operation === 'read' ? 'read' : operation === 'delete' ? 'removed' : `${operation}d`
	return setChanges(table, tableActions(from), tableActions(to), `is ${verb} with`, `is no longer ${verb} with`)
}

function tableChanges(name: string, from: TablePolicyArtifact, to: TablePolicyArtifact): RuledLine[] {
	const table = `Table \`${name}\``
	const columns: RuledLine[] = []
	for (const column of union(Object.keys(from.columns), Object.keys(to.columns))) {
		const subject = `Column \`${name}.${column}\``
		const before: ColumnPolicyArtifact = from.columns[column] ?? {}
		const after: ColumnPolicyArtifact = to.columns[column] ?? {}
		if (before.read === undefined && after.read !== undefined) {
			columns.push(...ruled('table.column-read', [narrowing(`${subject} is read with \`${after.read}\` instead of ${actionsText(from.actions.read)}`)]))
		} else if (before.read !== undefined && after.read === undefined) {
			// Without its own policy the column falls back to the table's read action (ADR-0050 §3).
			columns.push(
				...ruled('table.column-read', [widening(`${subject} loses its read policy \`${before.read}\` and is read with ${actionsText(to.actions.read)}`)]),
			)
		} else if (before.read !== undefined && after.read !== undefined) {
			columns.push(...ruled('table.column-read', valueChange(`${subject} read action`, before.read, after.read)))
		}
		// A column's own write action is one more action that updates the table; the update list's lines cover the rest.
		if (before.write === undefined && after.write !== undefined) {
			columns.push(...ruled('table.column-write', [widening(`${subject} is updated with its own write action \`${after.write}\``)]))
		} else if (before.write !== undefined && after.write === undefined) {
			columns.push(...ruled('table.column-write', [narrowing(`${subject} is no longer updated with its own write action \`${before.write}\``)]))
		} else if (before.write !== undefined && after.write !== undefined) {
			columns.push(...ruled('table.column-write', valueChange(`${subject} write action`, before.write, after.write)))
		}
	}
	return [
		...ruled('table.scope', valueChange(`${table} scope`, from.scope, to.scope)),
		...ruled('table.read', operationChanges(table, 'read', from.actions.read, to.actions.read)),
		...ruled('table.insert', operationChanges(table, 'insert', from.actions.insert, to.actions.insert)),
		...ruled('table.update', operationChanges(table, 'update', from.actions.update, to.actions.update)),
		...ruled('table.delete', operationChanges(table, 'delete', from.actions.delete, to.actions.delete)),
		// An appRead action reads every row app-wide and an appCount action counts it: each new one widens.
		...ruled(
			'table.app-read',
			setChanges(table, from.actions.appRead ?? [], to.actions.appRead ?? [], 'is read app-wide with', 'is no longer read app-wide with'),
		),
		...ruled(
			'table.app-count',
			setChanges(table, from.actions.appCount ?? [], to.actions.appCount ?? [], 'is counted app-wide with', 'is no longer counted app-wide with'),
		),
		...ruled('table.insert-columns', setChanges(table, from.insert, to.insert, 'accepts inserts of', 'no longer accepts inserts of')),
		...ruled('table.update-columns', setChanges(table, from.update, to.update, 'accepts updates of', 'no longer accepts updates of')),
		...ruled('table.version', valueChange(`${table} version column`, from.version, to.version)),
		...ruled('table.creator', valueChange(`${table} creator column`, from.createdBy, to.createdBy)),
		...columns,
		...ruled('table.file-column', fileColumnChanges(name, from.files ?? {}, to.files ?? {})),
	]
}

/** A column that starts or stops holding files, or holds another kind; who writes it is `fileColumnLines`'. */
function fileColumnChanges(name: string, from: Readonly<Record<string, string>>, to: Readonly<Record<string, string>>): Line[] {
	return union(Object.keys(from), Object.keys(to)).flatMap((column): Line[] => {
		const subject = `Column \`${name}.${column}\``
		const before = from[column]
		const after = to[column]
		if (before === undefined) return after === undefined ? [] : [neutral(`${subject} holds files of kind \`${after}\``)]
		if (after === undefined) return [neutral(`${subject} no longer holds files`)]
		return valueChange(`${subject} file kind`, before, after)
	})
}

// ── Generic comparisons ─────────────────────────────────────────────────────────────────────────

interface KeyedLines<T> {
	added(key: string, value: T): string | Line
	removed(key: string, value: T): string | readonly Line[]
	changed(key: string, before: T, after: T): readonly RuledLine[]
}

/**
 * A new key widens, a removed key narrows; a key in both is compared by `changed` unless the two are equal. Each line is
 * placed on the key as a subject of `kind`; an added or removed key's line is under `<kind>.added` or `<kind>.removed`.
 */
function compareKeyed<T>(
	changes: Changes,
	kind: ChangeSubjectKind,
	before: ReadonlyMap<string, T>,
	after: ReadonlyMap<string, T>,
	lines: KeyedLines<T>,
): void {
	for (const key of union([...before.keys()], [...after.keys()])) {
		const from = before.get(key)
		const to = after.get(key)
		const subject = subjectOf(kind, key)
		if (from === undefined && to !== undefined) {
			const added = lines.added(key, to)
			changes.add(subject, ...ruled(`${kind}.added`, [typeof added === 'string' ? widening(added) : added]))
		} else if (from !== undefined && to === undefined) {
			const removed = lines.removed(key, from)
			changes.add(subject, ...ruled(`${kind}.removed`, typeof removed === 'string' ? [narrowing(removed)] : removed))
		} else if (from !== undefined && to !== undefined && canonicalJson(from) !== canonicalJson(to)) {
			changes.add(subject, ...lines.changed(key, from, to))
		}
	}
}

/** The values one list gains and loses, in order. */
function setLines(
	before: readonly string[],
	after: readonly string[],
	lines: { added(value: string): Line; removed(value: string): Line },
): Line[] {
	return union(before, after).flatMap((value) => {
		if (!before.includes(value)) return [lines.added(value)]
		if (!after.includes(value)) return [lines.removed(value)]
		return []
	})
}

function setChanges(subject: string, before: readonly string[], after: readonly string[], gains: string, loses: string): Line[] {
	return setLines(before, after, {
		added: (value) => widening(`${subject} ${gains} \`${value}\``),
		removed: (value) => narrowing(`${subject} ${loses} \`${value}\``),
	})
}

/**
 * The words IAM shows a person signing in, setting a password or accepting an invitation of this application, and the
 * wording of its e-mails, which carry IAM's one-time links. They grant nothing, but the approver reads every change.
 */
function presentationChanges(baseline: ContractArtifact, candidate: ContractArtifact): RuledLine[] {
	const changes: RuledLine[] = []
	if (baseline.displayName !== candidate.displayName) {
		changes.push(...ruled('application.display-name', [
			widening(
				candidate.displayName === undefined
					? 'IAM no longer names the application on its sign-in, password and invitation pages and e-mails'
					: `IAM names the application ${shown(JSON.stringify(candidate.displayName))} on its sign-in, password and invitation pages and e-mails`,
			),
		]))
	}
	if (baseline.locale !== candidate.locale) {
		changes.push(
			...ruled('application.locale', [
				widening(`IAM speaks \`${candidate.locale ?? 'its default language'}\` on the application's sign-in, password and invitation pages and e-mails`),
			]),
		)
	}
	const changed = MESSAGE_KINDS.flatMap((kind) =>
		LOCALES.filter((locale) => canonicalJson(baseline.mail?.[kind]?.[locale] ?? null) !== canonicalJson(candidate.mail?.[kind]?.[locale] ?? null))
			.map((locale) => `\`${kind}\` in \`${locale}\``)
	)
	if (changed.length > 0) {
		changes.push(...ruled('application.mail', [widening(`The application's wording of IAM's e-mails changes: ${changed.join(', ')}`)]))
	}
	return changes
}

/**
 * The application's own people: who administers its global roles in IAM's console, who lists everyone holding one of
 * its roles, and whether that list shows labels, which spell users' addresses.
 */
function peopleChanges(baseline: ContractArtifact, candidate: ContractArtifact): RuledLine[] {
	const changes: RuledLine[] = []
	const before = baseline.members
	const after = candidate.members
	if (canonicalJson(before ?? null) !== canonicalJson(after ?? null)) {
		changes.push(
			...ruled('application.people', [
				after === undefined
					? narrowing('The application no longer declares its own people: only an IAM administrator grants its roles, and nobody lists them')
					: closer(
						'people',
						`Holders of \`${after.manage}\` grant and revoke the application's global roles in IAM's console, and holders of \`${after.list}\` list everyone holding one of its roles`,
					),
			]),
		)
	}
	if (baseline.directory !== candidate.directory) {
		changes.push(
			...ruled('application.directory', [
				candidate.directory === 'labels'
					? closer('people', "Holders of the application's members.list action see each person's label, which spells a user's email address")
					: narrowing("Holders of the application's members.list action no longer see labels"),
			]),
		)
	}
	return changes
}

function dimensionChanges(name: string, from: DimensionArtifact, to: DimensionArtifact): RuledLine[] {
	const { directory: before, ...fromRest } = from
	const { directory: after, ...toRest } = to
	return [...ruled('dimension.declaration', valueChange(`Dimension \`${name}\``, fromRest, toRest)), ...directoryChange(name, before, after)]
}

/**
 * A directory that shows labels lets every `members.list` holder read each member's label, which spells an address, and
 * every endpoint on, in or below the dimension read the label of a member it looks up (`ctx.members.get`).
 */
function directoryChange(name: string, before: 'labels' | undefined, after: 'labels' | undefined): RuledLine[] {
	if (before === after) return []
	return ruled('dimension.directory', [
		after === 'labels'
			? closer(
				'people',
				`Holders of the members.list action of \`${name}\` see each member's label, and every endpoint on, in or below \`${name}\` reads the label of a member it looks up; a label spells a user's email address`,
			)
			: narrowing(`Holders of the members.list action of \`${name}\` and the endpoints below \`${name}\` no longer see member labels`),
	])
}

/** The collections a new form puts an anonymous visitor's files into. */
function takenFiles(mount: MountArtifact): string {
	const files = mount.kind === 'form' ? Object.entries(mount.files ?? {}) : []
	return files.length === 0
		? ''
		: `, taking files from anyone: ${files.map(([field, file]) => `\`${field}\` into files \`${file.collection}\``).join(', ')}`
}

/** How a new webhook verifies a delivery, what one binding of it reaches, and how long its handler runs. */
function webhookPhrase(mount: MountArtifact): string {
	if (mount.kind !== 'webhook') return ''
	const bound = mount.boundTo.kind === 'app' ? 'once for the whole application' : `to one \`${mount.boundTo.dimension}\` each`
	return `, verified by ${schemeName(mount.scheme)}, its bindings ${bound}, running at most ${seconds(mount.timeoutMs)}`
}

function schemeName(scheme: WebhookScheme): string {
	if (typeof scheme === 'string') return `the \`${scheme}\` preset`
	if ('hmac' in scheme) return `an HMAC-${scheme.hmac.algorithm.toUpperCase()} in \`${scheme.hmac.header}\``
	return 'basic' in scheme ? "the binding's secret as a Basic password" : "the binding's secret as a bearer token"
}

/** The public variables a new mount hands its pages: an SPA's own list, a challenge's site key. */
function servedVariables(mount: MountArtifact): string {
	const names = servedNames(mount)
	return names.length === 0 ? '' : `, serving the public variable${names.length === 1 ? '' : 's'} ${listOf(names, 'none')} to every page`
}

/** The public variables a mount hands its pages: an SPA's own list, a challenge's site key. */
function servedNames(mount: MountArtifact): readonly string[] {
	return mount.kind === 'spa' ? (mount.public ?? []) : mount.kind === 'form' ? siteKeyOf(mount) : []
}

/**
 * A form's `then` reaches only a job of the same approved contract, which runs under its own declared actions and
 * coalesces on its lease, so a change of it alone widens nothing. An SPA's public variables and a form's site key
 * get a line each, by name. The rest of a mount is compared as a value.
 */
function mountChanges(name: string, from: MountArtifact, to: MountArtifact): RuledLine[] {
	const declaration = (before: unknown, after: unknown) => ruled('mount.declaration', valueChange(`Mount \`${name}\``, before, after))
	if (from.kind === 'rpc' && to.kind === 'rpc') {
		const { compatibility: before, ...fromRest } = from
		const { compatibility: after, ...toRest } = to
		return [...declaration(fromRest, toRest), ...ruled('mount.compatibility', compatibilityChange(name, before, after))]
	}
	if (from.kind === 'webhook' && to.kind === 'webhook') {
		const { timeoutMs: before, ...fromRest } = from
		const { timeoutMs: after, ...toRest } = to
		return [...declaration(fromRest, toRest), ...ruled('mount.time-limit', timeLimitChange(`Webhook \`${name}\``, before, after))]
	}
	if (from.kind === 'spa' && to.kind === 'spa') {
		const { public: before = [], ...fromRest } = from
		const { public: after = [], ...toRest } = to
		return [
			...declaration(fromRest, toRest),
			...ruled(
				'mount.public-variables',
				setChanges(`Mount \`${name}\``, before, after, 'serves its pages the public variable', 'no longer serves the public variable'),
			),
		]
	}
	if (from.kind !== 'form' || to.kind !== 'form') return declaration(from, to)
	const { then: before, files: filesBefore = {}, ...fromRest } = withoutSiteKey(from)
	const { then: after, files: filesAfter = {}, ...toRest } = withoutSiteKey(to)
	return [
		...declaration(fromRest, toRest),
		...ruled('mount.form-files', formFileChanges(name, filesBefore, filesAfter)),
		...ruled(
			'mount.public-variables',
			setChanges(
				`Form \`${name}\``,
				siteKeyOf(from),
				siteKeyOf(to),
				'serves every page its challenge site key from',
				'no longer serves its site key from',
			),
		),
		...ruled('mount.then', kickChange(name, before, after)),
	]
}

const siteKeyOf = (form: FormMountArtifact): readonly string[] => (form.challenge?.siteKey === undefined ? [] : [form.challenge.siteKey])

type FormFiles = NonNullable<FormMountArtifact['files']>

/**
 * A form's file field lets an anonymous visitor put a file into a collection, which its readers then open: a new or
 * moved field widens, a field a submission must now carry is shown, a removed one narrows.
 */
function formFileChanges(name: string, before: FormFiles, after: FormFiles): Line[] {
	const changes: Line[] = []
	for (const [field, file] of Object.entries(after)) {
		const was = before[field]
		if (was === undefined || was.collection !== file.collection) {
			changes.push(widening(`Form \`${name}\` takes a file \`${field}\` from anyone into files \`${file.collection}\``))
		} else if (was.required !== file.required) {
			// A required file refuses the submissions without one; no longer requiring it admits them.
			changes.push(
				file.required
					? narrowing(`Form \`${name}\` requires its file \`${field}\``)
					: widening(`Form \`${name}\` no longer requires its file \`${field}\``),
			)
		}
	}
	for (const [field, file] of Object.entries(before)) {
		if (after[field] === undefined) {
			changes.push(narrowing(`Form \`${name}\` no longer takes a file \`${field}\` into files \`${file.collection}\``))
		}
	}
	return changes
}

/** A form without its challenge's site key, which `mountChanges` shows on a line of its own. */
function withoutSiteKey(form: FormMountArtifact): FormMountArtifact {
	if (form.challenge === undefined) return form
	const { siteKey: _siteKey, ...challenge } = form.challenge
	return { ...form, challenge }
}

/**
 * Whether a line is one `kickChange` or `endpointKickChange` words: a job a form or a mutation starts, or no longer
 * starts. A run stored before lines carried an effect reads these as leaving access unchanged (`./publish`).
 */
export function isJobStartLine(line: string): boolean {
	return /^(Form|Endpoint) `[^`]+` (no longer )?starts job `/.test(line)
}

function kickChange(name: string, before: string | undefined, after: string | undefined): Line[] {
	if (before === after) return []
	return [
		after === undefined
			? neutral(`Form \`${name}\` no longer starts job \`${before}\` after a submission`)
			: startsJob(neutral(`Form \`${name}\` starts job \`${after}\` after each accepted submission, beside its schedule`), after),
	]
}

/** Any change of a value the diff does not order widens. */
/** A mount's promise to its callers reaches no data: it is shown, and Control enforces it at publication. */
function compatibilityChange(name: string, before: MountCompatibility | undefined, after: MountCompatibility | undefined): Line[] {
	if (before === after) return []
	return [
		neutral(
			after === 'backward'
				? `Mount \`${name}\` promises its callers backward compatibility: a deploy that breaks one of its procedures is refused`
				: `Mount \`${name}\` no longer promises backward compatibility; this deploy is the last one held to it`,
		),
	]
}

function valueChange(subject: string, before: unknown, after: unknown): Line[] {
	const from = canonicalJson(before)
	const to = canonicalJson(after)
	return from === to ? [] : [widening(`${subject} changes from ${shown(from)} to ${shown(to)}`)]
}

/** A larger or removed limit widens; a smaller one narrows. `null` is no limit. */
function limitChange(subject: string, before: number | null, after: number | null): Line[] {
	if (before === after) return []
	const larger = after === null || (before !== null && after > before)
	return [(larger ? widening : narrowing)(`${subject} changes from ${before ?? 'none'} to ${after ?? 'none'}`)]
}

const SHOWN_MAX = 120

function shown(json: string): string {
	return `\`${json.length > SHOWN_MAX ? `${json.slice(0, SHOWN_MAX)}…` : json}\``
}

function bytes(value: number | null): string {
	return value === null ? 'none' : `${value} bytes`
}

function listOf(values: readonly string[], none: string): string {
	return values.length === 0 ? none : values.map((value) => `\`${value}\``).join(', ')
}

function union(a: readonly string[], b: readonly string[]): string[] {
	return [...new Set([...a, ...b])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
}

function record<T>(value: Readonly<Record<string, T>>): Map<string, T> {
	return new Map(Object.entries(value))
}

function byName(migrations: AccessSnapshot['migrations']): Map<string, AccessSnapshot['migrations'][number]> {
	return new Map(migrations.map((migration) => [migration.name, migration]))
}

/** The baseline of a first contract; a staged-kit candidate is compared with sites that declare nothing. */
function emptyArtifact(candidate: ContractArtifact): ContractArtifact {
	return {
		format: candidate.format,
		app: candidate.app,
		dimensions: {},
		actions: {},
		roles: {},
		mounts: {},
		files: {},
		jobs: {},
		exports: {},
		imports: {},
		csp: { connectSrc: [], imgSrc: [], frameAncestors: [] },
		tables: {},
		endpoints: [],
		reservedPrefixes: [],
		...(candidate.declared === undefined ? {} : { declared: {} }),
	}
}
