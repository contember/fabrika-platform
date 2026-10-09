// Publishing a run's snapshot (ADR-0050 §2): classify it against the environment's active snapshot, park a widening
// on a protected environment until a human approves it, and publish with a compare-and-swap on the generation.

import { type ArtifactAccess, artifactAccessDigest } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import type { ProviderArtifactAccessReport } from '@fabrika/provider-contract'
import { z } from 'zod'
import type { AppEnvRow, ControlRepositories, RunRow } from '../db'
import type { CommitSource } from '../github/source/commit-files'
import { SourceFailure } from '../github/source/failure'
import type { LeaseFence } from '../lease'
import { type AccessChange, type AccessOutcome, classifyAccess } from './diff'
import { readAccessSnapshot, SnapshotRefused } from './read'
import {
	type AccessSnapshot,
	type ActiveSnapshot,
	approvedSnapshot,
	artifactAccessSchema,
	parseSnapshot,
	serializeSnapshot,
	snapshotDigest,
} from './snapshot'

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
	/** The provider's reading of an environment's artifact access (`ControlProvider.artifactAccess`), when it has one. */
	readonly artifactAccess?: (appEnv: AppEnvRow) => ArtifactAccess
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
	const commit = input.run.snapshot_json === null ? await readCandidate(deps, invocation, input) : parseSnapshot(input.run.snapshot_json)
	for (let attempt = 0; attempt < MAX_PUBLICATION_ATTEMPTS; attempt++) {
		const run = await invocation.boundary()
		const appEnv = await requireAppEnv(deps.repositories, run)
		const active = approvedSnapshot(appEnv)
		const candidate = candidateAgainst(commit, run, active, appEnv, input.artifactAccess)
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

/**
 * The run's candidate against this active snapshot: the commit's snapshot and, without a contract, the artifact access.
 * That is the provider's reading of the registry's artifact; else the access a deploy reported waiting for this run;
 * else, for a provider that learns it only while it deploys, the approved one, which the deploy checks against.
 */
function candidateAgainst(
	commit: AccessSnapshot,
	run: RunRow,
	active: ActiveSnapshot,
	appEnv: AppEnvRow,
	readArtifact: PublicationInput['artifactAccess'],
): AccessSnapshot {
	if (commit.contract !== null) return { ...commit, artifact: null }
	if (readArtifact !== undefined) return { ...commit, artifact: readArtifact(appEnv) }
	if (run.pending_access_json !== null) return { ...commit, artifact: artifactAccessSchema.parse(JSON.parse(run.pending_access_json)) }
	return { ...commit, artifact: active.snapshot.artifact }
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

/**
 * Settle what a deploy reported about the artifact access (ADR-0050), before the run is marked terminal. `pending`: the
 * deploy stopped before provisioning, and a new run waits for a human with that access as its candidate; approving it
 * deploys the approved access. A new run, so the provider never sees a run id twice. `deployed`: on an unprotected
 * environment the run's publication takes the access it applied. Returns the parked run's id, or null.
 */
export async function settleArtifactAccessReport(
	repositories: ControlRepositories,
	invocation: Pick<PublicationInvocation, 'write' | 'fence'>,
	run: RunRow,
	report: ProviderArtifactAccessReport,
	log: (line: string) => void,
): Promise<string | null> {
	const appEnv = await requireAppEnv(repositories, run)
	const active = approvedSnapshot(appEnv)
	if (report.state === 'pending') {
		if (run.snapshot_json === null) throw new Error(`run ${run.id} reported artifact access without a snapshot`)
		const candidate: AccessSnapshot = { ...parseSnapshot(run.snapshot_json), artifact: report.access }
		const classification = classify(active, candidate, appEnv)
		const id = uuidv7()
		await invocation.write(async (fence) =>
			(await repositories.runs.createParkedRun(
				{ id, from: run, classificationJson: JSON.stringify(classification), pendingAccessJson: JSON.stringify(report.access) },
				fence,
			)) !== null
		)
		log(
			`access: the artifact's gates and IAM schema changed (${classification.changes.length} changes); run ${id} waits for a human with access.approve`,
		)
		return id
	}
	const approved = active.snapshot.artifact
	if (active.runId !== run.id || active.snapshot.contract !== null) return null
	if (approved !== null && artifactAccessDigest(approved) === artifactAccessDigest(report.access)) return null
	const expected = { generation: active.generation, protectionRevision: appEnv.protection_revision }
	const recorded = appEnv.protected === 0
		&& await repositories.runs.recordDeployedArtifactAccess(
			run.id,
			expected,
			serializeSnapshot({ ...active.snapshot, artifact: report.access }),
			invocation.fence(),
		)
	log(
		recorded
			? "access: recorded the artifact's gates and IAM schema this deploy applied"
			: "access: the artifact's gates and IAM schema this deploy applied are not recorded; the next deploy compares against the approved ones",
	)
	return null
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
		if (error instanceof SnapshotRefused) input.log(`access: ${error.message}; \`fabrika-check\` names the problems`)
		if (error instanceof SourceFailure) input.log(`access: the commit's files cannot be read (${error.code})`)
		throw error
	}
	await invocation.write((fence) => deps.repositories.runs.recordRunSnapshot(input.run.id, serializeSnapshot(snapshot), fence))
	return snapshot
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
