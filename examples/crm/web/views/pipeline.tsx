// The pipeline: one column per stage with its count and value, each deal a card that moves on one stage or reopens.

import { Can, useInfiniteQuery, useMutation, useQuery } from '@fabrika/app/react'
import { Button, Card, PageHeader, StatusPill } from '@fabrika/ui'
import type { ReactNode } from 'react'
import { DEAL_STAGES } from '../../src/schemas'
import { api, type Deal } from '../api'
import { isClosed, money, nextStage, type Stage, stageLabel, stageTone } from '../format'
import { Link } from '../routes'
import { Loaded, useCompanies, useReport } from './common'

function useStageActions() {
	const report = useReport()
	const move = useMutation(api.deals.move)
	const reopen = useMutation(api.deals.reopen)
	return {
		pending: move.pending || reopen.pending,
		advance: async (deal: Deal, stage: Stage) =>
			report(await move.mutate({ id: deal.id, stage, expectVersion: deal.version }), `${deal.title} moved to ${stageLabel(stage)}`),
		reopen: async (deal: Deal) => report(await reopen.mutate({ id: deal.id, expectVersion: deal.version }), `${deal.title} reopened`),
	}
}

function DealCard(
	{ deal, company, actions }: { readonly deal: Deal; readonly company: string; readonly actions: ReturnType<typeof useStageActions> },
) {
	const next = nextStage(deal.stage)
	return (
		<li className="crm-deal-card">
			<Link to="deal" params={{ id: deal.id }} className="crm-deal-card__title">{deal.title}</Link>
			<span className="crm-deal-card__meta">{company}</span>
			<span className="crm-deal-card__meta">
				<strong>{money(deal.value)}</strong> · {deal.ownerLabel}
			</span>
			<Can action="deals.write">
				{isClosed(deal.stage)
					? <Button size="sm" variant="ghost" disabled={actions.pending} onClick={() => void actions.reopen(deal)}>Reopen</Button>
					: next === null
					? null
					: (
						<Button size="sm" variant="ghost" disabled={actions.pending} onClick={() => void actions.advance(deal, next)}>
							Move to {stageLabel(next)}
						</Button>
					)}
			</Can>
		</li>
	)
}

export function Pipeline(): ReactNode {
	const totals = useQuery(api.deals.pipeline)
	const deals = useInfiniteQuery(api.deals.list, {}, { pages: 'all' })
	const { name } = useCompanies()
	const actions = useStageActions()
	return (
		<>
			<PageHeader title="Pipeline" lead="Every open and closed deal of your orgs, by stage." />
			<Loaded query={totals}>
				{({ stages }) => (
					<div className="crm-board">
						{DEAL_STAGES.map((stage) => {
							const total = stages.find((entry) => entry.stage === stage)
							const inStage = deals.items.filter((deal) => deal.stage === stage)
							return (
								<Card
									key={stage}
									title={<StatusPill tone={stageTone(stage)}>{stageLabel(stage)}</StatusPill>}
									actions={<span className="crm-board__total">{total?.count ?? 0} · {money(total?.value ?? 0)}</span>}
								>
									{inStage.length === 0
										? <p className="crm-muted">No deals</p>
										: (
											<ul className="crm-deal-cards" aria-label={`${stageLabel(stage)} deals`}>
												{inStage.map((deal) => <DealCard key={deal.id} deal={deal} company={name(deal.companyId)} actions={actions} />)}
											</ul>
										)}
								</Card>
							)
						})}
					</div>
				)}
			</Loaded>
		</>
	)
}
