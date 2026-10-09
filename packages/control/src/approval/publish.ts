// Publishing a run's snapshot (ADR-0050 §2): classify it against the environment's active snapshot, park a widening
// on a protected environment until a human approves it, and publish with a compare-and-swap on the generation.

import { z } from 'zod'
import { consumerEdgeProblems, ownerEdgeProblems } from '../connectors'
import type { AppEnvRow, ControlRepositories, RunRow } from '../db'
import type { CommitSource } from '../github/source/commit-files'
import { SourceFailure } from '../github/source/failure'
import type { LeaseFence } from '../lease'
import { type AccessChange, type AccessOutcome, classifyAccess } from './diff'
import { ContractMissing, readAccessSnapshot, SnapshotRefused } from './read'
import { type AccessSnapshot, type ActiveSnapshot, approvedSnapshot, parseSnapshot, serializeSnapshot, snapshotDigest } from './snapshot'

/** What a run stores after classification: the diff, and the two digests an approval is bound to. */
export interface StoredClassification {
	readonly outcome: AccessOutcome
	readonly changes: readonly AccessChange[]
	readonly candidateDigest: string
	readonly baselineDigest: string
	/** The published run the candidate was compared with; null for the empty snapshot. */
	readonly baselineRunId: string | null
	readonly protected: boolean
}

/** A human's approval of one classified change: valid only for these two digests (ADR-0050 §5). */
export interface StoredApproval {
	readonly principalId: string
	readonly label: string
	readonly approvedAt: number
	readonly candidateDigest: string
	readonly baselineDigest: string
}

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)

const classificationSchema = z.object({
	outcome: z.enum(['unchanged', 'removal', 'widening']),
	changes: z.array(z.object({ widens: z.boolean(), line: z.string() }).strict()),
	candidateDigest: digest,
	baselineDigest: digest,
	baselineRunId: z.string().min(1).nullable(),
	protected: z.boolean(),
}).strict() satisfies z.ZodType<StoredClassification>

const approvalSchema = z.object({
	principalId: z.string().min(1),
	label: z.string(),
	approvedAt: z.number().int(),
	candidateDigest: digest,
	baselineDigest: digest,
}).strict() satisfies z.ZodType<StoredApproval>

export const parseClassification = (raw: string): StoredClassification => classificationSchema.parse(JSON.parse(raw))
export const parseApproval = (raw: string): StoredApproval => approvalSchema.parse(JSON.parse(raw))

/** The steps of a deploy invocation this module needs: its fenced writes and its step boundary. */
export interface PublicationInvocation {
	readonly signal: AbortSignal
	boundary(): Promise<RunRow>
	write(mutation: (fence: LeaseFence) => Promise<boolean>): Promise<void>
	fence(): LeaseFence
}

export interface PublicationInput {
	readonly run: RunRow
	readonly app: { readonly id: string; readonly repo_url: string }
	/** The repository-relative application root the provider executes from (`ControlProvider.applicationRoot`); null is invalid. */
	readonly root: string | null
	readonly commitSha: string
	readonly sourceBinding?: { readonly connectionId: string; readonly installationId: number }
	log(line: string): void
}

export type PublicationResult =
	| { readonly kind: 'published'; readonly classification: StoredClassification }
	| { readonly kind: 'parked'; readonly classification: StoredClassification }

/** A publication that keeps losing its compare-and-swap is someone else's change landing each time; stop and retry later. */
const MAX_PUBLICATION_ATTEMPTS = 3

/**
 * Read (or reuse) the run's snapshot, classify it against the environment's active snapshot and publish it, or park the
 * run when a widening needs approval. A lost compare-and-swap classifies again against the new active snapshot, so an
 * approval for the old baseline no longer counts (ADR-0050 §2).
 */
export async function publishRunSnapshot(
	deps: { readonly repositories: ControlRepositories; readonly commits: CommitSource },
	invocation: PublicationInvocation,
	input: PublicationInput,
): Promise<PublicationResult> {
	const runs = deps.repositories.runs
	const candidate = input.run.snapshot_json === null ? await readCandidate(deps, invocation, input) : parseSnapshot(input.run.snapshot_json)
	// A run whose snapshot was stored without a contract, before those were refused, is refused like a new one.
	if (candidate.contract === null) {
		const missing = new ContractMissing()
		input.log(`access: ${missing.message}`)
		throw missing
	}
	for (let attempt = 0; attempt < MAX_PUBLICATION_ATTEMPTS; attempt++) {
		const run = await invocation.boundary()
		const appEnv = await requireAppEnv(deps.repositories, run)
		const active = approvedSnapshot(appEnv)
		await assertConnectorEdges(deps.repositories.registry, run, candidate, active, input.log)
		const classification = classify(active, candidate, appEnv)
		logClassification(input.log, classification, appEnv.env)
		const serialized = JSON.stringify(classification)
		if (classification.outcome === 'widening' && classification.protected && !approves(run, classification)) {
			await invocation.write((fence) => runs.parkRunForApproval(run.id, serialized, fence))
			input.log(`access: waiting for a human with access.approve to approve this change on \`${appEnv.env}\``)
			return { kind: 'parked', classification }
		}
		await invocation.write((fence) => runs.recordRunClassification(run.id, serialized, fence))
		const expected = { generation: active.generation, protectionRevision: appEnv.protection_revision }
		if (await runs.publishRunSnapshot(run.id, expected, serializeSnapshot(candidate), invocation.fence())) {
			input.log(`access: published as generation ${active.generation + 1} of \`${appEnv.env}\``)
			return { kind: 'published', classification }
		}
		input.log('access: another publication, registry write or protection change landed first; classifying again')
	}
	throw new Error(`run ${input.run.id} lost the publication of its snapshot ${MAX_PUBLICATION_ATTEMPTS} times`)
}

