/**
 * Relation-grant predicate shapes, measured on Postgres and SQLite.
 *
 * A list is scoped today by `t.team_id in (...)` (IAM grants). Relation grants add rows in an application table
 * `assignments(principal_id, project_id, kind, expires_at, revoked_at)`. This compares four ways to add that branch:
 *   A1  correlated `exists (select 1 from assignments a where ... a.project_id = t.project_id ...)`
 *   A2  uncorrelated `t.project_id in (select a.project_id from assignments a where ...)`
 *   B1  resolve the ids first, then `t.project_id in ($1, ..., $n)` (one parameter per id)
 *   B2  resolve the ids first, then `= any($1::uuid[])` (Postgres) or `in (select value from json_each(?1))` (SQLite)
 * B is timed as the sum of both statements. Each shape runs combined with the IAM branch and alone.
 *
 * Run it inside one CPU lease, with the Postgres container pinned to the leased CPUs:
 *
 *   cpu-lease run -n 4 --no-smt -- bash -c '
 *     CPUS=$(grep Cpus_allowed_list /proc/self/status | awk "{print \$2}")
 *     docker run -d --rm --name relation-bench-pg --cpuset-cpus=$CPUS --shm-size=512m -e POSTGRES_PASSWORD=postgres \
 *       -p 127.0.0.1::5432 postgres:18-alpine -c shared_buffers=256MB -c work_mem=16MB
 *     PORT=$(docker port relation-bench-pg 5432/tcp | head -1 | cut -d: -f2)
 *     BENCH_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:$PORT/postgres bun packages/db/bench/relation-predicates.ts
 *     docker stop relation-bench-pg'
 *
 * Without BENCH_POSTGRES_URL only SQLite runs (bun:sqlite, an in-memory database, default journal, no WAL).
 * BENCH_SCALE=0.05 shrinks the fixture for a smoke run; BENCH_RUNS sets the measured runs per cell (default 30);
 * BENCH_SECTIONS picks index variants (default `plain,covering,none`); BENCH_PLANS_FILE writes query plans there.
 */
import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'

const SCALE = Number(process.env['BENCH_SCALE'] ?? '1')
const RUNS = Number(process.env['BENCH_RUNS'] ?? '30')
const POSTGRES_URL = process.env['BENCH_POSTGRES_URL']
const PLANS_FILE = process.env['BENCH_PLANS_FILE']
const SECTIONS = (process.env['BENCH_SECTIONS'] ?? 'plain,covering,none').split(',')

const TEAMS = 200
const PROJECTS = Math.round(100_000 * SCALE)
const NOTES = Math.round(1_000_000 * SCALE)
const BACKGROUND_PRINCIPALS = Math.round(5_000 * SCALE)
const ROWS_PER_BACKGROUND_PRINCIPAL = 60
const FANOUTS = [10, 300, 3_000, 20_000].map(fanout => Math.min(fanout, Math.floor(PROJECTS / 4)))
const KINDS = ['treating', 'consulting', 'nursing', 'billing']
const IAM_TEAM_COUNT = 2
const PAGE = 50
const SQLITE_HOST_PARAMETER_CAP = 100
const YEAR_MS = 365 * 24 * 3600 * 1000
const NOTES_FROM = Date.UTC(2024, 0, 1)
const LAPSED_FROM = Date.UTC(2025, 0, 1)
const FUTURE_FROM = Date.UTC(2099, 0, 1)

// ---------------------------------------------------------------------------------------------------------------------
// Fixture

