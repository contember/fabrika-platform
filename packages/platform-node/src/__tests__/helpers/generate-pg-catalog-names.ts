// Regenerates `src/pg-catalog-names.ts` as the union of every supported Postgres major: the first argument is the output
// path, each further one the URL of a server of one major. Run it from `packages/platform-node` with one throwaway
// container per major, then remove them; add a major here and in CI's `test` matrix together:
//   docker run --rm -d --name pgcat-17 -p 127.0.0.1:55417:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   docker run --rm -d --name pgcat-18 -p 127.0.0.1:55418:5432 -e POSTGRES_PASSWORD=postgres postgres:18
//   bun src/__tests__/helpers/generate-pg-catalog-names.ts src/pg-catalog-names.ts \
//     postgres://postgres:postgres@127.0.0.1:55417/postgres postgres://postgres:postgres@127.0.0.1:55418/postgres
//   docker rm -f pgcat-17 pgcat-18
import { SQL } from 'bun'

interface CatalogNames {
	major: number
	functions: ReadonlySet<string>
	keywords: ReadonlySet<string>
}

async function readCatalog(url: string): Promise<CatalogNames> {
	const sql = new SQL({ url, max: 1 })
	try {
		const version: { major: number }[] = await sql.unsafe("SELECT current_setting('server_version_num')::int / 10000 AS major")
		const functions: { name: string }[] = await sql.unsafe(
			"SELECT DISTINCT proname::text AS name FROM pg_catalog.pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace",
		)
		const keywords: { name: string }[] = await sql.unsafe('SELECT word AS name FROM pg_catalog.pg_get_keywords()')
		const major = version[0]?.major
		if (major === undefined) throw new Error('the server reported no version')
		return { major, functions: new Set(functions.map((row) => row.name)), keywords: new Set(keywords.map((row) => row.name)) }
	} finally {
		await sql.close()
	}
}

/** Space-separated names in byte order, wrapped at 140 characters. */
function wrap(names: Iterable<string>): string {
	const lines: string[] = []
	let line = ''
	for (const name of [...names].sort()) {
		if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`a name the generated file cannot hold: ${name}`)
		if (line.length + name.length + 1 > 140) {
			lines.push(line)
			line = ''
		}
		line = line === '' ? name : `${line} ${name}`
	}
	lines.push(line)
	return lines.join('\n')
}

function union(sets: readonly ReadonlySet<string>[]): Set<string> {
	return new Set(sets.flatMap((set) => [...set]))
}

function absentFrom(all: ReadonlySet<string>, present: ReadonlySet<string>): string[] {
	return [...all].filter((name) => !present.has(name))
}

const [outputPath, ...urls] = process.argv.slice(2)
if (outputPath === undefined || urls.length === 0) {
	throw new Error('usage: generate-pg-catalog-names.ts <output path> <url of one server per supported major>…')
}
const catalogs = (await Promise.all(urls.map(readCatalog))).sort((a, b) => a.major - b.major)
const majors = catalogs.map((catalog) => catalog.major)
if (new Set(majors).size !== majors.length) throw new Error(`two servers of one major: ${majors.join(', ')}`)

const functions = union(catalogs.map((catalog) => catalog.functions))
const keywords = union(catalogs.map((catalog) => catalog.keywords))
const absent = catalogs
	.map((catalog) =>
		`\t[${catalog.major}, {
		functions: names(\`
${wrap(absentFrom(functions, catalog.functions))}
\`),
		keywords: names(\`
${wrap(absentFrom(keywords, catalog.keywords))}
\`),
	}],`
	)
	.join('\n')

const output = `// @generated from PostgreSQL ${majors.join(' and ')} (\`pg_proc\` in \`pg_catalog\`, \`pg_get_keywords()\`) by
// \`src/__tests__/helpers/generate-pg-catalog-names.ts\`, which says how to regenerate it; \`pg-catalog-names.test.ts\` checks
// the test server against it. Each set is the union over the supported majors, so a name one of them adds is refused on all.

function names(text: string): ReadonlySet<string> {
	return new Set(text.split(/\\s+/).filter((name) => name !== ''))
}

/** The Postgres major versions the sets below are generated from. */
export const PG_CATALOG_MAJORS: readonly number[] = [${majors.join(', ')}]

/** Every function name in \`pg_catalog\`: an application function may not take one, or a call could resolve to the built-in. */
export const PG_CATALOG_FUNCTIONS: ReadonlySet<string> = names(\`
${wrap(functions)}
\`)

/** Every SQL keyword, of every category: an application function may not take one (\`operator\`, \`position\`). */
export const SQL_KEYWORDS: ReadonlySet<string> = names(\`
${wrap(keywords)}
\`)

/** Per major, the names of the sets above that its own catalog lacks. */
export const PG_CATALOG_ABSENT: ReadonlyMap<number, { functions: ReadonlySet<string>; keywords: ReadonlySet<string> }> = new Map([
${absent}
])
`
await Bun.write(outputPath, output)
