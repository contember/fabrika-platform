import { createPage, Link } from '@buzola/router'
import type { ExternalAppDto, OAuthClientDto } from '@fabrika/iam-contract'
import { api } from '../../../access/lib/api'
import { Icon } from '../../../components/Icon'
import { Chip } from '../../../components/Status'
import { EmptyState, Table } from '../../../components/Table'
import { fmtAgo, fmtDate } from '../../../lib/format'

// Applications outside the installation that sign people in through IAM (ADR-0089): an installation administrator
// registers them here, with no deploy. The MCP authoring clients are listed read-only: only the operator's provisioning
// key writes them, because their tokens reach `/mcp`.

export default createPage()
	.loader(async () => {
		const [apps, clients] = await Promise.all([api.externalApps.list(), api.oauthClients.list()])
		return { apps: apps.items, authoring: clients.items.filter((client) => client.externalApp === null) }
	})
	.route('/access/external-apps')
	.render(({ data }) => (
		<>
			<div className="page-head">
				<div className="page-head-row">
					<div>
						<h1>External applications</h1>
						<p className="hint">Applications outside this installation that sign people in through IAM. Registering one needs no deploy.</p>
					</div>
					<Link to="access/external-apps/new" className="btn primary">
						<Icon name="plus" />
						Register application
					</Link>
				</div>
			</div>

			<Table
				colSpan={4}
				isEmpty={data.apps.length === 0}
				empty={
					<EmptyState
						icon="external"
						title="No external applications yet"
						body="Register an application that signs people in through this installation's IAM, with its roles and OAuth clients."
						action={<Link to="access/external-apps/new" className="btn small">Register the first one</Link>}
					/>
				}
				head={
					<tr>
						<th className="grow">Application</th>
						<th>Roles</th>
						<th>Clients</th>
						<th>Changed</th>
					</tr>
				}
			>
				{data.apps.map((app) => <ExternalAppRow key={app.app} app={app} />)}
			</Table>

			<section>
				<div className="section-head">
					<Icon name="terminal" size={15} />
					<h2>Authoring clients</h2>
				</div>
				<p className="section-note">
					MCP clients that author applications through the console's <code>/mcp</code>. Only the operator registers them, with the provisioning key:{' '}
					<code>fabrika control oauth-clients put</code>.
				</p>
				<Table
					colSpan={3}
					isEmpty={data.authoring.length === 0}
					empty={<EmptyState title="No authoring clients" body="The operator has registered no MCP authoring client on this installation." />}
					head={
						<tr>
							<th className="grow">Client</th>
							<th>Kind</th>
							<th>Changed</th>
						</tr>
					}
				>
					{data.authoring.map((client) => <AuthoringClientRow key={client.clientId} client={client} />)}
				</Table>
			</section>
		</>
	))

function ExternalAppRow({ app }: { app: ExternalAppDto }) {
	return (
		<tr>
			<td>
				<Link to="access/external-apps/detail" params={{ app: app.app }}>
					<strong>{app.name ?? app.app}</strong>
				</Link>
				<div className="muted small">
					<code>{app.app}</code> · <code>{app.resource}</code>
				</div>
			</td>
			<td className="nowrap">
				{app.roles === null
					? <span className="muted" title="Every active user of the installation signs in">none</span>
					: app.roles.length}
			</td>
			<td className="nowrap">{app.clients.length === 0 ? <span className="muted">none</span> : app.clients.length}</td>
			<td className="muted small nowrap" title={fmtDate(app.updatedAt)}>{fmtAgo(app.updatedAt)}</td>
		</tr>
	)
}

function AuthoringClientRow({ client }: { client: OAuthClientDto }) {
	return (
		<tr>
			<td>
				<code className="small">{client.clientId}</code>
				<div className="muted small">
					{client.redirectUris.length === 1 ? '1 redirect URI' : `${client.redirectUris.length} redirect URIs`}
				</div>
			</td>
			<td>
				<Chip>{CLIENT_KINDS[client.label]}</Chip>
			</td>
			<td className="muted small nowrap" title={fmtDate(client.updatedAt)}>{fmtAgo(client.updatedAt)}</td>
		</tr>
	)
}

const CLIENT_KINDS: Record<OAuthClientDto['label'], string> = { claude: 'Claude', chatgpt: 'ChatGPT', external: 'Other' }
