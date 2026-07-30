import type { DeploymentNamespacePresentationDto, DeploymentNamespaceState } from '../lib/api'
import { NamespaceState } from './Status'

interface NamespaceSignatureProps {
	id: string
	env: string
	provider: string
	exclusiveAppId: string | null
	state?: DeploymentNamespaceState
	presentation: DeploymentNamespacePresentationDto | null
}

/** The four facts fabrika states itself; a provider fact repeating one of them is dropped, not shown twice. */
const OWN_LABELS = new Set(['namespace', 'environment', 'provider', 'ownership', 'placement'])

/** Compact provider-authored ledger of one placement boundary. */
export function NamespaceSignature(
	{ id, env, provider, exclusiveAppId, state, presentation }: NamespaceSignatureProps,
) {
	const facts = (presentation?.facts ?? []).filter((fact) => !OWN_LABELS.has(fact.label.trim().toLowerCase()))

	return (
		<div className="namespace-signature">
			<div className="namespace-signature-head">
				<div>
					<div className="namespace-signature-kicker">{presentation?.preset ?? 'provider'} placement</div>
					<strong>{presentation?.title ?? 'Deployment namespace'}</strong>
				</div>
				{state !== undefined && <NamespaceState state={state} />}
			</div>
			<dl className="namespace-ledger">
				<div>
					<dt>Namespace</dt>
					<dd>
						<code>{id}</code>
					</dd>
				</div>
				<div>
					<dt>Environment</dt>
					<dd>
						<code>{env}</code>
					</dd>
				</div>
				<div>
					<dt>Provider</dt>
					<dd>
						<code>{provider}</code>
					</dd>
				</div>
				<div>
					<dt>Ownership</dt>
					<dd>
						{exclusiveAppId === null ? 'Shared' : (
							<>
								<code>{exclusiveAppId}</code> only
							</>
						)}
					</dd>
				</div>
				{facts.map((fact) => (
					<div key={`${fact.label}/${fact.value}`}>
						<dt>{fact.label}</dt>
						<dd>{fact.value}</dd>
					</div>
				))}
			</dl>
			{presentation !== null && presentation.instructions.length > 0 && (
				<div className="namespace-instructions">
					<h4>Operator instructions</h4>
					<ol>
						{presentation.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}
					</ol>
				</div>
			)}
		</div>
	)
}
