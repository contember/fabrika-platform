// A fake of every environment's application objects as Control sees them over the ops channel: a published state per
// object judged by the wire's own rule, a database that dumps into a few parts, a `rehearsal` target that imports like
// the object's importer, and a migration ledger the `migrate` request extends. Its answers are the wire's shapes, so
// Control's records of them parse again.

import {
	OPS_DUMP_PART_SIZE,
	OPS_EMPTY_TABLE_HASH,
	type OpsDataRefusalReason,
	type OpsDumpCursor,
	type OpsDumpTable,
	type OpsExportRequest,
	type OpsImportRequest,
	type OpsInspectRequest,
	type OpsMigrateAck,
	type OpsMigrateRequest,
	type OpsMigration,
	type OpsPublishedState,
	type OpsStateAck,
	type OpsStateRequest,
	opsTransitionRefused,
	type OpsUploadedPart,
	parseOpsDumpManifest,
	sha256Hex,
} from '@fabrika/auth-core'
import { expect } from 'bun:test'
import type {
	OpsAnswer,
	OpsDataAnswer,
	OpsExportAck,
	OpsFencedAnswer,
	OpsImportAck,
	OpsInspection,
	OpsTarget,
	OpsTransport,
} from '../../data-operations'

/** The environment `requests()` lists by default, and the framework release every fake object runs. */
export const FAKE_ENV = 'prod'
export const GATED = '0.9.0'
const ENV = FAKE_ENV
const BOOT_FAILED_AT = '2027-01-15T08:00:00.000Z'

const digest = (text: string): string => sha256Hex(text)

export type Sent =
	| { readonly op: 'inspect'; readonly env: string }
	| { readonly op: 'state'; readonly env: string; readonly object: string; readonly generation: number; readonly mode: string }
	| { readonly op: 'export'; readonly env: string; readonly step: string; readonly generation: number | null; readonly part?: number }
	| { readonly op: 'import'; readonly env: string; readonly step: string; readonly generation: number; readonly part?: number }
	| { readonly op: 'migrate'; readonly env: string; readonly generation: number }

/** What the fake does with one request: answer it, apply it and lose the answer, never receive it, or refuse it. */
export type Fault = 'down' | 'lose' | 'not_served' | { readonly refused: OpsDataRefusalReason; readonly table?: string }

/** An import target's KV marker: the backup it loads and the parts it holds. */
interface Marker {
	readonly dump: string
	readonly loaded: Set<number>
}

/**
 * Every environment's objects as Control sees them: a published state per object judged by the wire's own rule, a
 * database that dumps into `parts` parts, and a `rehearsal` target that imports like the object's importer. Its answers
 * are the wire's shapes, so Control's records of them parse again.
 */
export class FakeEnvironments implements OpsTransport {
	readonly published = new Map<string, OpsPublishedState>()
	readonly sent: Sent[] = []
	fault: (sent: Sent) => Fault | undefined | Promise<Fault | undefined> = () => undefined
	parts = 3
	/** The parts whose rows have a deferred foreign key, which the link pass sets. */
	deferred = new Set([2])
	/** Export `begin`s answered: each starts another upload. */
	begins = 0
	upload: string | null = null
	/** The generation each dump's `begin` ran at: as the exporter, a later step under another generation is refused. */
	readonly dumps = new Map<string, number>()
	rehearsal: { marker: Marker | null; tables: boolean } = { marker: null, tables: false }
	/** The application object's migration ledger, which `inspect` reports and `migrate` extends. */
	ledger: OpsMigration[] = []
	/** The application migrations the deployed release bundles: `migrate` applies the ones the ledger lacks. */
	bundled: string[] = []
	/** Whether the application fails to boot: `migrate` then answers the 500 a failed boot is, which reads as unreachable. */
	bootFails = false

	async inspect(target: OpsTarget, request: OpsInspectRequest): Promise<OpsAnswer<OpsInspection>> {
		const sent: Sent = { op: 'inspect', env: target.env }
		this.sent.push(sent)
		if ((await this.fault(sent)) === 'down') return { kind: 'unavailable', reason: 'unreachable' }
		const published = this.published.get(key(target, request.object))
		return {
			kind: 'ok',
			value: {
				content: false,
				view: {
					release: GATED,
					maintenance: published === undefined ? { mode: 'open', generation: null, published: false } : { ...published, published: true },
					database: { sizeBytes: 4096, tables: [] },
					migrations: this.ledger,
					scheduler: { alarm: null },
					jobs: [],
					files: [],
					webhooks: [],
					bootFailure: this.bootFails ? { at: BOOT_FAILED_AT } : null,
				},
			},
		}
	}

