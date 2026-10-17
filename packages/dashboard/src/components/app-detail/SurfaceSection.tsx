import { Link } from '@buzola/router'
import { SURFACE_REACHES, type SurfaceReach } from '@fabrika/control-contract'
import type { AppEnvDto, SurfaceEndpointDto } from '../../lib/api'
import { Icon } from '../Icon'
import { Chip } from '../Status'
import { Table } from '../Table'

const REACH_LABELS: Record<SurfaceReach, string> = {
	anyone: 'anyone',
	link: 'share links',
	app: 'other apps',
	machine: 'machines',
	human: 'signed-in people',
}

/** What each environment's published access serves to the outside, most exposed first. Nothing until a run publishes. */
export function SurfaceSection({ envs }: { envs: readonly AppEnvDto[] }) {
	const listed = envs.filter((env) => env.surface.length > 0)
	if (listed.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<Icon name="globe" size={15} />
				<h2>Surface</h2>
			</div>
			<p className="hint">
				Every endpoint each environment's published access serves, listed under the most exposed caller that reaches it. The proxy refuses every other
				path. A deploy that opens a new one waits for approval on a protected environment.
			</p>
			{listed.map((env) => <EnvironmentSurface key={env.env} env={env} />)}
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

function EnvironmentSurface({ env }: { env: AppEnvDto }) {
	return (
		<details className="surface">
			<summary>
				<Chip>{env.env}</Chip>
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
			</summary>
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
				{env.surface.map((endpoint) => <SurfaceRow key={endpoint.id} endpoint={endpoint} />)}
			</Table>
		</details>
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
						<span className="muted small">{endpoint.callers.join(', ')}</span> {endpoint.requirement}
					</>
				)}
			</td>
			<td>{endpoint.notes.length === 0 ? <span className="muted">—</span> : endpoint.notes.join(' · ')}</td>
		</tr>
	)
}