function mulberry32(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const hex = (value: number, width: number): string => Math.floor(value).toString(16).padStart(width, '0')

function randomHex(rnd: () => number, width: number): string {
	let out = ''
	while (out.length < width) out += hex(rnd() * 0x10000, 4)
	return out.slice(0, width)
}

function uuidV4(rnd: () => number): string {
	return `${randomHex(rnd, 8)}-${randomHex(rnd, 4)}-4${randomHex(rnd, 3)}-${hex(0x8000 + rnd() * 0x4000, 4)}-${randomHex(rnd, 12)}`
}

function uuidV7(ms: number, rnd: () => number): string {
	const time = hex(ms, 12)
	return `${time.slice(0, 8)}-${time.slice(8)}-7${randomHex(rnd, 3)}-${hex(0x8000 + rnd() * 0x4000, 4)}-${randomHex(rnd, 12)}`
}

const iso = (ms: number): string => new Date(Math.floor(ms)).toISOString()

type Assignment = { id: string; principal: string; project: number; kind: string; expiresAt: string | null; revokedAt: string | null }

type Subject = { fanout: number; principal: string; active: Set<number>; lapsed: number[] }

type Fixture = {
	teams: string[]
	projects: string[]
	projectTeam: Int32Array
	notes: string[]
	noteTeam: Int32Array
	noteProject: Int32Array
	noteCreatedAt: string[]
	noteBody: Int32Array
	bodies: string[]
	assignments: Assignment[]
	subjects: Subject[]
}

const WORDS = [
	'project',
	'reports',
	'mild',
	'pain',
	'after',
	'exercise',
	'follow',
	'up',
	'in',
	'two',
	'weeks',
	'blood',
	'pressure',
	'stable',
	'prescribed',
	'rest',
	'and',
	'fluids',
	'no',
	'fever',
	'observed',
	'today',
	'review',
	'results',
	'with',
	'family',
	'discussed',
	'plan',
	'sleep',
	'improved',
	'since',
	'last',
	'visit',
]

function shuffled(count: number, rnd: () => number, take: number): Int32Array {
	const order = new Int32Array(count)
	for (let i = 0; i < count; i++) order[i] = i
	for (let i = 0; i < take; i++) {
		const j = i + Math.floor(rnd() * (count - i))
		const swap = order[i] ?? 0
		order[i] = order[j] ?? 0
		order[j] = swap
	}
	return order.subarray(0, take)
}

function lapsedValidity(rnd: () => number, revoked: boolean): Pick<Assignment, 'expiresAt' | 'revokedAt'> {
	return revoked
		? { expiresAt: null, revokedAt: iso(LAPSED_FROM + rnd() * YEAR_MS) }
		: { expiresAt: iso(LAPSED_FROM + rnd() * YEAR_MS), revokedAt: null }
}

function activeValidity(rnd: () => number): Pick<Assignment, 'expiresAt' | 'revokedAt'> {
	return { expiresAt: rnd() < 0.5 ? null : iso(FUTURE_FROM + rnd() * YEAR_MS), revokedAt: null }
}

function generateFixture(): Fixture {
	const rnd = mulberry32(59)
	const pick = <T>(values: readonly T[]): T => {
		const value = values[Math.floor(rnd() * values.length)]
		if (value === undefined) throw new Error('pick from an empty list')
		return value
	}
	const teams = Array.from({ length: TEAMS }, () => uuidV7(NOTES_FROM - YEAR_MS + rnd() * YEAR_MS, rnd))
	const projects: string[] = []
	const projectTeam = new Int32Array(PROJECTS)
	for (let i = 0; i < PROJECTS; i++) {
		projects.push(uuidV7(NOTES_FROM - YEAR_MS + rnd() * YEAR_MS, rnd))
		projectTeam[i] = Math.floor(rnd() * TEAMS)
	}
	const bodies = Array.from({ length: 4096 }, () => {
		let body = ''
		while (body.length < 100) body += `${pick(WORDS)} `
		return body.slice(0, 100)
	})
	// A power-law rank decides how many notes a project has; the shuffle spreads the heavy ones over the teams.
	const heavyOrder = shuffled(PROJECTS, rnd, PROJECTS)
	const notes: string[] = []
	const noteTeam = new Int32Array(NOTES)
	const noteProject = new Int32Array(NOTES)
	const noteCreatedAt: string[] = []
	const noteBody = new Int32Array(NOTES)
	for (let i = 0; i < NOTES; i++) {
		const project = heavyOrder[Math.floor(PROJECTS * rnd() ** 2)] ?? 0
		const created = NOTES_FROM + rnd() * 2 * YEAR_MS
		notes.push(uuidV7(created, rnd))
		noteProject[i] = project
		noteTeam[i] = projectTeam[project] ?? 0
		noteCreatedAt.push(iso(created))
		noteBody[i] = Math.floor(rnd() * bodies.length)
	}
	const assignments: Assignment[] = []
	for (let p = 0; p < BACKGROUND_PRINCIPALS; p++) {
		const principal = uuidV4(rnd)
		for (let r = 0; r < ROWS_PER_BACKGROUND_PRINCIPAL; r++) {
			const roll = rnd()
			const validity = roll < 0.1 ? lapsedValidity(rnd, false) : roll < 0.15 ? lapsedValidity(rnd, true) : activeValidity(rnd)
			assignments.push({ id: uuidV4(rnd), principal, project: Math.floor(rnd() * PROJECTS), kind: pick(KINDS), ...validity })
		}
	}
	const subjects: Subject[] = []
	for (const fanout of FANOUTS) {
		const principal = uuidV4(rnd)
		const expired = Math.ceil(fanout * 0.1)
		const revoked = Math.ceil(fanout * 0.05)
		const order = shuffled(PROJECTS, rnd, fanout + expired + revoked)
		const active = new Set<number>()
		const lapsed: number[] = []
		order.forEach((project, index) => {
			const validity = index < fanout ? activeValidity(rnd) : lapsedValidity(rnd, index >= fanout + expired)
			if (index < fanout) active.add(project)
			else lapsed.push(project)
			assignments.push({ id: uuidV4(rnd), principal, project, kind: pick(KINDS), ...validity })
		})
		subjects.push({ fanout, principal, active, lapsed })
	}
	return { teams, projects, projectTeam, notes, noteTeam, noteProject, noteCreatedAt, noteBody, bodies, assignments, subjects }
}

// ---------------------------------------------------------------------------------------------------------------------
// Backends

type Dialect = 'postgres' | 'sqlite'

interface Backend {
	readonly dialect: Dialect
	readonly now: string
	placeholder(index: number, cast: string | null): string
	all(text: string, params: string[]): Promise<unknown[]>
	exec(text: string): Promise<void>
	plan(text: string, params: string[]): Promise<string>
	close(): Promise<void>
}

function field(row: unknown, key: string): unknown {
	if (typeof row !== 'object' || row === null) throw new Error(`row is not an object: ${String(row)}`)
	return Reflect.get(row, key)
}

function stringField(row: unknown, key: string): string {
	const value = field(row, key)
	if (typeof value !== 'string') throw new Error(`${key} is not a string`)
	return value
}

function numberField(row: unknown, key: string): number {
	const value = field(row, key)
	if (typeof value === 'number') return value
	if (typeof value === 'bigint' || typeof value === 'string') return Number(value)
	throw new Error(`${key} is not a number`)
}

const truncate = (line: string): string => (line.length > 220 ? `${line.slice(0, 220)}… (${line.length} chars)` : line)

function sqliteBackend(db: Database): Backend {
	const all = (text: string, params: string[]): unknown[] => {
		// Prepared per statement and finalized: no statement cache, so a B1 list pays its parse every time.
		const statement = db.prepare<unknown, string[]>(text)
		try {
			return statement.all(...params)
		} finally {
			statement.finalize()
		}
	}
	return {
		dialect: 'sqlite',
		now: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
		placeholder: index => `?${index}`,
		all: async (text, params) => all(text, params),
		exec: async text => {
			db.exec(text)
		},
		plan: async (text, params) => {
			const rows = all(`explain query plan ${text}`, params)
			const depth = new Map<number, number>([[0, -1]])
			return rows.map(row => {
				const level = (depth.get(numberField(row, 'parent')) ?? -1) + 1
				depth.set(numberField(row, 'id'), level)
				return truncate(`${'  '.repeat(level)}${stringField(row, 'detail')}`)
			}).join('\n')
		},
		close: async () => db.close(),
	}
}

function postgresBackend(sql: SQL): Backend {
	const all = (text: string, params: string[]): Promise<unknown[]> => sql.unsafe<unknown[]>(text, params)
	return {
		dialect: 'postgres',
		now: 'now()',
		placeholder: (index, cast) => (cast === null ? `$${index}` : `$${index}::${cast}`),
		all,
		exec: async text => {
			await sql.unsafe(text)
		},
		plan: async (text, params) => {
			try {
				const rows = await all(`explain (analyze, buffers) ${text}`, params)
				return rows.map(row => truncate(stringField(row, 'QUERY PLAN'))).join('\n')
			} catch (error) {
				if (error instanceof Error && error.message.includes('statement timeout')) return '(explain analyze cancelled by statement_timeout, 30 s)'
				throw error
			}
		},
		close: () => sql.close(),
	}
}

async function loadSqlite(f: Fixture): Promise<Backend> {
	const db = new Database(':memory:')
	db.exec(`
		create table projects (id text primary key, team_id text not null);
		create table notes (id text primary key, team_id text not null, project_id text not null, created_at text not null, body text not null);
		create table assignments (id text primary key, principal_id text not null, project_id text not null, kind text not null, expires_at text, revoked_at text);
	`)
	const insertProject = db.prepare<unknown, string[]>('insert into projects values (?1, ?2)')
	const insertNote = db.prepare<unknown, string[]>('insert into notes values (?1, ?2, ?3, ?4, ?5)')
	const insertAssignment = db.prepare<unknown, (string | null)[]>('insert into assignments values (?1, ?2, ?3, ?4, ?5, ?6)')
	db.transaction(() => {
		f.projects.forEach((id, i) => insertProject.run(id, teamOf(f, f.projectTeam[i])))
		f.notes.forEach((id, i) =>
			insertNote.run(id, teamOf(f, f.noteTeam[i]), projectOf(f, f.noteProject[i]), f.noteCreatedAt[i] ?? '', f.bodies[f.noteBody[i] ?? 0] ?? '')
		)
		for (const a of f.assignments) insertAssignment.run(a.id, a.principal, projectOf(f, a.project), a.kind, a.expiresAt, a.revokedAt)
	})()
	db.exec(`
		create index notes_project on notes (project_id, id);
		create index notes_team on notes (team_id, id);
		create index projects_team on projects (team_id);
	`)
	return sqliteBackend(db)
}

const teamOf = (f: Fixture, index: number | undefined): string => f.teams[index ?? -1] ?? fail('team index out of range')
const projectOf = (f: Fixture, index: number | undefined): string => f.projects[index ?? -1] ?? fail('project index out of range')

function fail(message: string): never {
	throw new Error(message)
}

const arrayLiteral = (values: readonly (string | null)[], quote: boolean): string =>
	`{${values.map(value => (value === null ? 'NULL' : quote ? `"${value}"` : value)).join(',')}}`

async function loadPostgres(url: string, f: Fixture): Promise<Backend> {
	const sql = new SQL({ url, max: 1, prepare: false })
	const deadline = Date.now() + 120_000
	for (;;) {
		try {
			await sql.unsafe('select 1')
			break
		} catch (error) {
			if (Date.now() > deadline) throw error
			await Bun.sleep(500)
		}
	}
	await sql.unsafe(`
		drop table if exists notes, projects, assignments;
		create table projects (id uuid not null, team_id uuid not null);
		create table notes (id uuid not null, team_id uuid not null, project_id uuid not null, created_at timestamptz not null, body text not null);
		create table assignments (id uuid not null, principal_id uuid not null, project_id uuid not null, kind text not null, expires_at timestamptz, revoked_at timestamptz);
	`)
	const batch = 50_000
	for (let start = 0; start < f.projects.length; start += batch) {
		const ids = f.projects.slice(start, start + batch)
		await sql.unsafe('insert into projects select * from unnest($1::uuid[], $2::uuid[])', [
			arrayLiteral(ids, false),
			arrayLiteral(ids.map((_, i) => teamOf(f, f.projectTeam[start + i])), false),
		])
	}
	for (let start = 0; start < f.notes.length; start += batch) {
		const ids = f.notes.slice(start, start + batch)
		await sql.unsafe('insert into notes select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::timestamptz[], $5::text[])', [
			arrayLiteral(ids, false),
			arrayLiteral(ids.map((_, i) => teamOf(f, f.noteTeam[start + i])), false),
			arrayLiteral(ids.map((_, i) => projectOf(f, f.noteProject[start + i])), false),
			arrayLiteral(f.noteCreatedAt.slice(start, start + batch), false),
			arrayLiteral(ids.map((_, i) => f.bodies[f.noteBody[start + i] ?? 0] ?? ''), true),
		])
	}
	for (let start = 0; start < f.assignments.length; start += batch) {
		const rows = f.assignments.slice(start, start + batch)
		await sql.unsafe(
			'insert into assignments select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[], $6::timestamptz[])',
			[
				arrayLiteral(rows.map(a => a.id), false),
				arrayLiteral(rows.map(a => a.principal), false),
				arrayLiteral(rows.map(a => projectOf(f, a.project)), false),
				arrayLiteral(rows.map(a => a.kind), false),
				arrayLiteral(rows.map(a => a.expiresAt), false),
				arrayLiteral(rows.map(a => a.revokedAt), false),
			],
		)
	}
	await sql.unsafe(`
		alter table projects add primary key (id);
		alter table notes add primary key (id);
		alter table assignments add primary key (id);
		create index notes_project on notes (project_id, id);
		create index notes_team on notes (team_id, id);
		create index projects_team on projects (team_id);
	`)
	await sql.unsafe('vacuum analyze')
	await sql.unsafe('set statement_timeout = 30000')
	return postgresBackend(sql)
}

type IndexVariant = 'plain' | 'covering' | 'none'

const INDEX_LABEL: Record<IndexVariant, Record<Dialect, string>> = {
	plain: { postgres: 'assignments (principal_id, project_id)', sqlite: 'assignments (principal_id, project_id)' },
	covering: {
		postgres: 'assignments (principal_id, project_id) include (revoked_at, expires_at)',
		sqlite: 'assignments (principal_id, project_id, revoked_at, expires_at)',
	},
	none: { postgres: 'no index on assignments (only its primary key)', sqlite: 'no index on assignments (only its primary key)' },
}

async function useIndex(b: Backend, variant: IndexVariant): Promise<void> {
	await b.exec('drop index if exists assignments_principal')
	if (variant === 'plain') await b.exec('create index assignments_principal on assignments (principal_id, project_id)')
	if (variant === 'covering') {
		await b.exec(
			b.dialect === 'postgres'
				? 'create index assignments_principal on assignments (principal_id, project_id) include (revoked_at, expires_at)'
				: 'create index assignments_principal on assignments (principal_id, project_id, revoked_at, expires_at)',
		)
	}
	await b.exec(b.dialect === 'postgres' ? 'vacuum analyze assignments' : 'analyze')
}

// ---------------------------------------------------------------------------------------------------------------------
// Shapes and operations

type Shape = 'IAM' | 'A1' | 'A2' | 'B1' | 'B2'
type Mode = 'iam+rel' | 'rel only'
type Case = { mode: Mode; fanout: number; principal: string; teams: string[] }
type Targets = { cursor: string; visible: string; hidden: string; count: number; firstPage: string[]; midPage: string[] }

const RELATION_SHAPES: Shape[] = ['A1', 'A2', 'B1', 'B2']
const OPS = ['list first', 'list mid', 'count', 'get visible', 'get hidden', 'update'] as const
type Op = (typeof OPS)[number]

class Params {
	readonly values: string[] = []
	constructor(private readonly backend: Backend) {}
	add(value: string, cast: string | null = null): string {
		this.values.push(value)
		return this.backend.placeholder(this.values.length, cast)
	}
}

const activeAssignment = (b: Backend): string => `a.revoked_at is null and (a.expires_at is null or a.expires_at > ${b.now})`

function resolveStatement(b: Backend, principal: string): { text: string; params: string[] } {
	const ps = new Params(b)
	return {
		text: `select a.project_id from assignments a where a.principal_id = ${ps.add(principal, 'uuid')} and ${activeAssignment(b)}`,
		params: ps.values,
	}
}

function scope(shape: Shape, b: Backend, ps: Params, c: Case, ids: string[]): string {
	const branches: string[] = []
	if (c.teams.length > 0) branches.push(`t.team_id in (${c.teams.map(team => ps.add(team, 'uuid')).join(', ')})`)
	const relation = (): string => {
		switch (shape) {
			case 'A1':
				return `exists (select 1 from assignments a where a.principal_id = ${ps.add(c.principal, 'uuid')} and a.project_id = t.project_id and ${
					activeAssignment(b)
				})`
			case 'A2':
				return `t.project_id in (select a.project_id from assignments a where a.principal_id = ${ps.add(c.principal, 'uuid')} and ${activeAssignment(b)})`
			case 'B1':
				return ids.length === 0 ? 'false' : `t.project_id in (${ids.map(id => ps.add(id, 'uuid')).join(', ')})`
			case 'B2':
				return b.dialect === 'postgres'
					? `t.project_id = any(${ps.add(arrayLiteral(ids, false), 'uuid[]')})`
					: `t.project_id in (select value from json_each(${ps.add(JSON.stringify(ids))}))`
			case 'IAM':
				return ''
		}
	}
	const branch = relation()
	if (branch !== '') branches.push(branch)
	return `(${branches.join(' or ')})`
}

function statement(op: Op, b: Backend, shape: Shape, c: Case, ids: string[], t: Targets): { text: string; params: string[] } {
	const ps = new Params(b)
	const columns = 't.id, t.project_id, t.created_at'
	switch (op) {
		case 'list first':
			return { text: `select ${columns} from notes t where ${scope(shape, b, ps, c, ids)} order by t.id limit ${PAGE}`, params: ps.values }
		case 'list mid': {
			const cursor = ps.add(t.cursor, 'uuid')
			return {
				text: `select ${columns} from notes t where t.id > ${cursor} and ${scope(shape, b, ps, c, ids)} order by t.id limit ${PAGE}`,
				params: ps.values,
			}
		}
		case 'count':
			return { text: `select count(*) as n from notes t where ${scope(shape, b, ps, c, ids)}`, params: ps.values }
		case 'get visible':
		case 'get hidden': {
			const id = ps.add(op === 'get visible' ? t.visible : t.hidden, 'uuid')
			return { text: `select ${columns}, t.body from notes t where t.id = ${id} and ${scope(shape, b, ps, c, ids)}`, params: ps.values }
		}
		case 'update': {
			const body = ps.add('updated body')
			const id = ps.add(t.visible, 'uuid')
			return { text: `update notes as t set body = ${body} where t.id = ${id} and ${scope(shape, b, ps, c, ids)}`, params: ps.values }
		}
	}
}

const resolves = (shape: Shape): boolean => shape === 'B1' || shape === 'B2'

/** Runs one operation the way the data layer would; returns the timed milliseconds (begin/rollback excluded) and rows. */
async function execute(b: Backend, shape: Shape, c: Case, op: Op, t: Targets): Promise<{ ms: number; rows: unknown[] }> {
	if (op === 'update') await b.exec('begin')
	try {
		const start = performance.now()
		let ids: string[] = []
		if (resolves(shape)) {
			const resolve = resolveStatement(b, c.principal)
			ids = (await b.all(resolve.text, resolve.params)).map(row => stringField(row, 'project_id'))
		}
		const s = statement(op, b, shape, c, ids, t)
		const rows = await b.all(s.text, s.params)
		return { ms: performance.now() - start, rows }
	} finally {
		if (op === 'update') await b.exec('rollback')
	}
}

async function explain(b: Backend, shape: Shape, c: Case, op: Op, t: Targets): Promise<string> {
	let ids: string[] = []
	if (resolves(shape)) {
		const resolve = resolveStatement(b, c.principal)
		ids = (await b.all(resolve.text, resolve.params)).map(row => stringField(row, 'project_id'))
	}
	const s = statement(op, b, shape, c, ids, t)
	if (op !== 'update' || b.dialect === 'sqlite') return b.plan(s.text, s.params)
	await b.exec('begin')
	try {
		return await b.plan(s.text, s.params)
	} finally {
		await b.exec('rollback')
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Ground truth and verification

const isActive = (a: Assignment, nowIso: string): boolean => a.revokedAt === null && (a.expiresAt === null || a.expiresAt > nowIso)

function targetsFor(f: Fixture, c: Case, subject: Subject): Targets {
	const nowIso = new Date().toISOString()
	const active = new Set<number>()
	for (const a of f.assignments) if (a.principal === c.principal && isActive(a, nowIso)) active.add(a.project)
	if (active.size !== subject.fanout) throw new Error(`fixture: ${active.size} active assignments, expected ${subject.fanout}`)
	const teams = new Set(c.teams.map(team => f.teams.indexOf(team)))
	const visible: string[] = []
	let relationOnly: string | null = null
	let hidden: string | null = null
	const lapsed = new Set(subject.lapsed)
	f.notes.forEach((id, i) => {
		const byRelation = active.has(f.noteProject[i] ?? -1)
		const byTeam = teams.has(f.noteTeam[i] ?? -1)
		if (byRelation || byTeam) visible.push(id)
		if (byRelation && !byTeam && relationOnly === null) relationOnly = id
		if (!byRelation && !byTeam && hidden === null && lapsed.has(f.noteProject[i] ?? -1)) hidden = id
	})
	visible.sort()
	const cursor = visible[Math.floor(visible.length / 2)] ?? fail('no visible notes')
	const midStart = Math.floor(visible.length / 2) + 1
	return {
		cursor,
		visible: relationOnly ?? fail('no note visible through a relation alone'),
		hidden: hidden ?? fail('no note behind a lapsed assignment'),
		count: visible.length,
		firstPage: visible.slice(0, PAGE),
		midPage: visible.slice(midStart, midStart + PAGE),
	}
}

async function verify(b: Backend, shape: Shape, c: Case, t: Targets): Promise<void> {
	const ids = async (op: Op): Promise<string> => (await execute(b, shape, c, op, t)).rows.map(row => stringField(row, 'id')).join(',')
	const count = numberField((await execute(b, shape, c, 'count', t)).rows[0], 'n')
	const checks: [string, boolean][] = [
		['count', count === t.count],
		['list first', (await ids('list first')) === t.firstPage.join(',')],
		['list mid', (await ids('list mid')) === t.midPage.join(',')],
		['get visible', (await ids('get visible')) === t.visible],
		['get hidden', (await ids('get hidden')) === ''],
	]
	for (const [name, ok] of checks) if (!ok) throw new Error(`${b.dialect} ${shape} ${c.mode} fan-out ${c.fanout}: ${name} disagrees with the fixture`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Measurement and output

type Stat = { median: number; p95: number; n: number }

async function measure(run: () => Promise<number>): Promise<Stat> {
	const first = await run()
	const n = first > 5_000 ? 3 : first > 1_000 ? 5 : RUNS
	if (n === RUNS) {
		await run()
		await run()
	}
	const samples: number[] = []
	for (let i = 0; i < n; i++) samples.push(await run())
	samples.sort((x, y) => x - y)
	const mid = Math.floor(n / 2)
	const median = n % 2 === 1 ? (samples[mid] ?? 0) : ((samples[mid - 1] ?? 0) + (samples[mid] ?? 0)) / 2
	return { median, p95: samples[Math.ceil(0.95 * n) - 1] ?? 0, n }
}

const ms = (value: number): string => (value < 1 ? value.toFixed(3) : value < 100 ? value.toFixed(2) : value.toFixed(1))
const cell = (s: Stat): string => `${ms(s.median)} / ${ms(s.p95)}${s.n === RUNS ? '' : ` (n=${s.n})`}`

/** A cell whose statement the database cancelled (Postgres' statement_timeout) reports that instead of a time. */
async function guarded(run: () => Promise<Stat>): Promise<string> {
	try {
		return cell(await run())
	} catch (error) {
		if (error instanceof Error && error.message.includes('statement timeout')) return 'timeout (> 30 s)'
		throw error
	}
}

/**
 * SQLite has no statement timeout, so a plan that rescans assignments in full for every notes row it visits is not run:
 * EXPLAIN QUERY PLAN shows a correlated subquery with `SCAN a` and no point lookup of t by id. Answers the cell, or null.
 */
async function nestedFullScan(b: Backend, shape: Shape, c: Case, op: Op, t: Targets): Promise<string | null> {
	if (b.dialect !== 'sqlite' || op === 'update') return null
	const lines = (await explain(b, shape, c, op, t)).split('\n').map(line => line.trim())
	const outerScan = !lines.some(line => line.startsWith('SEARCH t ') && line.endsWith('(id=?)'))
	const innerScan = lines.some(line => line === 'SCAN a')
	const correlated = lines.some(line => line.includes('CORRELATED'))
	return outerScan && innerScan && correlated ? 'not run ‡' : null
}

const out = (line = ''): void => console.log(line)
const plans: string[] = []

type SectionPlan = { variant: IndexVariant; fanouts: number[]; shapes: Shape[]; planFanouts: number[]; planOps: Op[] }

const SECTION_PLANS: Record<IndexVariant, SectionPlan> = {
	plain: {
		variant: 'plain',
		fanouts: FANOUTS,
		shapes: RELATION_SHAPES,
		planFanouts: [FANOUTS[1] ?? 0, FANOUTS[3] ?? 0],
		planOps: ['list first', 'count', 'get hidden', 'update'],
	},
	covering: {
		variant: 'covering',
		fanouts: [FANOUTS[2] ?? 0, FANOUTS[3] ?? 0],
		shapes: RELATION_SHAPES,
		planFanouts: [FANOUTS[3] ?? 0],
		planOps: ['list first', 'count'],
	},
	none: {
		variant: 'none',
		fanouts: [FANOUTS[1] ?? 0, FANOUTS[3] ?? 0],
		shapes: RELATION_SHAPES,
		planFanouts: [FANOUTS[3] ?? 0],
		planOps: ['list first', 'count', 'get hidden'],
	},
}

async function runBackend(b: Backend, f: Fixture): Promise<void> {
	const iamTeams = f.teams.slice(0, IAM_TEAM_COUNT)
	const cases: { c: Case; t: Targets }[] = []
	for (const subject of f.subjects) {
		for (const mode of ['iam+rel', 'rel only'] satisfies Mode[]) {
			const c: Case = { mode, fanout: subject.fanout, principal: subject.principal, teams: mode === 'iam+rel' ? iamTeams : [] }
			cases.push({ c, t: targetsFor(f, c, subject) })
		}
	}
	const iamCase = cases.find(({ c }) => c.mode === 'iam+rel') ?? fail('no case')
	const iamOnly: Case = { ...iamCase.c, mode: 'iam+rel' }

	out(`\n## ${b.dialect}\n`)
	out('Visible notes per case: ' + cases.map(({ c, t }) => `${c.mode} ${c.fanout} → ${t.count}`).join(', '))

	for (const section of SECTIONS) {
		if (section !== 'plain' && section !== 'covering' && section !== 'none') throw new Error(`unknown section ${section}`)
		const sp = SECTION_PLANS[section]
		await useIndex(b, sp.variant)
		// An index changes no answer, so the shapes are checked against the fixture once, under the plain index.
		for (const { c, t } of sp.variant === 'plain' ? cases : []) {
			if (!sp.fanouts.includes(c.fanout)) continue
			for (const shape of sp.shapes) await verify(b, shape, c, t)
		}
		out(`\n### ${b.dialect}: ${INDEX_LABEL[sp.variant][b.dialect]}\n`)
		out(
			'median / p95 ms; B = resolve + statement'
				+ (b.dialect === 'sqlite'
					? `; † = more than ${SQLITE_HOST_PARAMETER_CAP} bound parameters (refused by D1/workerd); ‡ = not run: its plan rescans all of assignments for every notes row`
					: ''),
		)
		out()
		out(`| fan-out | mode | shape | ${OPS.join(' | ')} |`)
		out(`|---|---|---|${OPS.map(() => '---').join('|')}|`)
		if (sp.variant === 'plain') {
			const row: string[] = []
			for (const op of OPS) row.push(cell(await measure(async () => (await execute(b, 'IAM', iamOnly, op, iamCase.t)).ms)))
			out(`| – | iam only | IAM | ${row.join(' | ')} |`)
		}
		const resolveRows: string[] = []
		for (const subject of f.subjects) {
			if (!sp.fanouts.includes(subject.fanout)) continue
			const resolve = resolveStatement(b, subject.principal)
			const stat = await guarded(() =>
				measure(async () => {
					const start = performance.now()
					await b.all(resolve.text, resolve.params)
					return performance.now() - start
				})
			)
			resolveRows.push(`| ${subject.fanout} | ${stat} |`)
			for (const { c, t } of cases) {
				if (c.principal !== subject.principal) continue
				for (const shape of sp.shapes) {
					const row: string[] = []
					for (const op of OPS) {
						const refusal = await nestedFullScan(b, shape, c, op, t)
						row.push(refusal ?? (await guarded(() => measure(async () => (await execute(b, shape, c, op, t)).ms))))
					}
					const overCap = b.dialect === 'sqlite' && shape === 'B1' && c.fanout + c.teams.length + 2 > SQLITE_HOST_PARAMETER_CAP ? ' †' : ''
					out(`| ${c.fanout} | ${c.mode} | ${shape}${overCap} | ${row.join(' | ')} |`)
				}
			}
		}
		out(`\nResolve query alone (\`select project_id from assignments where principal_id = … and <active>\`):\n`)
		out('| fan-out | median / p95 ms |')
		out('|---|---|')
		for (const row of resolveRows) out(row)

		for (const { c, t } of cases) {
			if (!sp.planFanouts.includes(c.fanout)) continue
			for (const shape of sp.shapes) {
				for (const op of sp.planOps) {
					if ((await nestedFullScan(b, shape, c, op, t)) !== null) continue
					plans.push(
						`--- ${b.dialect} | ${INDEX_LABEL[sp.variant][b.dialect]} | fan-out ${c.fanout} | ${c.mode} | ${shape} | ${op}\n${await explain(
							b,
							shape,
							c,
							op,
							t,
						)}\n`,
					)
				}
			}
		}
		if (sp.variant === 'plain') {
			for (const op of ['list first', 'count'] satisfies Op[]) {
				plans.push(
					`--- ${b.dialect} | ${INDEX_LABEL[sp.variant][b.dialect]} | iam only | IAM | ${op}\n${await explain(b, 'IAM', iamOnly, op, iamCase.t)}\n`,
				)
			}
		}
	}
}

function cpusAllowed(): string {
	const line = readFileSync('/proc/self/status', 'utf8').split('\n').find(l => l.startsWith('Cpus_allowed_list'))
	return line?.split(/\s+/)[1] ?? 'unknown'
}

async function main(): Promise<void> {
	const started = performance.now()
	const f = generateFixture()
	const active = f.assignments.filter(a => isActive(a, new Date().toISOString())).length
	out('# Relation-grant predicate shapes\n')
	out(`Bun ${Bun.version}; CPUs allowed: ${cpusAllowed()}; runs per cell: ${RUNS} (5 when a run exceeds 1 s, 3 above 5 s), after 2 warm-up runs`)
	out(
		`Fixture: ${TEAMS} teams, ${f.projects.length} projects, ${f.notes.length} notes, ${f.assignments.length} assignments (${active} active), fan-outs ${
			FANOUTS.join(', ')
		}, IAM grant on ${IAM_TEAM_COUNT} teams; generated in ${ms(performance.now() - started)} ms`,
	)

	const sqliteStart = performance.now()
	const sqlite = await loadSqlite(f)
	const version = await sqlite.all('select sqlite_version() as v', [])
	out(`SQLite ${stringField(version[0], 'v')} (bun:sqlite, in-memory, journal_mode=memory); loaded in ${ms(performance.now() - sqliteStart)} ms`)
	await runBackend(sqlite, f)
	await sqlite.close()

	if (POSTGRES_URL === undefined) {
		out('\nPostgres skipped: set BENCH_POSTGRES_URL to run it.')
	} else {
		const pgStart = performance.now()
		const pg = await loadPostgres(POSTGRES_URL, f)
		const settings = await pg.all(
			`select version() as v, current_setting('shared_buffers') as sb, current_setting('work_mem') as wm, current_setting('max_parallel_workers_per_gather') as par, current_setting('jit') as jit`,
			[],
		)
		const s = settings[0]
		out(
			`\n${stringField(s, 'v')}; shared_buffers=${stringField(s, 'sb')}, work_mem=${stringField(s, 'wm')}, max_parallel_workers_per_gather=${
				stringField(s, 'par')
			}, jit=${stringField(s, 'jit')}; Bun.SQL prepare: false; loaded in ${ms(performance.now() - pgStart)} ms`,
		)
		await runBackend(pg, f)
		await pg.close()
	}

	const planText = `# Query plans\n\n${plans.join('\n')}`
	if (PLANS_FILE === undefined) out(`\n${planText}`)
	else writeFileSync(PLANS_FILE, planText)
	out(`\nTotal ${ms((performance.now() - started) / 1000)} s`)
}

await main()