	async state(target: OpsTarget, request: OpsStateRequest): Promise<OpsFencedAnswer<OpsStateAck>> {
		const sent: Sent = { op: 'state', env: target.env, object: request.object, generation: request.generation, mode: request.mode }
		this.sent.push(sent)
		const fault = await this.fault(sent)
		if (fault === 'down') return { kind: 'unavailable', reason: 'unreachable' }
		if (fault === 'not_served') return { kind: 'unavailable', reason: 'not_served' }
		const current = this.published.get(key(target, request.object)) ?? null
		if (opsTransitionRefused(current, request)) return { kind: 'stale', published: current }
		this.published.set(key(target, request.object), { generation: request.generation, mode: request.mode })
		if (fault === 'lose') return { kind: 'unavailable', reason: 'unreachable' }
		return { kind: 'ok', value: { generation: request.generation, mode: request.mode, stillRunning: 0 } }
	}

	/** Applies the bundled migrations the ledger lacks, only under the published generation. */
	async migrate(target: OpsTarget, request: OpsMigrateRequest): Promise<OpsFencedAnswer<OpsMigrateAck>> {
		const sent: Sent = { op: 'migrate', env: target.env, generation: request.generation }
		this.sent.push(sent)
		const fault = await this.fault(sent)
		if (fault === 'down' || this.bootFails) return { kind: 'unavailable', reason: 'unreachable' }
		if (fault === 'not_served') return { kind: 'unavailable', reason: 'not_served' }
		const published = this.published.get(key(target, request.object)) ?? null
		if (published === null || published.generation !== request.generation) return { kind: 'stale', published }
		const applied = new Set(this.ledger.map((row) => row.name))
		for (const name of this.bundled) {
			if (!applied.has(name)) this.ledger.push({ bundle: 'app', name, checksum: digest(name), appliedAt: BOOT_FAILED_AT })
		}
		if (fault === 'lose') return { kind: 'unavailable', reason: 'unreachable' }
		return { kind: 'ok', value: { generation: request.generation, migrations: [...this.ledger] } }
	}

	async export(target: OpsTarget, request: OpsExportRequest): Promise<OpsDataAnswer<OpsExportAck>> {
		const sent: Sent = {
			op: 'export',
			env: target.env,
			step: request.step,
			generation: request.generation,
			...(request.step === 'part' ? { part: request.part } : {}),
		}
		this.sent.push(sent)
		const fault = await this.fault(sent)
		if (fault === 'down') return { kind: 'unavailable', reason: 'unreachable' }
		if (fault === 'not_served') return { kind: 'unavailable', reason: 'not_served' }
		if (typeof fault === 'object') return { kind: 'refused', refusal: { refused: fault.refused, table: fault.table ?? null } }
		const published = this.published.get(key(target, request.object)) ?? null
		if (published === null || published.generation !== request.generation) return { kind: 'stale', published }
		if (published.mode === 'open') return { kind: 'refused', refusal: { refused: 'wrong_mode', table: null } }
		if (request.step !== 'begin' && this.dumps.get(request.dump) !== request.generation) {
			return { kind: 'refused', refusal: { refused: 'ledger_mismatch', table: null } }
		}
		const answer = this.exportAnswer(request)
		return fault === 'lose' ? { kind: 'unavailable', reason: 'unreachable' } : answer
	}

	private exportAnswer(request: OpsExportRequest): OpsDataAnswer<OpsExportAck> {
		switch (request.step) {
			case 'begin':
				if (request.generation !== null) this.dumps.set(request.dump, request.generation)
				this.begins++
				this.upload = `upload-${this.begins}`
				return { kind: 'ok', value: { step: 'begin', uploadId: this.upload, bookmark: 'bookmark-0001' } }
			case 'part': {
				if (request.uploadId !== this.upload) return { kind: 'unavailable', reason: 'unreachable' }
				expect(request.cursor).toEqual(request.part === 1 ? null : cursorAt(request.part))
				const next = request.part < this.parts ? cursorAt(request.part + 1) : null
				return { kind: 'ok', value: { step: 'part', uploaded: uploadedPart(request.part, this.parts), tables: [table(request.part)], next } }
			}
			case 'complete': {
				if (request.uploadId !== this.upload) return { kind: 'unavailable', reason: 'unreachable' }
				const parts = Array.from({ length: this.parts }, (_, index) => uploadedPart(index + 1, this.parts))
				expect(request.parts).toEqual(parts)
				expect(request.tables).toEqual(parts.map((part) => table(part.part)))
				const manifest = parseOpsDumpManifest({
					format: 1,
					dump: request.dump,
					object: request.object,
					consistent: request.consistent,
					createdAt: '2027-01-15T08:00:00.000Z',
					bookmark: request.bookmark,
					release: GATED,
					contractDigest: `sha256:${digest('contract')}`,
					ddl: request.tables.map((dumped) => ({ type: 'table', name: dumped.name, table: dumped.name, sql: `CREATE TABLE ${dumped.name} (id)` })),
					migrations: [],
					tables: request.tables,
					parts: request.parts.map(({ part, size, sha256 }) => ({ part, size, sha256 })),
				})
				if (manifest === null) throw new Error('the fake wrote a manifest the wire refuses')
				return { kind: 'ok', value: { step: 'complete', manifest } }
			}
		}
	}

