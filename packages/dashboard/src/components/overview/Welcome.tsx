import { Link } from '@buzola/router'
import { BrandMark, Icon } from '../Icon'

export function Welcome({ hasNamespace }: { hasNamespace: boolean }) {
	return (
		<>
			<section className="welcome">
				<div className="welcome-copy">
					<p className="welcome-eyebrow">fabrika console</p>
					<h1>
						Build.<br />Run.<br />Scale.
					</h1>
					<p>
						fabrika takes an application from a git push to a running service behind one gate, and keeps watch on it afterwards. Two steps put the first
						release through it.
					</p>
					<div className="welcome-actions">
						{hasNamespace
							? (
								<Link to="apps/new" className="btn primary">
									<Icon name="plus" />New application
								</Link>
							)
							: (
								<Link to="namespaces/create" className="btn primary">
									<Icon name="plus" />Provision a namespace
								</Link>
							)}
					</div>
				</div>
				<div className="welcome-art" aria-hidden="true">
					<BrandMark size={220} />
				</div>
			</section>
			<div className="welcome-steps">
				<section className="card">
					<div className="card-head">
						<Icon name="bay" size={18} />
						<h2>1 · Open a namespace</h2>
					</div>
					<div className="card-body">
						<p className="hint">
							A deployment namespace is the bounded area on the provider where apps get placed. Provision one per environment before onboarding anything into
							it.
						</p>
						<div className="form-actions">
							<Link to="namespaces" className="btn">See namespaces</Link>
						</div>
					</div>
				</section>
				<section className="card">
					<div className="card-head">
						<Icon name="app" size={18} />
						<h2>2 · Onboard an app</h2>
					</div>
					<div className="card-body">
						<p className="hint">Point fabrika at a GitHub repo, pick the namespace it deploys into, and let its first push deploy it.</p>
						<div className="form-actions">
							<Link to="apps/new" className="btn">Onboard an app</Link>
						</div>
					</div>
				</section>
			</div>
		</>
	)
}
