// The catalog half of "an application schema holds no database code" (ADR-0017). Postgres has already parsed every
// expression the schema stores, so this reads the parsed trees instead of the SQL text: the runner runs it inside each
// migration's transaction, before its commit, and `@fabrika/db`'s codegen runs it at every start.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/** Reviewed `pg_catalog` functions an expression may call: no side effect, no read of another row. Trusted by name. */
const FUNCTIONS = [
	'now',
	'gen_random_uuid',
	'lower',
	'upper',
	'length',
	'char_length',
	'octet_length',
	'btrim',
	'ltrim',
	'rtrim',
	// The casts Postgres inserts on its own, such as `int8(int4)` for `DEFAULT 0` on a BIGINT column.
	'int2',
	'int4',
	'int8',
	'float4',
	'float8',
	'numeric',
	'text',
	'varchar',
	'bpchar',
	'bool',
	'date',
	'time',
	'timetz',
	'timestamp',
	'timestamptz',
	'interval',
]

/** Reviewed `pg_catalog` operators: comparison, arithmetic, concatenation and pattern matching. */
const OPERATORS = ['=', '<>', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '||', '~~', '!~~', '~~*', '!~~*', '~', '!~', '~*', '!~*']

/**
 * The expression nodes (`pg_node_tree`) an expression may hold. Anything else, a domain coercion, a subplan or a node
 * a later Postgres adds, is refused rather than understood.
 */
const NODES = [
	'CONST',
	'VAR',
	'FUNCEXPR',
	'OPEXPR',
	'DISTINCTEXPR',
	'NULLIFEXPR',
	'SCALARARRAYOPEXPR',
	'BOOLEXPR',
	'NULLTEST',
	'BOOLEANTEST',
	'RELABELTYPE',
	'COERCEVIAIO',
	'CASEEXPR',
	'CASEWHEN',
	'CASETESTEXPR',
	'COALESCEEXPR',
	'MINMAXEXPR',
	'SQLVALUEFUNCTION',
	'COLLATEEXPR',
	'ARRAYEXPR',
]

const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ')

/**
 * One row (`violation`) per piece of database code in `schema`: a function, operator, trigger (a foreign key's
 * excepted), rule, view, policy, domain, exclusion constraint or sequence (an identity column's excepted); an index
 * or partition key with an operator class outside `pg_catalog`; an object that depends on a type outside the schema;
 * and a default, generated column, `CHECK`, index or partition expression that holds a node, calls a function or uses
 * an operator outside the reviewed lists. Every name is qualified with `pg_catalog`, because the runner runs this with
 * the application's schema as its `search_path`.
 */
