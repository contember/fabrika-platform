import { type ContractArtifact, type DeclaredEgress, PUBLIC_EGRESS } from '@fabrika/auth-core'
import type { Finding } from '../finding'
import { CONTRACT_FILE } from '../layout'

const at = (rule: 'cloudflare-sql' | 'cloudflare-scan', message: string, allowed: string): Finding => ({
	file: CONTRACT_FILE,
	line: 1,
	column: 1,
	severity: 'refusal',
	rule,
	message,
	allowed,
})

/** The outside calls a site declares, as the hint names them: its `egress` origins and its `connect` imports. */
const outsideCalls = (reach: { readonly egress?: DeclaredEgress; readonly connect: readonly string[] }): string[] => [
	...(reach.egress === PUBLIC_EGRESS ? [`egress '${PUBLIC_EGRESS}'`] : (reach.egress ?? []).map((origin) => `egress ${origin}`)),
	...reach.connect.map((name) => `connect ${name}`),
]

/**
 * What an application on Cloudflare cannot declare (ADR-0065): raw SQL, because a Durable Object's SQLite has no role
 * under it and the classifier reads Postgres's lexical rules; a file kind that scans, because no scanner runs there.
 * And a hint for a mutation that declares an outside call: the object runs one transaction at a time, and the mutation
 * holds it while the call waits (backlog 216 item 7).
 */
export const checkCloudflareContract = (artifact: ContractArtifact): Finding[] => [
	...Object.entries(artifact.declared ?? {}).filter(([, reach]) => reach.sql !== null).map(([site]) =>
		at(
			'cloudflare-sql',
			`${site} declares sql, which an application on Cloudflare cannot run: its SQLite database has no role to bound raw SQL`,
			'ctx.db and its stores, without sql in the site options',
		)
	),
	...Object.entries(artifact.fileKinds ?? {}).filter(([, kind]) => kind.scan === true).map(([name]) =>
		at(
			'cloudflare-scan',
			`the file kind ${name} scans its files (scan: true), which an application on Cloudflare cannot: no scanner runs there`,
			`c.files({ types, maxBytes }) without scan for ${name}, and no public procedure that takes its files`,
		)
	),
	...artifact.endpoints.filter((endpoint) => endpoint.kind === 'mutation').flatMap((endpoint): Finding[] => {
		const reach = artifact.declared?.[endpoint.id]
		const calls = reach === undefined ? [] : outsideCalls(reach)
		if (calls.length === 0) return []
		return [{
			file: CONTRACT_FILE,
			line: 1,
			column: 1,
			severity: 'hint',
			rule: 'cloudflare-held-call',
			message: `${endpoint.id} is a mutation that declares ${
				calls.join(', ')
			}: on Cloudflare it waits for that call inside the object's transaction, which holds the whole environment`,
			allowed: "record a row and ctx.kick('<job>'); the job declares the call and makes it outside ctx.transaction",
		}]
	}),
]
