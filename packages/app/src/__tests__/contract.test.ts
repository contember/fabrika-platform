import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createRpcClient, initRpc } from '../index.js'
import type { InferRpcClient, RpcProcedureContract, RpcRouterFor } from '../index.js'
import { dispatchRpcRequest } from '../rpc/dispatcher.js'
import { jsonRequest, record } from './helpers.js'

interface CalculatorContract {
	readonly echo: RpcProcedureContract<{ readonly message: string }, { readonly echoed: string }>
	readonly math: {
		readonly add: RpcProcedureContract<{ readonly left: number; readonly right: number }, number>
	}
}

interface Context {
	readonly prefix: string
}

const rpc = initRpc<Context>()
const calculatorRouter = rpc.router({
	echo: rpc.procedure
		.input(z.object({ message: z.string() }))
		.output(z.object({ echoed: z.string() }))
		.query(({ ctx, input }) => ({ echoed: `${ctx.prefix}${input.message}` })),
	math: rpc.router({
		add: rpc.procedure
			.input(z.object({ left: z.number(), right: z.number() }))
			.output(z.number())
			.query(({ input }) => input.left + input.right),
	}),
}) satisfies RpcRouterFor<Context, CalculatorContract>

type Equals<TLeft, TRight> = [TLeft] extends [TRight] ? ([TRight] extends [TLeft] ? true : false) : false
type Expect<TValue extends true> = TValue
type CalculatorClient = InferRpcClient<CalculatorContract>
type _EchoInput = Expect<Equals<Parameters<CalculatorClient['echo']>[0], { readonly message: string }>>
type _EchoOutput = Expect<Equals<Awaited<ReturnType<CalculatorClient['echo']>>, { readonly echoed: string }>>
type _NestedOutput = Expect<Equals<Awaited<ReturnType<CalculatorClient['math']['add']>>, number>>

describe('portable RPC contract', () => {
	test('the contract-constrained server router dispatches normally', async () => {
		const response = await dispatchRpcRequest({
			router: calculatorRouter,
			ctx: { prefix: 'hello ' },
			request: jsonRequest('https://example.test/rpc', { method: 'echo', input: { message: 'world' } }),
		})

		expect(response.status).toBe(200)
		expect(record(record(await response.json())['result'])['echoed']).toBe('hello world')
	})

	test('createRpcClient accepts the portable contract without the server router type', async () => {
		const requests: unknown[] = []
		const client = createRpcClient<CalculatorContract>({
			baseUrl: 'https://example.test/rpc',
			fetch: Object.assign(
				async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
					requests.push(await new Request(input, init).json())
					return Response.json({ result: 7 })
				},
				{ preconnect: fetch.preconnect },
			),
		})

		const result = await client.math.add({ left: 3, right: 4 })

		expect(result).toBe(7)
		expect(requests).toEqual([{ method: 'math.add', input: { left: 3, right: 4 } }])
	})
})
