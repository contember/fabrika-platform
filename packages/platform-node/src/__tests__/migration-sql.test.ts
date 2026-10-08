import { describe, expect, test } from 'bun:test'
import { refusedStatement, statementStarts } from '../migration-sql.js'

describe('migration statement starts', () => {
	test('splits top-level statements and reports the line of each', () => {
		expect(statementStarts('CREATE TABLE a (id text);\n\nALTER TABLE a ADD b text;\nSELECT 1')).toEqual([
			{ words: ['CREATE', 'TABLE'], line: 1 },
			{ words: ['ALTER', 'TABLE'], line: 3 },
			{ words: ['SELECT'], line: 4 },
		])
	})

	test('skips comments, strings, quoted identifiers and dollar-quoted bodies', () => {
		const sql = [
			'-- COMMIT;',
			'/* outer /* nested; COMMIT; */ still a comment; ROLLBACK; */',
			"INSERT INTO a VALUES ('x; COMMIT', 'it''s; END', E'esc\\'; SET x = 1');",
			'CREATE TABLE "commit; set" (id text);',
			'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN COMMIT; END; $body$;',
			'DO $$ BEGIN RESET ALL; END $$;',
			'CREATE RULE r AS ON INSERT TO a DO ALSO (NOTIFY a; SELECT 1);',
		].join('\n')
		expect(statementStarts(sql).map((start) => start.words[0])).toEqual(['INSERT', 'CREATE', 'CREATE', 'DO', 'CREATE'])
		expect(refusedStatement(sql)).toBeUndefined()
	})

	test('a positional parameter and a $ inside a word are not dollar quotes', () => {
		expect(statementStarts('SELECT $1; SELECT a$b$ FROM t; COMMIT').map((start) => start.words[0])).toEqual(['SELECT', 'SELECT', 'COMMIT'])
	})
})

describe('refused migration statements', () => {
	test('refuses each statement that ends the transaction or changes a runner-owned setting', () => {
		for (
			const [sql, statement] of [
				['ROLLBACK', 'ROLLBACK'],
				['CREATE TABLE a (id text); COMMIT; SELECT 1', 'COMMIT'],
				['begin; select 1', 'BEGIN'],
				['START TRANSACTION', 'START'],
				['END', 'END'],
				['ABORT', 'ABORT'],
				['SAVEPOINT s', 'SAVEPOINT'],
				['RELEASE SAVEPOINT s', 'RELEASE'],
				["PREPARE TRANSACTION 'x'", 'PREPARE TRANSACTION'],
				["COMMIT PREPARED 'x'", 'COMMIT'],
				["ROLLBACK PREPARED 'x'", 'ROLLBACK'],
				['SET LOCAL statement_timeout = 0', 'SET'],
				['set role admin', 'SET'],
				['SET SESSION AUTHORIZATION admin', 'SET'],
				['RESET lock_timeout', 'RESET'],
				['DISCARD ALL', 'DISCARD'],
				['LISTEN c', 'LISTEN'],
				['NOTIFY c', 'NOTIFY'],
				['LOCK TABLE a', 'LOCK'],
				['VACUUM a', 'VACUUM'],
				['CALL p()', 'CALL'],
			] as const
		) {
			expect(refusedStatement(sql)?.statement).toBe(statement)
		}
	})

	test('a prepared statement and a DO block are not refused', () => {
		expect(refusedStatement('PREPARE q AS SELECT 1')).toBeUndefined()
		expect(refusedStatement('DO $$ BEGIN PERFORM 1; END $$')).toBeUndefined()
	})

	test('names the line of the refused statement', () => {
		expect(refusedStatement('CREATE TABLE a (id text);\n-- note\nCOMMIT;')).toEqual({ statement: 'COMMIT', line: 3 })
	})
})
