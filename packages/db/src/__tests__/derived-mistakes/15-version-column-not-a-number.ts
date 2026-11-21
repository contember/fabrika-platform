import { defineTables } from '../../tables'
import { stampedColumns, stated } from '../derived-tables/conventions'
import { vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, stampedColumns)({
	...stated,
	// mistake: releases.version holds no number, so the policy names its version column
	releases: { scope: { app: 'the releases every workspace sees' }, actions: { read: 'notes.read', insert: 'notes.write' }, insert: ['version'] },
})