export function databaseCodeQuery(schema: string): string {
	if (!IDENTIFIER.test(schema)) throw new Error(`Invalid application schema: ${schema}`)
	const namespace = `(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = '${schema}')`
	const relations = `(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace = ${namespace})`
	return `
WITH expressions AS (
	SELECT 'default ' || c.relname || '.' || a.attname AS object, d.adbin::text AS tree
	FROM pg_catalog.pg_attrdef d
	JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
	JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
	WHERE c.relnamespace = ${namespace}
	UNION ALL
	SELECT 'constraint ' || k.conname, k.conbin::text
	FROM pg_catalog.pg_constraint k
	WHERE k.connamespace = ${namespace} AND k.conbin IS NOT NULL
	UNION ALL
	SELECT 'index ' || c.relname, pg_catalog.concat(i.indexprs::text, ' ', i.indpred::text)
	FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
	WHERE c.relnamespace = ${namespace} AND (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL)
	UNION ALL
	SELECT 'partition key of ' || c.relname, p.partexprs::text
	FROM pg_catalog.pg_partitioned_table p JOIN pg_catalog.pg_class c ON c.oid = p.partrelid
	WHERE c.relnamespace = ${namespace} AND p.partexprs IS NOT NULL
),
nodes AS (
	SELECT DISTINCT e.object, m[1] AS node FROM expressions e, pg_catalog.regexp_matches(e.tree, '\\{([A-Z_]+)', 'g') AS m
),
calls AS (
	SELECT DISTINCT e.object, m[1]::oid AS function FROM expressions e, pg_catalog.regexp_matches(e.tree, ':funcid (\\d+)', 'g') AS m
),
operators AS (
	SELECT DISTINCT e.object, m[1]::oid AS operator FROM expressions e, pg_catalog.regexp_matches(e.tree, ':opno (\\d+)', 'g') AS m
),
classes AS (
	SELECT 'index ' || c.relname AS object, k.class
	FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid, pg_catalog.unnest(i.indclass::oid[]) AS k(class)
	WHERE c.relnamespace = ${namespace}
	UNION ALL
	SELECT 'partition key of ' || c.relname, k.class
	FROM pg_catalog.pg_partitioned_table p JOIN pg_catalog.pg_class c ON c.oid = p.partrelid, pg_catalog.unnest(p.partclass::oid[]) AS k(class)
	WHERE c.relnamespace = ${namespace}
),
types AS (
	SELECT DISTINCT d.refobjid AS type
	FROM pg_catalog.pg_depend d
	WHERE d.refclassid = 'pg_catalog.pg_type'::pg_catalog.regclass AND (
		(d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid IN ${relations})
		OR (d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
			AND d.objid IN (SELECT oid FROM pg_catalog.pg_attrdef WHERE adrelid IN ${relations}))
		OR (d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
			AND d.objid IN (SELECT oid FROM pg_catalog.pg_constraint WHERE connamespace = ${namespace}))
	)
),
violations AS (
	SELECT CASE p.prokind WHEN 'a' THEN 'aggregate ' WHEN 'p' THEN 'procedure ' ELSE 'function ' END || p.proname AS violation
	FROM pg_catalog.pg_proc p WHERE p.pronamespace = ${namespace}
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
	SELECT 'exclusion constraint ' || k.conname FROM pg_catalog.pg_constraint k WHERE k.connamespace = ${namespace} AND k.contype = 'x'
	UNION ALL
	SELECT 'sequence ' || c.relname || ' (a serial column; use GENERATED ALWAYS AS IDENTITY)'
	FROM pg_catalog.pg_class c
	WHERE c.relnamespace = ${namespace} AND c.relkind = 'S' AND NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_depend d
		WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'i'
	)
	UNION ALL
	SELECT n.object || ' holds ' || n.node FROM nodes n WHERE n.node NOT IN (${list(NODES)})
	UNION ALL
	SELECT c.object || ' calls ' || COALESCE(s.nspname || '.' || p.proname, c.function::text)
	FROM calls c
	LEFT JOIN pg_catalog.pg_proc p ON p.oid = c.function
	LEFT JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
	WHERE s.nspname IS DISTINCT FROM 'pg_catalog' OR p.proname NOT IN (${list(FUNCTIONS)})
	UNION ALL
	SELECT o.object || ' uses the operator ' || COALESCE(s.nspname || '.' || p.oprname, o.operator::text)
	FROM operators o
	LEFT JOIN pg_catalog.pg_operator p ON p.oid = o.operator
	LEFT JOIN pg_catalog.pg_namespace s ON s.oid = p.oprnamespace
	WHERE s.nspname IS DISTINCT FROM 'pg_catalog' OR p.oprname NOT IN (${list(OPERATORS)})
	UNION ALL
	SELECT c.object || ' uses the operator class ' || s.nspname || '.' || o.opcname
	FROM classes c
	JOIN pg_catalog.pg_opclass o ON o.oid = c.class
	JOIN pg_catalog.pg_namespace s ON s.oid = o.opcnamespace
	WHERE s.nspname <> 'pg_catalog'
	UNION ALL
	SELECT 'the type ' || s.nspname || '.' || t.typname
	FROM types d
	JOIN pg_catalog.pg_type t ON t.oid = d.type
	JOIN pg_catalog.pg_namespace s ON s.oid = t.typnamespace
	WHERE t.typnamespace <> ${namespace}
)
SELECT DISTINCT violation FROM violations ORDER BY violation`
}

/** The message a `databaseCodeCheck` failure carries before its list of violations. */
export const DATABASE_CODE_FAILURE = 'fabrika-migration-database-code: '

/** Fails the transaction it runs in when `schema` holds database code, listing it after `DATABASE_CODE_FAILURE`. */
export function databaseCodeCheck(schema: string): string {
	return `DO $check$
DECLARE found text;
BEGIN
	SELECT pg_catalog.string_agg(violation, ', ' ORDER BY violation) INTO found FROM (${databaseCodeQuery(schema)}) AS code;
	IF found IS NOT NULL THEN RAISE EXCEPTION '${DATABASE_CODE_FAILURE}%', found; END IF;
END $check$`
}
