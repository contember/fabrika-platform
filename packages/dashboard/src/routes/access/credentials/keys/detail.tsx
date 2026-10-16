import { createPage, Link } from '@buzola/router'
import { GrantRow, GrantTableHead } from '../../../../access/components/GrantRow'
import { api } from '../../../../access/lib/api'
import { AppName } from '../../../../access/lib/app-names'
import { fmtExpiry } from '../../../../access/lib/format'
import { Icon } from '../../../../components/Icon'
import { PrincipalStatus } from '../../../../components/Status'
import { EmptyState, Table } from '../../../../components/Table'
import { fmtDate } from '../../../../lib/format'

/**
 * One API key and what it may do. Its permissions are its service principal's grants, so changing them is a grant
 * write: the key keeps its secret and nobody redistributes it.
 */
export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => ({ apiKey: await api.apiKeys.get({ principalId: params.id }) }))
	.route('/access/credentials/keys/:id')
	.render(({ data, invalidate }) => {
		const { apiKey } = data
		const { credential } = apiKey
		const editable = apiKey.status !== 'disabled' && credential !== null

		return (
			<>
				<div className="page-head">
					<Link to="access/credentials" className="back-link">
						<Icon name="chevron-left" size={14} />
						All credentials
					</Link>
					<div className="page-head-row">
						<h1>{apiKey.label}</h1>
						<PrincipalStatus status={apiKey.status} />
					</div>
					<div className="subtitle">
						<span>
							{credential === null
								? 'No live key'
								: credential.app === null
								? 'Mints tokens for every app'
								: (
									<>
										Mints tokens for <AppName app={credential.app} />
									</>
								)}
						</span>
						{credential !== null && <span className="dot-sep">key expires {fmtExpiry(credential.expiresAt).toLowerCase()}</span>}
						<span className="dot-sep">created {fmtDate(apiKey.createdAt)}</span>
					</div>
				</div>

				<section>
					<div className="section-head">
						<Icon name="shield" size={15} />
						<h2>Grants</h2>
						<span className="spacer" />
						{editable && <Link to="access/credentials/keys/grant" params={{ id: apiKey.principalId }} className="btn small primary">Add grant</Link>}
					</div>
					<p className="section-note">
						What this key may do. A change applies at the key's next token exchange, without a new key: a caller that already holds a token keeps the old
						permissions until that token expires, at most five minutes later.
					</p>
					<Table
						colSpan={7}
						isEmpty={apiKey.grants.length === 0}
						empty={
							<EmptyState
								title="No grants"
								body="The key authenticates but resolves to zero permissions."
								{...(editable
									? {
										action: <Link to="access/credentials/keys/grant" params={{ id: apiKey.principalId }} className="btn small">Add the first grant</Link>,
									}
									: {})}
							/>
						}
						head={<GrantTableHead />}
					>
						{apiKey.grants.map((grant) => <GrantRow key={grant.id} grant={grant} onDone={invalidate} />)}
					</Table>
				</section>
			</>
		)
	})
