import type { ContractArtifact } from '@fabrika/auth-core'
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

/**
 * What an application on Cloudflare cannot declare (ADR-0065): raw SQL, because a Durable Object's SQLite has no role
 * under it and the classifier reads Postgres's lexical rules; a file kind that scans, because no scanner runs there.
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
]
