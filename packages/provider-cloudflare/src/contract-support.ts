import type { ContractArtifact } from '@fabrika/auth-core'

// Imported by `./control` (the `./runner` entry), so it stays clear of `oblaka-iac`.

/**
 * Refuse what a contract declares that an application on Cloudflare cannot run yet (ADR-0065): a file kind that scans
 * its uploads, and raw SQL (`ctx.sql`).
 */
export const assertCloudflareContract = (contract: ContractArtifact): void => {
	for (const [name, kind] of Object.entries(contract.fileKinds ?? {})) {
		if (kind.scan === true) {
			throw new Error(`cloudflare: file kind \`${name}\` scans its uploads (\`scan: true\`), and no scanner runs on Cloudflare yet`)
		}
	}
	for (const [name, collection] of Object.entries(contract.files)) {
		if (collection.scan === true) {
			throw new Error(`cloudflare: file collection \`${name}\` scans its uploads (\`scan: true\`), and no scanner runs on Cloudflare yet`)
		}
	}
	for (const [site, reach] of Object.entries(contract.declared ?? {})) {
		if (reach.sql !== null) {
			throw new Error(
				`cloudflare: \`${site}\` declares raw SQL (\`ctx.sql\`), which an application on Cloudflare cannot run: its SQLite has no runtime role to bound it`,
			)
		}
	}
}

/** The object runs due jobs and the file sweep, a framework job, on the Worker's minute tick (ADR-0065 §5). */
export const needsMinuteTick = (contract: ContractArtifact): boolean =>
	Object.keys(contract.jobs).length > 0 || Object.keys(contract.files).length > 0 || Object.keys(contract.fileKinds ?? {}).length > 0
