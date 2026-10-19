// The workloads of a contract (ADR-0022 "Principal kinds"): each job, each webhook and each public procedure holds a key
// of its own, which Control issues from the approved artifact and IAM resolves to the actions the workload declares.
// IAM's schema, Control's keys and the application's boot all enumerate them here, so they cannot disagree.

import type { ContractArtifact } from './contract'
import type { OwnWorkloadKind } from './framework-variables'

/** A job or webhook name of a contract. */
export const WORKLOAD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * A public procedure's workload name: its full endpoint id, `<mount>.<group>.<procedure>`, so one group mounted twice
 * holds two workloads and never merges their authority.
 */
export const PUBLIC_WORKLOAD_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/

/** IAM stores the name in the principal's external id, and the token carries it. */
export const MAX_PUBLIC_WORKLOAD_NAME_LENGTH = 128

/** Whether `name` names a workload of an application's own `kind`. */
export function isOwnWorkloadName(kind: OwnWorkloadKind, name: string): boolean {
	return kind === 'public' ? name.length <= MAX_PUBLIC_WORKLOAD_NAME_LENGTH && PUBLIC_WORKLOAD_NAME.test(name) : WORKLOAD_NAME.test(name)
}

/** One workload the contract declares: what IAM stores, what its key is named after and what its token carries. */
export interface ContractWorkload {
	readonly kind: OwnWorkloadKind
	readonly name: string
	/** The workload's declared actions, sorted. */
	readonly actions: readonly string[]
}

/**
 * Every workload of `artifact`: its jobs, its webhooks, and each endpoint whose declared reach names `actions` — a public
 * procedure, which runs as its own workload.
 */
export function contractWorkloads(artifact: Pick<ContractArtifact, 'jobs' | 'mounts' | 'declared'>): readonly ContractWorkload[] {
	const sorted = (actions: readonly string[]): readonly string[] => [...actions].sort()
	const jobs = Object.entries(artifact.jobs).map(([name, job]): ContractWorkload => ({ kind: 'job', name, actions: sorted(job.actions) }))
	const webhooks = Object.entries(artifact.mounts).flatMap(([name, mount]): ContractWorkload[] =>
		mount.kind === 'webhook' ? [{ kind: 'webhook', name, actions: sorted(mount.actions) }] : []
	)
	const procedures = Object.entries(artifact.declared ?? {}).flatMap(([endpoint, reach]): ContractWorkload[] =>
		reach.actions === undefined ? [] : [{ kind: 'public', name: endpoint, actions: sorted(reach.actions) }]
	)
	return [...jobs, ...webhooks, ...procedures]
}
