import { describe, expect, test } from 'bun:test'
import { disallowedStatement, foreignSchemaReference, refusedStatement, statementStarts } from '../migration-sql.js'

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
		// A `;` inside a rule's parentheses splits too: splitting more only makes a check stricter.
		expect(statementStarts(sql).map((start) => start.words[0])).toEqual(['INSERT', 'CREATE', 'CREATE', 'DO', 'CREATE', 'SELECT'])
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

describe('schema-qualified references of an application migration', () => {
	test('refuses public, another application and a platform schema, quoted or not, also inside a dollar-quoted body', () => {
		expect(foreignSchemaReference("UPDATE public.notes SET title = 'x';")).toEqual({ schema: 'public', line: 1 })
		expect(foreignSchemaReference('CREATE TABLE a (id TEXT);\nUPDATE "app_notes".notes SET title = NULL')).toEqual({ schema: 'app_notes', line: 2 })
		expect(foreignSchemaReference('INSERT INTO Public . notes VALUES (1)')).toEqual({ schema: 'public', line: 1 })
		expect(foreignSchemaReference('DELETE FROM APP_Other.notes')).toEqual({ schema: 'app_other', line: 1 })
		expect(foreignSchemaReference('SELECT * FROM fabrika_iam.principals')).toEqual({ schema: 'fabrika_iam', line: 1 })
		expect(foreignSchemaReference('DO $$\nBEGIN\n  UPDATE public.notes SET title = NULL;\nEND\n$$')).toEqual({ schema: 'public', line: 3 })
	})

	test('allows unqualified names, pg_catalog, and a qualifier inside a literal or a comment', () => {
		expect(foreignSchemaReference('CREATE TABLE notes (id TEXT PRIMARY KEY); SELECT pg_catalog.now()')).toBeUndefined()
		expect(foreignSchemaReference("-- public.notes\nCOMMENT ON TABLE notes IS 'copied from public.notes'")).toBeUndefined()
		expect(foreignSchemaReference('SELECT "Public".x FROM notes')).toBeUndefined()
	})
})

