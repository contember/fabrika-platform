// The catalog half of ADR-0017's migration rules: the runtime witness. Postgres has already resolved every name the
// schema stores, so this reads the catalog instead of the SQL text: the runner runs it inside each migration's
// transaction, before its commit, and `@fabrika/db`'s codegen runs it at every start. It refuses what escapes the
// schema and any database object that no migration declares, such as one created at runtime.

import type { DatabaseObject } from './migration-classify'

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const encoder = new TextEncoder()

/** A text literal with no quote and no backslash in it, whatever the session's `standard_conforming_strings`. */
function hexText(value: string): string {
	const hex = Array.from(encoder.encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
	return `pg_catalog.convert_from(pg_catalog.decode('${hex}', 'hex'), 'UTF8')`
}

/** The manifest as a `text[]` of `<kind> <name>`, the names `objects` gives the schema's objects. */
function declaredArray(declared: readonly DatabaseObject[]): string {
	if (declared.length === 0) return 'ARRAY[]::pg_catalog.text[]'
	return `ARRAY[${declared.map((object) => hexText(`${object.kind} ${object.name}`)).join(', ')}]::pg_catalog.text[]`
}

/** A catalog's `regclass`, qualified, since the query may run with the application's schema first on the path. */
const catalog = (table: string): string => `'pg_catalog.${table}'::pg_catalog.regclass`

/**
 * One row (`violation`) per escape and per undeclared object in `schema`. Escapes: a function that is `SECURITY
 * DEFINER`, has a `SET` clause or a language other than `sql` and `plpgsql`; an event trigger on a function of the
 * schema; and any dependency of an object of the schema on a type, function, relation, operator, operator class or
 * collation outside the schema and `pg_catalog`. Undeclared: a function, procedure, aggregate, operator, trigger (a
 * foreign key's excepted), rule, view, policy, domain or sequence (an identity or serial column's excepted) that
 * `declared` does not name. Every name is qualified with `pg_catalog`, the query has no backslash, and the manifest is
 * hex text, so the session's `search_path` and `standard_conforming_strings` cannot change what it finds.
 */
export function databaseCodeQuery(schema: string, declared: readonly DatabaseObject[]): string {
	if (!IDENTIFIER.test(schema)) throw new Error(`Invalid application schema: ${schema}`)
	const namespace = `(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = '${schema}')`
	const trusted = `(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname IN ('${schema}', 'pg_catalog'))`
	const outside = (kind: string, table: string, name: string, namespaceColumn: string): string =>
		`SELECT d.object || ' depends on the ${kind} ' || s.nspname || '.' || r.${name}
	FROM dependencies d
	JOIN pg_catalog.${table} r ON d.refclassid = ${catalog(table)} AND r.oid = d.refobjid
	JOIN pg_catalog.pg_namespace s ON s.oid = r.${namespaceColumn}
	WHERE r.${namespaceColumn} NOT IN ${trusted}`
	return `
WITH objects AS (
	SELECT CASE p.prokind WHEN 'a' THEN 'aggregate ' WHEN 'p' THEN 'procedure ' ELSE 'function ' END || p.proname AS object
	FROM pg_catalog.pg_proc p
	WHERE p.pronamespace = ${namespace} AND NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = ${catalog('pg_proc')} AND d.objid = p.oid AND d.deptype = 'i'
	)
	UNION ALL
	SELECT 'operator ' || o.oprname FROM pg_catalog.pg_operator o WHERE o.oprnamespace = ${namespace}
	UNION ALL
	SELECT 'trigger ' || c.relname || '.' || t.tgname
	FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
	WHERE c.relnamespace = ${namespace} AND NOT t.tgisinternal
	UNION ALL
	SELECT 'rule ' || c.relname || '.' || r.rulename
	FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
	WHERE c.relnamespace = ${namespace} AND r.rulename <> '_RETURN'
	UNION ALL
	SELECT CASE c.relkind WHEN 'm' THEN 'materialized view ' ELSE 'view ' END || c.relname
	FROM pg_catalog.pg_class c WHERE c.relnamespace = ${namespace} AND c.relkind IN ('v', 'm')
	UNION ALL
	SELECT 'policy ' || c.relname || '.' || p.polname
	FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
	WHERE c.relnamespace = ${namespace}
	UNION ALL
	SELECT 'domain ' || t.typname FROM pg_catalog.pg_type t WHERE t.typnamespace = ${namespace} AND t.typtype = 'd'
	UNION ALL
	SELECT 'sequence ' || c.relname
	FROM pg_catalog.pg_class c
	WHERE c.relnamespace = ${namespace} AND c.relkind = 'S' AND NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_depend d
		WHERE d.classid = ${catalog('pg_class')} AND d.objid = c.oid AND d.refclassid = ${catalog('pg_class')}
			AND d.refobjsubid > 0 AND d.deptype IN ('i', 'a')
	)
),
dependents AS (
	SELECT ${catalog('pg_class')} AS classid, c.oid AS objid,
		CASE c.relkind WHEN 'i' THEN 'index ' WHEN 'v' THEN 'view ' WHEN 'm' THEN 'materialized view ' WHEN 'S' THEN 'sequence ' ELSE 'table ' END
			|| c.relname AS object
	FROM pg_catalog.pg_class c WHERE c.relnamespace = ${namespace}
	UNION ALL
	SELECT ${catalog('pg_proc')}, p.oid, 'function ' || p.proname FROM pg_catalog.pg_proc p WHERE p.pronamespace = ${namespace}
	UNION ALL
	SELECT ${catalog('pg_type')}, t.oid, 'type ' || t.typname FROM pg_catalog.pg_type t WHERE t.typnamespace = ${namespace}
	UNION ALL
	SELECT ${catalog('pg_operator')}, o.oid, 'operator ' || o.oprname FROM pg_catalog.pg_operator o WHERE o.oprnamespace = ${namespace}
	UNION ALL
	SELECT ${catalog('pg_constraint')}, k.oid, 'constraint ' || k.conname FROM pg_catalog.pg_constraint k WHERE k.connamespace = ${namespace}
	UNION ALL
	SELECT ${catalog('pg_attrdef')}, d.oid, 'default ' || c.relname || '.' || a.attname
	FROM pg_catalog.pg_attrdef d
	JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
	JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
	WHERE c.relnamespace = ${namespace}
	UNION ALL
	SELECT ${catalog('pg_trigger')}, t.oid, 'trigger ' || c.relname || '.' || t.tgname
	FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = ${namespace}
	UNION ALL
	SELECT ${catalog('pg_rewrite')}, r.oid, CASE WHEN r.rulename = '_RETURN' THEN 'view ' || c.relname ELSE 'rule ' || c.relname || '.' || r.rulename END
	FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class WHERE c.relnamespace = ${namespace}
	UNION ALL
	SELECT ${catalog('pg_policy')}, p.oid, 'policy ' || c.relname || '.' || p.polname
	FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = ${namespace}
),
dependencies AS (
	SELECT DISTINCT o.object, d.refclassid, d.refobjid
	FROM pg_catalog.pg_depend d JOIN dependents o ON o.classid = d.classid AND o.objid = d.objid
),
violations AS (
	SELECT 'function ' || p.proname || ' is SECURITY DEFINER' AS violation
	FROM pg_catalog.pg_proc p WHERE p.pronamespace = ${namespace} AND p.prosecdef
	UNION ALL
	SELECT 'function ' || p.proname || ' has a SET clause' FROM pg_catalog.pg_proc p WHERE p.pronamespace = ${namespace} AND p.proconfig IS NOT NULL
	UNION ALL
	SELECT 'function ' || p.proname || ' is in the language ' || l.lanname
	FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
	WHERE p.pronamespace = ${namespace} AND l.lanname NOT IN ('sql', 'plpgsql')
	UNION ALL
	SELECT 'event trigger ' || e.evtname FROM pg_catalog.pg_event_trigger e JOIN pg_catalog.pg_proc p ON p.oid = e.evtfoid
	WHERE p.pronamespace = ${namespace}
	UNION ALL
	${outside('type', 'pg_type', 'typname', 'typnamespace')}
	UNION ALL
	${outside('function', 'pg_proc', 'proname', 'pronamespace')}
	UNION ALL
	${outside('relation', 'pg_class', 'relname', 'relnamespace')}
	UNION ALL
	${outside('operator', 'pg_operator', 'oprname', 'oprnamespace')}
	UNION ALL
	${outside('operator class', 'pg_opclass', 'opcname', 'opcnamespace')}
	UNION ALL
	${outside('collation', 'pg_collation', 'collname', 'collnamespace')}
	UNION ALL
	SELECT o.object || ' (no migration declares it)' FROM objects o WHERE o.object <> ALL (${declaredArray(declared)})
)
SELECT DISTINCT violation FROM violations ORDER BY violation`
}

/** The message a `databaseCodeCheck` failure carries before its list of violations. */
export const DATABASE_CODE_FAILURE = 'fabrika-migration-database-code: '

/** Fails the transaction it runs in when `schema` escapes or holds an object `declared` does not name. */
export function databaseCodeCheck(schema: string, declared: readonly DatabaseObject[]): string {
	return `DO $check$
DECLARE found text;
BEGIN
	SELECT pg_catalog.string_agg(violation, ', ' ORDER BY violation) INTO found FROM (${databaseCodeQuery(schema, declared)}) AS code;
	IF found IS NOT NULL THEN RAISE EXCEPTION '${DATABASE_CODE_FAILURE}%', found; END IF;
END $check$`
}
