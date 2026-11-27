// The account a set of credentials belongs to (STS `GetCallerIdentity`, the query protocol), which the operator's
// command compares with the account it was told to change before it reads or writes anything there. The call needs no
// permission: AWS answers it for any valid credentials.
//
// UNVERIFIED: the answer's element names and the regional endpoint follow STS's API reference; not checked against an
// account.

import { awsQueryClient, type AwsQueryService } from './query'
import type { AwsClientOptions } from './transport'
import { xmlText } from './xml'

export const STS: AwsQueryService = { service: 'sts', version: '2011-06-15' }

/** An account id as AWS writes it. */
const ACCOUNT_ID = /^\d{12}$/

export interface StsClient {
	/** The account the credentials current now belong to. */
	callerAccount(signal?: AbortSignal): Promise<string>
}

/** STS at `options.origin`, the regional endpoint (`https://sts.<region>.amazonaws.com`). */
export function stsClient(options: AwsClientOptions): StsClient {
	const query = awsQueryClient(STS, options)
	return {
		callerAccount: (signal) =>
			query.call(
				'GetCallerIdentity',
				{},
				(result) => {
					const account = result === null ? null : xmlText(result, 'Account')
					if (account === null || !ACCOUNT_ID.test(account)) throw new Error('no account')
					return account
				},
				signal,
			),
	}
}