	async import(target: OpsTarget, request: OpsImportRequest): Promise<OpsDataAnswer<OpsImportAck>> {
		const sent: Sent = {
			op: 'import',
			env: target.env,
			step: request.step,
			generation: request.generation,
			...(request.step === 'part' || request.step === 'link' ? { part: request.part } : {}),
		}
		this.sent.push(sent)
		const fault = await this.fault(sent)
		if (fault === 'down') return { kind: 'unavailable', reason: 'unreachable' }
		if (typeof fault === 'object') return { kind: 'refused', refusal: { refused: fault.refused, table: fault.table ?? null } }
		const published = this.published.get(key(target, request.object)) ?? null
		if (published === null || published.generation !== request.generation) return { kind: 'stale', published }
		if (published.mode !== 'inspect') return refusal('wrong_mode')
		const answer = this.importAnswer(request)
		return fault === 'lose' ? { kind: 'unavailable', reason: 'unreachable' } : answer
	}

	private importAnswer(request: OpsImportRequest): OpsDataAnswer<OpsImportAck> {
		const target = this.rehearsal
		if (request.step === 'discard') {
			if (target.marker === null) return refusal('no_import')
			this.rehearsal = { marker: null, tables: false }
			return { kind: 'ok', value: { step: 'discard' } }
		}
		if (request.step === 'begin') {
			if ((target.marker !== null && target.marker.dump !== request.source.dump) || (target.marker === null && target.tables)) {
				return refusal('not_fresh')
			}
			this.rehearsal = { marker: target.marker ?? { dump: request.source.dump, loaded: new Set() }, tables: true }
			return { kind: 'ok', value: { step: 'begin', parts: this.parts } }
		}
		const marker = target.marker
		if (marker === null || marker.dump !== request.source.dump) return refusal('no_import')
		switch (request.step) {
			case 'part':
				marker.loaded.add(request.part)
				return { kind: 'ok', value: { step: 'part', part: request.part, rows: 3, deferred: this.deferred.has(request.part) ? 2 : 0 } }
			case 'link':
				if (marker.loaded.size !== this.parts) return refusal('part_mismatch')
				return { kind: 'ok', value: { step: 'link', part: request.part, rows: 2 } }
			case 'verify': {
				// Two steps: every table but the last, then the last.
				if (request.cursor === null && this.parts > 1) {
					const verified = Array.from({ length: this.parts - 1 }, (_, index) => table(index + 1))
					return { kind: 'ok', value: { step: 'verify', tables: verified, next: { ...cursorAt(this.parts), after: '7', rows: 1, hash: digest('x') } } }
				}
				return { kind: 'ok', value: { step: 'verify', tables: [table(this.parts)], next: null } }
			}
			case 'complete':
				throw new Error('a rehearsal never completes the import: complete clears the marker discard needs')
		}
	}

	requests(env = ENV): string[] {
		return this.sent.flatMap((sent) => {
			if (sent.env !== env) return []
			if (sent.op === 'inspect') return ['inspect']
			if (sent.op === 'state') return [`state ${sent.object} ${sent.mode} @${sent.generation}`]
			if (sent.op === 'migrate') return [`migrate @${sent.generation}`]
			const part = sent.part === undefined ? '' : ` ${sent.part}`
			return [`${sent.op} ${sent.step}${part} @${sent.generation}`]
		})
	}
}

export function key(target: OpsTarget, object: string): string {
	return `${target.appId}/${target.env}/${object}`
}

function refusal(refused: OpsDataRefusalReason): OpsDataAnswer<never> {
	return { kind: 'refused', refusal: { refused, table: null } }
}

export function table(part: number): OpsDumpTable {
	return { name: `t${part}`, rows: 3, hash: digest(`t${part}`) }
}

export function cursorAt(part: number): OpsDumpCursor {
	return { table: `t${part}`, after: null, rows: 0, hash: OPS_EMPTY_TABLE_HASH }
}

function uploadedPart(part: number, parts: number): OpsUploadedPart {
	return { part, size: part < parts ? OPS_DUMP_PART_SIZE : 4096, sha256: digest(`part ${part}`), etag: `etag-${part}` }
}
