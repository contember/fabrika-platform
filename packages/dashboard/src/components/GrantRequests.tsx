import { RpcError } from '@fabrika/app'
import type { GrantRequestDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { fmtAgo, fmtDate } from '../lib/format'
import { quietIamClient } from '../lib/iam'
import { Chip } from './Status'
import { EmptyState, Table } from './Table'

const KIND_WORDS: Record<GrantRequestDto['kind'], string> = { create: 'Grant', update: 'Change grant to', revoke: 'Revoke' }

/** What the request changes, in one line: the role or the actions, and where. */
export function grantRequestChange(request: GrantRequestDto): string {
	const what = request.roleKey !== null ? `role ${request.roleKey}` : `actions ${(request.permissions ?? []).join(', ')}`
	const where = request.scopeType === null ? 'app-wide' : `in ${request.scopeType} ${request.scopeValue ?? ''}`
	return `${KIND_WORDS[request.kind]} ${what} ${where}`
}

/**
 * The grant requests the viewer administers (ADR-0083 §4): each waits for an administrator other than its requester.
 * IAM decides who may approve and runs the change's checks again; the page only asks.
 */
export function GrantRequests({ initial, viewerId }: { initial: readonly GrantRequestDto[]; viewerId: string | null }) {
	const [requests, setRequests] = useState<readonly GrantRequestDto[]>(initial)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	async function decide(request: GrantRequestDto, decision: 'approve' | 'reject') {
		setBusy(request.id)
		setError(null)
		try {
			await quietIamClient(fetch).grantRequests.decide({ id: request.id, decision })
			setRequests((current) => current.filter((other) => other.id !== request.id))
		} catch (cause) {
			setError(cause instanceof RpcError ? cause.message : 'Deciding the request failed.')
		} finally {
			setBusy(null)
		}
	}

	return (
		<section>
			<div className="section-head">
				<h2>Grant requests</h2>
			</div>
			<p className="hint">
				Console grants and revocations at an environment that approves them. Nothing changes until another administrator of the application approves; the
				requester may withdraw their own.
			</p>
			{error && <div className="error-text small" role="alert">{error}</div>}
			<Table
				colSpan={5}
				isEmpty={requests.length === 0}
				empty={<EmptyState icon="shield" title="No grant waits for approval" body="An environment that approves console grants lists them here." />}
				head={
					<tr>
						<th>App</th>
						<th className="grow">Change</th>
						<th>Requested by</th>
						<th>Expires</th>
						<th />
					</tr>
				}
			>
				{requests.map((request) => {
					const own = request.requestedBy === viewerId
					return (
						<tr key={request.id}>
							<td>
								<Chip>{request.app}</Chip>
							</td>
							<td>
								<div className="cell-stack">
									<span>{grantRequestChange(request)}</span>
									<span className="muted small">for {request.principalLabel ?? request.principalId}</span>
								</div>
							</td>
							<td className="small" title={fmtDate(request.requestedAt)}>
								{request.requestedByLabel ?? request.requestedBy} · {fmtAgo(request.requestedAt)}
							</td>
							<td className="muted small" title={fmtDate(request.expiresAt)}>{fmtDate(request.expiresAt)}</td>
							<td>
								<div className="row-actions">
									{!own && (
										<button type="button" className="btn small" disabled={busy !== null} onClick={() => void decide(request, 'approve')}>
											Approve
										</button>
									)}
									<button type="button" className="btn small" disabled={busy !== null} onClick={() => void decide(request, 'reject')}>
										{own ? 'Withdraw' : 'Reject'}
									</button>
								</div>
							</td>
						</tr>
					)
				})}
			</Table>
		</section>
	)
}
