import { Link } from '@buzola/router'
import { SURFACE_REACHES, type SurfaceReach } from '@fabrika/control-contract'
import type { AppEnvDto, SurfaceEndpointDto } from '../../lib/api'
import { Chip } from '../Status'
import { Table } from '../Table'
import { Words } from '../Words'

const REACH_LABELS: Record<SurfaceReach, string> = {
	anyone: 'anyone',
	link: 'share links',
	app: 'other apps',
	machine: 'machines',
	human: 'signed-in people',
}

/** What one environment's published access serves to the outside, most exposed first. */
export function SurfaceSection({ env }: { env: AppEnvDto }) {
	return (
		<section>
			<div className="section-head">
				<h2>Endpoints</h2>
			</div>
			<p className="section-note">What {env.env} serves, by the most exposed caller that reaches each endpoint. The proxy refuses every other path.</p>
			{env.surface.length === 0 ? <p className="muted">Nothing is published on {env.env} yet.</p> : <EnvironmentSurface env={env} />}
		</section>
	)
}

/** `3 for anyone · 12 for signed-in people`, in reach order, naming only the reaches the surface has. */
export function surfaceSummary(surface: readonly SurfaceEndpointDto[]): string {
	return SURFACE_REACHES
		.map((reach) => ({ reach, count: surface.filter((endpoint) => endpoint.reach === reach).length }))
		.filter(({ count }) => count > 0)
		.map(({ reach, count }) => `${count} for ${REACH_LABELS[reach]}`)
		.join(' · ')
}

/** The reaches open to the public; their endpoints stay in view, the rest fold under a count. */
const PUBLIC_REACHES: readonly SurfaceReach[] = ['anyone', 'link']

function EnvironmentSurface({ env }: { env: AppEnvDto }) {
	const open = env.surface.filter((endpoint) => PUBLIC_REACHES.includes(endpoint.reach))
	const rest = env.surface.filter((endpoint) => !PUBLIC_REACHES.includes(endpoint.reach))
	return (
		<>
			<p className="surface-summary">
				{env.domain !== null && <code>{env.domain}</code>}
				<span>
					{surfaceSummary(env.surface)}
					{env.publishedRunId !== null && (
						<>
							{', published by '}
							<Link to="runs/detail" params={{ id: env.publishedRunId }}>
								run <code>{env.publishedRunId.slice(0, 8)}</code>
							</Link>
						</>
					)}
				</span>
			</p>
			{open.length > 0 && <SurfaceTable endpoints={open} />}
			{rest.length > 0 && (
				<details className="surface">
					<summary>
						{open.length === 0 ? 'Show' : 'Show the other'} {rest.length === 1 ? '1 endpoint' : `${rest.length} endpoints`}, for{' '}
						{SURFACE_REACHES.filter((reach) => rest.some((endpoint) => endpoint.reach === reach)).map((reach) => REACH_LABELS[reach]).join(' and ')}
					</summary>
					<SurfaceTable endpoints={rest} />
				</details>
			)}
		</>
	)
}

function SurfaceTable({ endpoints }: { endpoints: readonly SurfaceEndpointDto[] }) {
	return (
		<Table
			colSpan={4}
			head={
				<tr>
					<th>Reached by</th>
					<th>Endpoint</th>
					<th>Requires</th>
					<th className="grow">Opens it further</th>
				</tr>
			}
		>
			{endpoints.map((endpoint) => <SurfaceRow key={endpoint.id} endpoint={endpoint} />)}
		</Table>
	)
}

function SurfaceRow({ endpoint }: { endpoint: SurfaceEndpointDto }) {
	return (
		<tr>
			<td>
				<Chip accent={endpoint.reach === 'anyone'}>{REACH_LABELS[endpoint.reach]}</Chip>
			</td>
			<td>
				<code>
					{endpoint.method} {endpoint.path}
				</code>{' '}
				<span className="muted small">{endpoint.kind}</span>
			</td>
			<td>
				{endpoint.requirement === null ? <span className="muted">nothing</span> : (
					<>
						<span className="muted small">{endpoint.callers.join(', ')}</span> <Words text={endpoint.requirement} />
					</>
				)}
			</td>
			<td>
				{endpoint.notes.length === 0
					? <span className="muted">—</span>
					: endpoint.notes.map((note, index) => (
						<span key={`${index}:${note}`}>
							{index > 0 && ' · '}
							<Words text={note} />
						</span>
					))}
			</td>
		</tr>
	)
}
