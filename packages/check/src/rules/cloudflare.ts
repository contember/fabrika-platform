import { CLOUDFLARE_MAX_JOB_SEGMENT_MS } from '@fabrika/app/contract'
import type { ContractArtifact } from '@fabrika/auth-core'
import type { ApplicationDialect } from '../dialect'
import type { Finding } from '../finding'
import { CONFIG_FILE, CONTRACT_FILE } from '../layout'

const at = (rule: 'cloudflare-scan' | 'cloudflare-job-segment', message: string, allowed: string): Finding => ({
	file: CONTRACT_FILE,
	line: 1,
	column: 1,
	severity: 'refusal',
	rule,
	message,
	allowed,
})

/** The outside calls a site declares, as the hint names them: its `egress` origins and its `connect` imports. */
const outsideCalls = (reach: { readonly egress?: readonly string[]; readonly connect: readonly string[] }): string[] => [
	...(reach.egress ?? []).map((origin) => `egress ${origin}`),
	...reach.connect.map((name) => `connect ${name}`),
]

/** A `database` in `fabrika.config.ts` that the static read cannot settle: Control could not tell which database the application runs on. */
export const cloudflareDatabaseRefusal = (message: string): Finding => ({
	file: CONFIG_FILE,
	line: 1,
	column: 1,
	severity: 'refusal',
	rule: 'cloudflare-database',
	message,
	allowed:
		"database: { kind: 'postgres', provisioningSecret: '<SECRET>' } in defineApp's argument (an object literal, directly or through a const), or no database (the Durable Object's SQLite)",
})

/**
 * What an application on Cloudflare cannot declare (ADR-0065): a file kind that scans, because no scanner runs there; a
 * job longer than one segment, because the job object runs it inside an alarm or a request, on either database. And,
 * on SQLite only, a hint for a mutation that declares an outside call: the object runs one transaction at a time, and
 * the mutation holds it while the call waits (backlog 216 item 7). On Postgres the stateless Worker serves requests.
 */
export const checkCloudflareContract = (
	artifact: ContractArtifact,
	options: { readonly database: ApplicationDialect } = { database: 'sqlite' },
): Finding[] => [
	...Object.entries(artifact.fileKinds ?? {}).filter(([, kind]) => kind.scan === true).map(([name]) =>
		at(
			'cloudflare-scan',
			`the file kind ${name} scans its files (scan: true), which an application on Cloudflare cannot: no scanner runs there`,
			`c.files({ types, maxBytes }) without scan for ${name}, and no public procedure that takes its files`,
		)
	),
	...Object.entries(artifact.jobs).filter(([, job]) => job.timeoutMs > CLOUDFLARE_MAX_JOB_SEGMENT_MS).map(([name, job]) =>
		at(
			'cloudflare-job-segment',
			`the job ${name} runs up to ${job.timeoutMs} ms, and a job segment on Cloudflare runs at most ${CLOUDFLARE_MAX_JOB_SEGMENT_MS} ms`,
			`limits.timeoutMs at most ${CLOUDFLARE_MAX_JOB_SEGMENT_MS} for ${name}: claim a bounded batch per run, and the next run takes the rest; a Workflow for one longer run is planned (backlog 230)`,
		)
	),
	...artifact.endpoints.filter((endpoint) => options.database === 'sqlite' && endpoint.kind === 'mutation').flatMap((endpoint): Finding[] => {
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