function classify(active: ActiveSnapshot, candidate: AccessSnapshot, appEnv: AppEnvRow): StoredClassification {
	return {
		...classifyAccess(active.snapshot, candidate),
		candidateDigest: snapshotDigest(candidate),
		baselineDigest: snapshotDigest(active.snapshot),
		baselineRunId: active.runId,
		protected: appEnv.protected === 1,
	}
}

async function readCandidate(
	deps: { readonly repositories: ControlRepositories; readonly commits: CommitSource },
	invocation: PublicationInvocation,
	input: PublicationInput,
): Promise<AccessSnapshot> {
	let snapshot: AccessSnapshot
	try {
		const root = input.root
		if (root === null) {
			throw new SnapshotRefused('root-invalid')
		}
		const commit = await deps.commits.open({
			repoUrl: input.app.repo_url,
			commitSha: input.commitSha,
			...(input.sourceBinding === undefined ? {} : { sourceBinding: input.sourceBinding }),
			signal: invocation.signal,
		})
		snapshot = await readAccessSnapshot(commit, root, input.app.id)
	} catch (error) {
		invocation.signal.throwIfAborted()
		if (error instanceof ContractMissing) input.log(`access: ${error.message}`)
		if (error instanceof SnapshotRefused) input.log(`access: ${error.message}; \`fabrika-check\` names the problems`)
		if (error instanceof SourceFailure) input.log(`access: the commit's files cannot be read (${error.code})`)
		throw error
	}
	await invocation.write((fence) => deps.repositories.runs.recordRunSnapshot(input.run.id, serializeSnapshot(snapshot), fence))
	return snapshot
}

/** A deploy that would break a connector edge fails, whoever approves it: the consumer would stop working. */
export class ConnectorEdgeRefused extends Error {
	constructor(readonly problems: readonly string[]) {
		super(`the deploy breaks ${problems.length} connector edge${problems.length === 1 ? '' : 's'}`)
		this.name = 'ConnectorEdgeRefused'
	}
}

async function assertConnectorEdges(
	registry: ControlRepositories['registry'],
	run: RunRow,
	candidate: AccessSnapshot,
	active: ActiveSnapshot,
	log: (line: string) => void,
): Promise<void> {
	const problems = [
		...(candidate.contract === null ? [] : await consumerEdgeProblems(registry, run.app_id, run.env, candidate.contract)),
		...await ownerEdgeProblems(registry, run.app_id, run.env, candidate.contract, active.snapshot.contract),
	]
	if (problems.length === 0) return
	for (const problem of problems) log(`access: connector: ${problem}`)
	throw new ConnectorEdgeRefused(problems)
}

/** The approval on the run counts only for the candidate and baseline it was given for. */
function approves(run: RunRow, classification: StoredClassification): boolean {
	if (run.approval_json === null) return false
	const approval = parseApproval(run.approval_json)
	return approval.candidateDigest === classification.candidateDigest && approval.baselineDigest === classification.baselineDigest
}

async function requireAppEnv(repositories: ControlRepositories, run: RunRow): Promise<AppEnvRow> {
	const appEnv = await repositories.registry.getAppEnv(run.app_id, run.env)
	if (appEnv === null) throw new Error(`app environment ${run.app_id}/${run.env} disappeared during the deploy`)
	return appEnv
}

function logClassification(log: (line: string) => void, classification: StoredClassification, env: string): void {
	const summary = classification.outcome === 'unchanged'
		? 'no access change'
		: classification.outcome === 'removal'
		? 'access only narrows'
		: `access widens${classification.protected ? ` on protected \`${env}\`` : ''}`
	const widening = classification.changes.filter((change) => change.widens).length
	// Counts only: the change lines quote the checkout, and the approval page shows them.
	log(
		`access: ${summary} (${classification.changes.length} changes, ${widening} widening; against ${
			classification.baselineRunId === null ? 'nothing published' : `run ${classification.baselineRunId}`
		})`,
	)
}
