import { describe, expect, test } from 'bun:test'
import {
	defaultExpressionCall,
	executableStatement,
	foreignSchemaReference,
	refusedDefault,
	refusedStatement,
	statementStarts,
} from '../migration-sql.js'

describe('migration statement starts', () => {
	test('splits top-level statements and reports the line of each', () => {
		expect(statementStarts('CREATE TABLE a (id text);\n\nALTER TABLE a ADD b text;\nSELECT 1')).toEqual([
			{ words: ['CREATE', 'TABLE', 'A'], line: 1 },
			{ words: ['ALTER', 'TABLE', 'A', 'ADD', 'B', 'TEXT'], line: 3 },
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

describe('database code in an application migration', () => {
	test('refuses each statement that installs database code or changes grants', () => {
		for (
			const [sql, statement] of [
				['CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', 'CREATE FUNCTION'],
				['create or replace function f() returns int language sql as $$ select 1 $$', 'CREATE FUNCTION'],
				['CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$', 'CREATE PROCEDURE'],
				['CREATE TRIGGER t AFTER UPDATE ON a FOR EACH ROW EXECUTE FUNCTION f()', 'CREATE TRIGGER'],
				['CREATE OR REPLACE TRIGGER t AFTER UPDATE ON a FOR EACH ROW EXECUTE FUNCTION f()', 'CREATE TRIGGER'],
				['CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON a FOR EACH ROW EXECUTE FUNCTION f()', 'CREATE CONSTRAINT TRIGGER'],
				['CREATE EVENT TRIGGER t ON ddl_command_start EXECUTE FUNCTION f()', 'CREATE EVENT TRIGGER'],
				['CREATE RULE r AS ON UPDATE TO a DO ALSO DELETE FROM b', 'CREATE RULE'],
				['CREATE VIEW v AS SELECT 1', 'CREATE VIEW'],
				['CREATE OR REPLACE TEMP RECURSIVE VIEW v (n) AS SELECT 1', 'CREATE TEMP RECURSIVE VIEW'],
				['CREATE MATERIALIZED VIEW v AS SELECT 1', 'CREATE MATERIALIZED VIEW'],
				['CREATE POLICY p ON a USING (true)', 'CREATE POLICY'],
				['CREATE EXTENSION dblink', 'CREATE EXTENSION'],
				['CREATE OR REPLACE TRUSTED PROCEDURAL LANGUAGE plx', 'CREATE TRUSTED PROCEDURAL LANGUAGE'],
				['CREATE AGGREGATE s (int) (SFUNC = int4pl, STYPE = int)', 'CREATE AGGREGATE'],
				['CREATE OPERATOR === (FUNCTION = int4eq, LEFTARG = int, RIGHTARG = int)', 'CREATE OPERATOR'],
				['CREATE CAST (text AS int) WITH INOUT', 'CREATE CAST'],
				["CREATE DEFAULT CONVERSION c FOR 'LATIN1' TO 'UTF8' FROM f", 'CREATE DEFAULT CONVERSION'],
				['CREATE TRANSFORM FOR int LANGUAGE plx (FROM SQL WITH FUNCTION f(internal))', 'CREATE TRANSFORM'],
				['CREATE SCHEMA s CREATE TRIGGER t AFTER UPDATE ON a FOR EACH ROW EXECUTE FUNCTION f()', 'CREATE SCHEMA'],
				['DO $$ BEGIN PERFORM 1; END $$', 'DO'],
				['GRANT SELECT ON a TO PUBLIC', 'GRANT'],
				['REVOKE ALL ON a FROM PUBLIC', 'REVOKE'],
				['ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC', 'ALTER DEFAULT PRIVILEGES'],
			] as const
		) {
			expect(executableStatement(sql)?.statement).toBe(statement)
		}
	})

	test('allows tables, indexes, types and keywords inside strings, comments and quoted names', () => {
		const sql = [
			"CREATE TYPE stage AS ENUM ('open', 'won');",
			'CREATE TEMP TABLE scratch (id text);',
			'CREATE UNLOGGED TABLE cache (id text);',
			'CREATE UNIQUE INDEX deals_name ON deals (lower(name));',
			'CREATE SEQUENCE numbers;',
			'CREATE DOMAIN positive AS int CHECK (VALUE > 0);',
			'ALTER TABLE deals ADD COLUMN note text;',
			'-- CREATE TRIGGER t',
			"COMMENT ON TABLE deals IS 'CREATE FUNCTION f';",
			'CREATE TABLE "do" (id text);',
		].join('\n')
		expect(executableStatement(sql)).toBeUndefined()
	})

	test('names the line of the refused statement', () => {
		expect(executableStatement('CREATE TABLE a (id text);\n\nCREATE TRIGGER t AFTER UPDATE ON a EXECUTE FUNCTION f()')).toEqual({
			statement: 'CREATE TRIGGER',
			line: 3,
		})
	})
})

describe('column defaults of an application migration', () => {
	test('refuses a default that calls anything but now() and gen_random_uuid()', () => {
		for (
			const [sql, call] of [
				["CREATE TABLE a (n bigint DEFAULT nextval('s'))", 'nextval'],
				["CREATE TABLE a (n bigint NOT NULL DEFAULT (nextval('s')))", 'nextval'],
				["ALTER TABLE a ALTER COLUMN n SET DEFAULT set_config('search_path', 'public', false)", 'set_config'],
				["ALTER TABLE a ADD COLUMN n text DEFAULT 'x' || current_setting('role')", 'current_setting'],
				['CREATE TABLE a (n timestamptz DEFAULT now() + spread())', 'spread'],
				['CREATE TABLE a (id uuid DEFAULT app_x.gen_random_uuid())', 'app_x.gen_random_uuid'],
				["CREATE TABLE a (n bool DEFAULT true::bool AND pg_notify('c', 'x') IS NULL)", 'pg_notify'],
				["CREATE TABLE a (n text DEFAULT ''::text AND f('x'))", 'f'],
				['CREATE TABLE a (n int DEFAULT COALESCE(NULL, 1))', 'coalesce'],
				["CREATE DOMAIN d AS bigint DEFAULT nextval('s')", 'nextval'],
			] as const
		) {
			expect(refusedDefault(sql)?.call).toBe(call)
		}
	})

	test('allows constants, casts, now(), gen_random_uuid() and DEFAULT without an expression', () => {
		const sql = [
			'CREATE TABLE a (',
			'\tid uuid PRIMARY KEY DEFAULT gen_random_uuid(),',
			'\tother uuid DEFAULT pg_catalog.gen_random_uuid(),',
			'\tat timestamptz NOT NULL DEFAULT now(),',
			"\tdue timestamptz DEFAULT now() + '1 day'::interval,",
			'\tseen timestamptz DEFAULT CURRENT_TIMESTAMP,',
			"\tstage stage NOT NULL DEFAULT 'open' CHECK (length(stage::text) > 0),",
			"\tlabel varchar(20) DEFAULT 'x'::character varying(20) REFERENCES labels (name),",
			"\tamount numeric DEFAULT '0'::numeric(10, 2),",
			"\tstamp timestamptz DEFAULT '2026-01-01'::timestamp(3) with time zone,",
			"\ttags text[] DEFAULT '{}'::text[],",
			'\tn int DEFAULT -1,',
			'\tcounter bigint GENERATED BY DEFAULT AS IDENTITY (START WITH 1),',
			'\tparent text REFERENCES a (id) ON DELETE SET DEFAULT',
			');',
			'ALTER TABLE a ALTER COLUMN n DROP DEFAULT;',
			'INSERT INTO a DEFAULT VALUES;',
			"INSERT INTO a (id, n) VALUES (DEFAULT, length('x'));",
			'UPDATE a SET n = DEFAULT WHERE length(label) > 1;',
			'CREATE TABLE p PARTITION OF a DEFAULT;',
		].join('\n')
		expect(refusedDefault(sql)).toBeUndefined()
	})

	test('names the line of the refused default', () => {
		expect(refusedDefault("CREATE TABLE a (\n\tid text,\n\tn bigint DEFAULT nextval('s')\n)")).toEqual({ call: 'nextval', line: 3 })
	})

	test('judges a default as the catalog prints it', () => {
		for (
			const expression of [
				'now()',
				'gen_random_uuid()',
				"'open'::stage",
				'0',
				'false',
				"'{}'::jsonb",
				'CURRENT_TIMESTAMP',
				"(now() + '01:00:00'::interval)",
			]
		) {
			expect(defaultExpressionCall(expression)).toBeUndefined()
		}
		expect(defaultExpressionCall("nextval('deals_n_seq'::regclass)")).toBe('nextval')
		expect(defaultExpressionCall("set_config('search_path'::text, 'public'::text, false)")).toBe('set_config')
	})
})
