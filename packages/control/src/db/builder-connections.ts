import { type BuilderConnectionReceiptDto, parseBuilderConnectionReceipt } from '@fabrika/control-contract'
import type { SqlDatabase } from '@fabrika/platform'

interface ReceiptRow {
	attempt_id: string
	app_id: string
	creator_id: string
	request_key: string
	receipt_json: string
}

export interface StoredBuilderConnectionReceipt {
	readonly creatorId: string
	readonly receipt: BuilderConnectionReceiptDto
	readonly requestKey: string
}

export class BuilderConnectionRepository {
	constructor(private readonly db: SqlDatabase, private readonly now: () => number) {}

	async get(attemptId: string): Promise<BuilderConnectionReceiptDto | null> {
		return (await this.find(attemptId))?.receipt ?? null
	}

	async find(attemptId: string): Promise<StoredBuilderConnectionReceipt | null> {
		const row = await this.db.prepare(
			'SELECT attempt_id, app_id, creator_id, request_key, receipt_json FROM builder_connection_receipts WHERE attempt_id = ?',
		)
			.bind(attemptId).first<ReceiptRow>()
		if (row === null) return null
		const value: unknown = JSON.parse(row.receipt_json)
		const receipt = parseBuilderConnectionReceipt(value)
		if (receipt.attemptId !== row.attempt_id || receipt.app.id !== row.app_id) throw new Error('builder receipt coordinate mismatch')
		return { receipt, requestKey: row.request_key, creatorId: row.creator_id }
	}

	/** The primary key arbitrates concurrent writers; the winning snapshot is never updated. */
	async create(input: Omit<BuilderConnectionReceiptDto, 'createdAt'>, requestKey: string, creatorId: string): Promise<StoredBuilderConnectionReceipt> {
		const receipt = parseBuilderConnectionReceipt({ ...input, createdAt: this.now() })
		await this.db.prepare(
			'INSERT INTO builder_connection_receipts (attempt_id, app_id, creator_id, request_key, receipt_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT (attempt_id) DO NOTHING',
		)
			.bind(receipt.attemptId, receipt.app.id, creatorId, requestKey, JSON.stringify(receipt)).run()
		const stored = await this.find(receipt.attemptId)
		if (stored === null) throw new Error('builder receipt disappeared after insert')
		return stored
	}
}
