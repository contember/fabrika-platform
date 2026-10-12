// Whether an application's migrations leave a file collection's table able to hold the scan states: only the named
// check of every state with the scan columns, or the exact scan migration, count — never a statement that merely
// mentions a scan state.

import { describe, expect, test } from 'bun:test'
import { FILE_SCAN_COLUMNS, fileScanAlter, fileScanIndex, fileStatusCheck, fileTableScanReady } from '../file-table-ddl'

const TABLE = 'fabrika_files_uploads'
const EARLIER = `CREATE TABLE ${TABLE} (id UUID PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('pending', 'live')));`
const CURRENT = `CREATE TABLE ${TABLE} (id UUID PRIMARY KEY, status TEXT NOT NULL ${fileStatusCheck(TABLE)}, ${FILE_SCAN_COLUMNS.join(', ')});`

describe('fileTableScanReady', () => {
	test('a table no migration creates is not this question', () => {
		expect(fileTableScanReady(['CREATE TABLE notes (id TEXT);'], TABLE)).toBeUndefined()
	})

	test('the current DDL, and the earlier one followed by the scan migration, are ready', () => {
		expect(fileTableScanReady([CURRENT], TABLE)).toBe(true)
		expect(fileTableScanReady([EARLIER, `${fileScanAlter(TABLE)};\n${fileScanIndex(TABLE)};`], TABLE)).toBe(true)
	})

	test('an index predicate, a comment or a literal that mentions quarantined does not widen the check', () => {
		for (
			const later of [
				`${fileScanIndex(TABLE)};`,
				`-- ${fileScanAlter(TABLE)}\nSELECT 1;`,
				`INSERT INTO notes (title) VALUES ('${fileScanAlter(TABLE).replaceAll("'", "''")}');`,
				`ALTER TABLE ${TABLE} ADD CONSTRAINT ${TABLE}_status CHECK (status IN ('pending', 'live', 'quarantined', 'rejected'));`,
			]
		) {
			expect(fileTableScanReady([EARLIER, later], TABLE)).toBe(false)
		}
	})

	test('a check of every state without the scan columns is not ready', () => {
		expect(fileTableScanReady([`CREATE TABLE ${TABLE} (id UUID PRIMARY KEY, status TEXT NOT NULL ${fileStatusCheck(TABLE)});`], TABLE)).toBe(false)
	})
})