describe('the statements an application migration may hold', () => {
	test('allows tables, indexes, enum types, drops, comments and backfills', () => {
		const sql = [
			"CREATE TYPE stage AS ENUM ('open', 'won');",
			'CREATE TYPE "Mood" AS ENUM (\'calm\');',
			"ALTER TYPE stage ADD VALUE IF NOT EXISTS 'lost';",
			"ALTER TYPE stage RENAME VALUE 'won' TO 'closed';",
			'CREATE TABLE IF NOT EXISTS deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), n bigint GENERATED ALWAYS AS IDENTITY, stage stage);',
			'CREATE TABLE copy (LIKE deals);',
			'CREATE INDEX deals_stage ON deals (stage) WHERE stage IS NOT NULL;',
			'CREATE UNIQUE INDEX deals_lower ON deals (lower(id::text));',
			"ALTER TABLE deals ADD COLUMN note text, ALTER COLUMN note SET DEFAULT '', DROP CONSTRAINT IF EXISTS deals_check;",
			"COMMENT ON TABLE deals IS 'CREATE FUNCTION f';",
			"INSERT INTO deals (stage) VALUES ('open');",
			"UPDATE deals SET note = 'x' WHERE note IS NULL;",
			'DELETE FROM deals WHERE stage IS NULL;',
			'DROP INDEX deals_stage;',
			'DROP TABLE copy;',
			'DROP TRIGGER IF EXISTS legacy ON deals;',
			'DROP FUNCTION IF EXISTS legacy();',
			'-- CREATE TRIGGER t',
		].join('\n')
		expect(disallowedStatement(sql)).toBeUndefined()
	})

	test('refuses everything else, each before any SQL runs', () => {
		for (
			const [sql, statement] of [
				['CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', 'CREATE FUNCTION'],
				['create or replace function f() returns int language sql as $$ select 1 $$', 'CREATE OR'],
				['CREATE TRIGGER t AFTER UPDATE ON a FOR EACH ROW EXECUTE FUNCTION f()', 'CREATE TRIGGER'],
				['CREATE RULE r AS ON UPDATE TO a DO ALSO DELETE FROM b', 'CREATE RULE'],
				['CREATE VIEW v AS SELECT 1', 'CREATE VIEW'],
				['CREATE MATERIALIZED VIEW v AS SELECT 1', 'CREATE MATERIALIZED'],
				['CREATE POLICY p ON a USING (true)', 'CREATE POLICY'],
				['CREATE EXTENSION dblink', 'CREATE EXTENSION'],
				['CREATE DOMAIN d AS int CHECK (VALUE > 0)', 'CREATE DOMAIN'],
				['CREATE SEQUENCE s', 'CREATE SEQUENCE'],
				['CREATE SCHEMA s', 'CREATE SCHEMA'],
				['CREATE TEMP TABLE scratch (id text)', 'CREATE TEMP'],
				['CREATE TYPE r AS RANGE (subtype = int4)', 'CREATE TYPE other than AS ENUM'],
				['CREATE TYPE pair AS (a int, b int)', 'CREATE TYPE other than AS ENUM'],
				['ALTER TYPE stage OWNER TO someone', 'ALTER TYPE other than ADD VALUE or RENAME VALUE'],
				['CREATE TABLE b (LIKE a INCLUDING ALL)', 'CREATE TABLE … LIKE … INCLUDING'],
				['CREATE TABLE b (LIKE a INCLUDING DEFAULTS)', 'CREATE TABLE … LIKE … INCLUDING'],
				['CREATE TABLE b AS SELECT * FROM a', 'CREATE TABLE … AS'],
				['ALTER TABLE a SET SCHEMA elsewhere', 'ALTER TABLE … SET SCHEMA'],
				['ALTER TABLE a OWNER TO someone', 'ALTER TABLE … OWNER TO'],
				['DROP SCHEMA s CASCADE', 'DROP SCHEMA'],
				['DO $$ BEGIN PERFORM 1; END $$', 'DO'],
				['COPY a FROM PROGRAM \'psql -c "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql"\'', 'COPY'],
				['SELECT 1', 'SELECT'],
				["SELECT set_config('search_path', 'public', false)", 'SELECT'],
				['WITH x AS (DELETE FROM a RETURNING *) SELECT 1', 'WITH'],
				['PREPARE q AS INSERT INTO a VALUES (1)', 'PREPARE'],
				['EXECUTE q', 'EXECUTE'],
				['CALL p()', 'CALL'],
				['SET search_path TO public', 'SET'],
				['GRANT SELECT ON a TO PUBLIC', 'GRANT'],
				['REVOKE ALL ON a FROM PUBLIC', 'REVOKE'],
				['ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC', 'ALTER DEFAULT'],
				['EXPLAIN ANALYZE CREATE MATERIALIZED VIEW v AS SELECT 1', 'EXPLAIN'],
				['(SELECT 1)', '('],
			] as const
		) {
			expect(disallowedStatement(sql)?.statement).toBe(statement)
		}
	})

	test('a comment ended by a lone carriage return hides no statement', () => {
		const sql = 'CREATE TABLE a (id text); -- a note\rCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'
		expect(disallowedStatement(sql)?.statement).toBe('CREATE FUNCTION')
	})

	test('a dollar quote with a long tag and an unmatched parenthesis hides no statement', () => {
		const tag = `$${'t'.repeat(70)}$`
		const sql = `CREATE TABLE a (id text);\nCOMMENT ON TABLE a IS ${tag} ( ${tag};\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`
		expect(disallowedStatement(sql)).toEqual({ statement: 'CREATE FUNCTION', line: 3 })
	})

	test('names the line of the refused statement', () => {
		expect(disallowedStatement('CREATE TABLE a (id text);\n\nCREATE TRIGGER t AFTER UPDATE ON a EXECUTE FUNCTION f()')).toEqual({
			statement: 'CREATE TRIGGER',
			line: 3,
		})
	})
})
