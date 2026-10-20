import type { SqlDatabase } from '@fabrika/platform'
import { firstRow } from './returning'

export type MailRuleAction = 'pass' | 'hold' | 'drop'

export interface MailRuleRow {
	id: string
	/** `*` or `<app>@<env>`. */
	scope: string
	/** `*` or a lowercase recipient domain. */
	domain: string
	action: MailRuleAction
	created_at: number
	updated_at: number
}

export interface MailRuleInput {
	/** The id a new rule gets; an existing rule of the same scope and domain keeps its own. */
	id: string
	scope: string
	domain: string
	action: MailRuleAction
}

export class MailRuleRepository {
	constructor(private readonly d1: SqlDatabase) {}

	async list(): Promise<MailRuleRow[]> {
		const { results } = await this.d1.prepare('SELECT * FROM mail_rules ORDER BY scope, domain').all<MailRuleRow>()
		return results
	}

	/** Sets the action of the rule of `scope` and `domain`, creating it when there is none. */
	async upsert(input: MailRuleInput, now: number): Promise<MailRuleRow> {
		return await firstRow<MailRuleRow>(
			this.d1
				.prepare(
					`INSERT INTO mail_rules (id, scope, domain, action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT (scope, domain) DO UPDATE SET action = excluded.action, updated_at = excluded.updated_at
					RETURNING *`,
				)
				.bind(input.id, input.scope, input.domain, input.action, now, now),
		)
	}

	/** Whether a rule was removed. */
	async remove(id: string): Promise<boolean> {
		const result = await this.d1.prepare('DELETE FROM mail_rules WHERE id = ?').bind(id).run()
		return result.meta.changes > 0
	}

	/**
	 * The most specific rule for a message of `scope` to `domain`: the exact scope before `*`, and within a scope the
	 * exact domain before `*`. `null`: no rule, so the message passes.
	 */
	async resolve(scope: string, domain: string): Promise<MailRuleRow | null> {
		return await this.d1
			.prepare(
				`SELECT * FROM mail_rules WHERE scope IN (?, '*') AND domain IN (?, '*')
				ORDER BY CASE WHEN scope = '*' THEN 1 ELSE 0 END, CASE WHEN domain = '*' THEN 1 ELSE 0 END
				LIMIT 1`,
			)
			.bind(scope, domain)
			.first<MailRuleRow>()
	}
}
