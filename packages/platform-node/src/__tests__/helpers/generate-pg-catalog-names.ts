// Regenerates `src/pg-catalog-names.ts` from a Postgres: the URL is the test server's, the argument the output path.
//   FABRIKA_TEST_POSTGRES_URL=… bun src/__tests__/helpers/generate-pg-catalog-names.ts src/pg-catalog-names.ts
import { SQL } from 'bun'

const sql = new SQL({ url: process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '', max: 1 })
const functions: { proname: string }[] = await sql.unsafe(
	"SELECT DISTINCT proname::text AS proname FROM pg_catalog.pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace ORDER BY 1",
)
const keywords: { word: string }[] = await sql.unsafe('SELECT word FROM pg_catalog.pg_get_keywords() ORDER BY 1')
await sql.close()

/** Space-separated names, wrapped at 140 characters. */
function wrap(words: readonly string[]): string {
	const lines: string[] = []
	let line = ''
	for (const word of words) {
		if (!/^[A-Za-z0-9_]+$/.test(word)) throw new Error(`a name the generated file cannot hold: ${word}`)
		if (line.length + word.length + 1 > 140) {
			lines.push(line)
			line = ''
		}
		line = line === '' ? word : `${line} ${word}`
	}
	lines.push(line)
	return lines.join('\n')
}

const output = `// @generated from PostgreSQL 17 (\`pg_proc\` in \`pg_catalog\`, \`pg_get_keywords()\`) by
// \`src/__tests__/helpers/generate-pg-catalog-names.ts\`; \`pg-catalog-names.test.ts\` checks the test server against it. A
// name a later Postgres adds is caught at the catalog check, which refuses an application function that shadows one.

/** Every function name in \`pg_catalog\`: an application function may not take one, or a call could resolve to the built-in. */
export const PG_CATALOG_FUNCTIONS: ReadonlySet<string> = new Set(
	\`
${wrap(functions.map((row) => row.proname))}
\`.split(/\\s+/).filter((name) => name !== ''),
)

/** Every SQL keyword, of every category: an application function may not take one (\`operator\`, \`position\`). */
export const SQL_KEYWORDS: ReadonlySet<string> = new Set(
	\`
${wrap(keywords.map((row) => row.word))}
\`.split(/\\s+/).filter((name) => name !== ''),
)
`
await Bun.write(process.argv[2] ?? 'src/pg-catalog-names.ts', output)
