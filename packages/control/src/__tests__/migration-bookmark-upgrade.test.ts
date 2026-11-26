// An installation upgraded to Control's 0048 keeps the data operations it recorded before it: each reads as the
// read-only phase, with nothing a bookmark migration records, and its run is not one a bookmark migration holds. One
// upgraded to 0049 reads each bookmark migration as one that asked for no in-place rewind.

import { uuidv7 } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { recordedMaintenance, toDataOperationDto } from '../data-operations'
import { createHarness, migrationsText } from './helpers/harness'

const BOOKMARK_MIGRATION = '0048_migration_bookmark.sql'
const REWIND_MIGRATION = '0049_migration_rewind.sql'

describe("Control's migration 0048 over operations recorded before it", () => {
	test('a migrate operation recorded before 0048 reads as the read-only phase after it', async () => {
		const harness = createHarness(undefined, {}, migrationsText((filename) => filename < BOOKMARK_MIGRATION))
		const { repositories, sqlite } = harness
		await repositories.registry.createApp({ id: 'crm', repoUrl: 'github.com/acme/crm' })
		const operation = uuidv7()
		const run = uuidv7()
		sqlite.run(
			`INSERT INTO app_env_data_operations
				(id, app_id, env, kind, step, target_mode, generation, state, error_code, actor, created_at, updated_at, finished_at, run_id)
				VALUES (?, 'crm', 'prod', 'migrate', 'open', 'open', 3, 'succeeded', NULL, 'user:ada', 1790000000, 1790000010, 1790000010, ?)`,
			[operation, run],
		)
		sqlite.exec(migrationsText((filename) => filename === BOOKMARK_MIGRATION))

		const row = await repositories.dataOperations.get(operation)
		expect(row).toMatchObject({
			kind: 'migrate',
			step: 'open',
			state: 'succeeded',
			run_id: run,
			records_bookmark: 0,
			data_loss: 0,
			deadline_at: null,
			revert_run_id: null,
			migration_failure: null,
			deployed: 0,
			candidate_version: null,
			candidate_recovered: 0,
		})
		if (row === null) throw new Error('the operation vanished')
		expect(toDataOperationDto(row)).toMatchObject({ recordsBookmark: false, migrationFailure: null, revertRunId: null, candidateRecovered: false })
		expect(await recordedMaintenance({ repositories }, { appId: 'crm', env: 'prod' })).toBe('open')
		// Its run is not held by a bookmark migration, so the reconciler settles it by its provider as before.
		expect(await repositories.dataOperations.bookmarkMigrationOfRun(run)).toBeNull()
		expect(await repositories.dataOperations.revertedBy('crm', 'prod', run)).toBeNull()
		harness.sqlite.close()
	})

	test('a bookmark migration recorded before 0049 reads as one that asked for no rewind after it', async () => {
		const harness = createHarness(undefined, {}, migrationsText((filename) => filename < REWIND_MIGRATION))
		const { repositories, sqlite } = harness
		await repositories.registry.createApp({ id: 'crm', repoUrl: 'github.com/acme/crm' })
		const operation = uuidv7()
		sqlite.run(
			`INSERT INTO app_env_data_operations
				(id, app_id, env, kind, step, target_mode, generation, state, error_code, actor, created_at, updated_at, finished_at, run_id,
					records_bookmark, migration_failure)
				VALUES (?, 'crm', 'prod', 'migrate', 'restrict', 'closed', 4, 'failed', 'migration_failed', 'user:ada', 1790000000, 1790000010, 1790000010, ?,
					1, 'committed')`,
			[operation, uuidv7()],
		)
		sqlite.exec(migrationsText((filename) => filename === REWIND_MIGRATION))

		const row = await repositories.dataOperations.get(operation)
		expect(row).toMatchObject({
			migration_failure: 'committed',
			rewind_record: null,
			rewind_current: null,
			rewind_target: null,
			rewind_arms: 0,
			rewind_undo: null,
			rewind_verified: 0,
			rewind_outcome: null,
			rewind_refusal: null,
			recovery_rollback: 0,
		})
		if (row === null) throw new Error('the operation vanished')
		expect(toDataOperationDto(row)).toMatchObject({ rewound: false, rewindRefusal: null, rollbackAndOpen: false })
		expect(await recordedMaintenance({ repositories }, { appId: 'crm', env: 'prod' })).toBe('unsettled')
		harness.sqlite.close()
	})
})
