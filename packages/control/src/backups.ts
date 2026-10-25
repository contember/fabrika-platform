// The daily backup of every Cloudflare environment (ADR-0070 §8) and the backup list `data.read` shows. Control's `*/5`
// maintenance pass first carries on the backups still running, then starts one for each environment that is due; the
// `backup` operation itself is driven in `data-operations.ts`.

import type { DataBackupDto, DataBackupScheduleDto } from '@fabrika/control-contract'
import type { ControlProvider } from '@fabrika/provider-contract'
import { approvedProviderAccess } from './approval/snapshot'
import { advanceDataOperation, type DataOperationDeps, type DataOperationOutcome, startBackup } from './data-operations'
import type { AppEnvRow, BackupRow, BackupScheduleRow, ControlRepositories } from './db'

/** A backup counts for a day: an environment with a succeeded one younger than this is not due. */
export const BACKUP_INTERVAL_S = 24 * 60 * 60
/** A backup that failed is tried again no sooner than this after it ended, so a failing one never loops. */
export const BACKUP_RETRY_S = 60 * 60
/** A dump is kept 30 days (ADR-0070 §5); an older one is expired and never offered for a restore. */
export const BACKUP_RETENTION_S = 30 * 24 * 60 * 60
/** The actor a scheduled backup records. */
export const BACKUP_SCHEDULE_ACTOR = 'schedule'

/**
 * One pass's bounds: it stops sending dump and import requests this long after it began, so its last request ends
 * within one request's timeout after that; it carries on at most this many running backups and starts at most this
 * many new ones. What it leaves running, the next pass continues.
 */
export const BACKUP_PASS_MS = 4 * 60 * 1000
export const BACKUP_PASS_CONTINUES = 16
export const BACKUP_PASS_STARTS = 4

export interface BackupScheduleDeps extends Omit<DataOperationDeps, 'repositories'> {
	repositories: Pick<ControlRepositories, 'dataOperations' | 'backups' | 'registry' | 'runs'>
	/** The installation's provider: only an environment whose approved access it serves the ops channel at is backed up. */
	provider: Pick<ControlProvider, 'id' | 'opsChannel'>
	/** Unix SECONDS, the unit every `*_at` column uses. */
	now?: () => number
	/** Milliseconds, for the pass's bound. */
	clock?: () => number
}

/** What one pass did, in counts only. */
export interface BackupScheduleSummary {
	/** Running backups the pass carried on. */
	continued: number
	/** Backups the pass started. */
	started: number
	succeeded: number
	failed: number
	/** Left running for the next pass: out of time, or no answer to act on. */
	unfinished: number
	/** Not driven: the environment was busy, or the start or the continuation was refused. */
	skipped: number
	/** Environments whose turn threw; each is named in its own warning. */
	errored: number
}

/** One maintenance pass of the daily backups. A provider without the ops channel (Zerops) backs up nothing. */
export async function runBackupSchedule(deps: BackupScheduleDeps): Promise<BackupScheduleSummary> {
	const summary: BackupScheduleSummary = { continued: 0, started: 0, succeeded: 0, failed: 0, unfinished: 0, skipped: 0, errored: 0 }
	if (deps.provider.opsChannel === undefined) return summary
	const clock = deps.clock ?? Date.now
	const deadline = clock() + BACKUP_PASS_MS
	const passSpent = deps.passSpent ?? (() => clock() >= deadline)
	const driving: DataOperationDeps = { ...deps, passSpent }
	for (const operation of await deps.repositories.dataOperations.listRunning('backup', BACKUP_PASS_CONTINUES)) {
		if (passSpent()) return summary
		summary.continued++
		await turn(summary, operation, () => advanceDataOperation(driving, operation.id))
	}
	const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))()
	for (const row of await deps.repositories.registry.listAppEnvsByProvider(deps.provider.id)) {
		if (summary.started >= BACKUP_PASS_STARTS || passSpent()) return summary
		try {
			if (!(await due(deps, row, now))) continue
		} catch (error) {
			warn(row, error)
			summary.errored++
			continue
		}
		// Only a backup the pass created counts against the starts; a refused environment leaves the budget to the next.
		if (await turn(summary, row, () => startBackup(driving, { appId: row.app_id, env: row.env, actor: BACKUP_SCHEDULE_ACTOR }))) summary.started++
	}
	return summary
}

