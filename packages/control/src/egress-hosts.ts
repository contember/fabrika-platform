// The installation's own hosts, which a cron job's public egress refuses (ADR-0070). An application knows the hosts its
// framework variables name (IAM, Operations, its own origin); Control adds the ones it does not: Control's own and every
// application environment's domain and public origin. A deploy writes them as `FABRIKA_EGRESS_REFUSED_HOSTS`, only for
// a contract with such a job, and removes them from one without.

import { type ContractArtifact, normalizedHost, PUBLIC_EGRESS } from '@fabrika/auth-core'
import type { AppEnvRow } from './db/registry-types'

/** Whether some cron job of the approved contract declares `egress: 'public'`. */
export function declaresPublicEgress(contract: ContractArtifact | null): boolean {
	return Object.values(contract?.declared ?? {}).some((reach) => reach.egress === PUBLIC_EGRESS)
}

/**
 * The hosts of `origins` (Control's, IAM's, Operations', each an origin or a URL) and of every environment's domain and
 * public origin, normalized, sorted and joined by `,`. A value that names no host is skipped.
 */
export function installationHosts(
	origins: readonly (string | null | undefined)[],
	environments: readonly Pick<AppEnvRow, 'domain' | 'public_origin'>[],
): string {
	const hosts = new Set<string>()
	const add = (host: string): void => {
		const normalized = normalizedHost(host.trim())
		if (normalized !== '' && /^[a-z0-9.-]+$/.test(normalized)) hosts.add(normalized)
	}
	const addUrl = (value: string | null | undefined): void => {
		if (value === null || value === undefined || value.trim() === '') return
		try {
			add(new URL(value.trim()).hostname)
		} catch {
			// Not a URL: it names no host.
		}
	}
	for (const origin of origins) addUrl(origin)
	for (const environment of environments) {
		if (environment.domain !== null) add(environment.domain)
		addUrl(environment.public_origin)
	}
	return [...hosts].sort().join(',')
}