/**
 * Whether the environment is due a daily backup: it has a domain, its approved access is served the ops channel, it did
 * not opt out, it has no succeeded backup from the last day, and no backup failed within the retry interval. A running
 * operation, or a record that does not leave it open, refuses the start itself.
 */
async function due(deps: BackupScheduleDeps, row: AppEnvRow, now: number): Promise<boolean> {
	if (row.domain === null || row.domain === '') return false
	const { access } = approvedProviderAccess(row)
	if (access === undefined || deps.provider.opsChannel?.(access) !== true) return false
	if (!dailyBackups(await deps.repositories.backups.getSchedule(row.app_id, row.env))) return false
	const history = await deps.repositories.backups.history(row.app_id, row.env)
	if (history.lastSucceeded !== null && history.lastSucceeded > now - BACKUP_INTERVAL_S) return false
	return history.lastFailed === null || history.lastFailed <= now - BACKUP_RETRY_S
}

/** Drives one environment's turn into the summary; `true` when an operation was driven. */
async function turn(
	summary: BackupScheduleSummary,
	coordinates: { readonly app_id: string; readonly env: string },
	drive: () => Promise<DataOperationOutcome | null>,
): Promise<boolean> {
	try {
		const outcome = await drive()
		if (outcome?.kind !== 'driven') {
			summary.skipped++
			return false
		}
		if (outcome.result === 'succeeded') summary.succeeded++
		else if (outcome.result === 'failed') summary.failed++
		else summary.unfinished++
		return true
	} catch (error) {
		warn(coordinates, error)
		summary.errored++
		return false
	}
}

function warn(coordinates: { readonly app_id: string; readonly env: string }, error: unknown): void {
	// The message only: an error object may carry a request, and so a key.
	console.warn(`backup schedule: ${coordinates.app_id}/${coordinates.env} failed: ${error instanceof Error ? error.message : 'unknown error'}`)
}

/** No row is the default: daily backups on. */
export function dailyBackups(schedule: BackupScheduleRow | null): boolean {
	return schedule === null || schedule.daily === 1
}

export async function listBackups(
	deps: { repositories: Pick<ControlRepositories, 'backups'> },
	target: { readonly appId: string; readonly env: string },
	page: { before?: string; limit: number },
	now: number,
): Promise<DataBackupDto[]> {
	return (await deps.repositories.backups.listForEnvironment(target.appId, target.env, page)).map((row) => toBackupDto(row, now))
}

/** The record as `data.read` shows it: identifiers, states, codes, sizes and timestamps; a dump past its retention is expired. */
export function toBackupDto(row: BackupRow, now: number): DataBackupDto {
	return {
		id: row.id,
		appId: row.app_id,
		env: row.env,
		operationId: row.operation_id,
		object: row.object,
		state: row.state,
		errorCode: row.error_code,
		createdAt: row.created_at,
		finishedAt: row.finished_at,
		bookmark: row.bookmark,
		sizeBytes: row.size_bytes,
		parts: row.parts,
		tables: row.tables,
		rehearsal: row.rehearsal,
		rehearsalCode: row.rehearsal_code,
		expired: row.created_at <= now - BACKUP_RETENTION_S,
	}
}

export function toBackupScheduleDto(
	target: { readonly appId: string; readonly env: string },
	schedule: BackupScheduleRow | null,
): DataBackupScheduleDto {
	return { appId: target.appId, env: target.env, daily: dailyBackups(schedule), updatedAt: schedule?.updated_at ?? null }
}
