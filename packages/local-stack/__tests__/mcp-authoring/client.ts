// What an MCP client and its user's browser do, over the stack's public network only: OAuth discovery,
// the authorization code flow with S256 PKCE and an RFC 8707 resource, and JSON-RPC to `/mcp`.

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { z } from 'zod'
import { REDIRECT_URI } from './stack'

type Internet = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AuthorizationServer {
	readonly authorizationEndpoint: string
	readonly tokenEndpoint: string
}

const resourceMetadataSchema = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) })
const serverMetadataSchema = z.object({ authorization_endpoint: z.string(), token_endpoint: z.string() })
const tokenSchema = z.object({ access_token: z.string(), token_type: z.string(), scope: z.string(), expires_in: z.number() })
const toolResultSchema = z.object({
	result: z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })).length(1), isError: z.boolean().optional() }),
})

/** RFC 9728 → RFC 8414: from the resource's metadata URL to IAM's two endpoints. */
export async function discover(internet: Internet, resourceMetadataUrl: string): Promise<{ resource: string; server: AuthorizationServer }> {
	const metadata = resourceMetadataSchema.parse(await (await internet(resourceMetadataUrl)).json())
	const issuer = metadata.authorization_servers[0]
	if (issuer === undefined) throw new Error('the resource names no authorization server')
	const server = serverMetadataSchema.parse(await (await internet(`${issuer}/.well-known/oauth-authorization-server`)).json())
	return { resource: metadata.resource, server: { authorizationEndpoint: server.authorization_endpoint, tokenEndpoint: server.token_endpoint } }
}

/** The whole authorization code flow for one signed-in person; returns the token response. */
export async function authorize(
	internet: Internet,
	server: AuthorizationServer,
	input: { clientId: string; resource: string; session: string },
): Promise<z.infer<typeof tokenSchema>> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
	const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
	const state = crypto.randomUUID()
	const cookie = `${SESSION_COOKIE}=${input.session}`
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: input.clientId,
		redirect_uri: REDIRECT_URI,
		resource: input.resource,
		scope: 'authoring',
		state,
		code_challenge: challenge,
		code_challenge_method: 'S256',
	})
	const consent = await internet(`${server.authorizationEndpoint}?${query}`, { headers: { cookie } })
	if (consent.status !== 200) throw new Error(`the consent page answered ${consent.status}`)
	// The browser submits the consent form as rendered; a same-origin form POST under no-referrer sends `Origin: null`.
	const form = new URLSearchParams([...hiddenFields(await consent.text()), ['decision', 'approve']])
	const decided = await internet(server.authorizationEndpoint, {
		method: 'POST',
		headers: { cookie, origin: 'null', 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
		body: form,
		redirect: 'manual',
	})
	const location = decided.headers.get('location')
	if (decided.status !== 302 || location === null) throw new Error(`consent answered ${decided.status} without a redirect`)
	const callback = new URL(location)
	const code = callback.searchParams.get('code')
	if (`${callback.origin}${callback.pathname}` !== REDIRECT_URI || callback.searchParams.get('state') !== state || code === null) {
		throw new Error('consent did not redirect to the client with a code and its state')
	}
	const response = await internet(server.tokenEndpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: input.clientId,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
			resource: input.resource,
		}),
	})
	if (response.status !== 200) throw new Error(`the token endpoint answered ${response.status}`)
	return tokenSchema.parse(await response.json())
}

/** The JOSE header of a compact JWT, unverified — only to read its `typ`. */
export function jwtHeader(token: string): unknown {
	const [header] = token.split('.')
	if (header === undefined) throw new Error('not a JWT')
	return JSON.parse(atob(header.replaceAll('-', '+').replaceAll('_', '/')))
}

export function mcpRequest(url: string, body: unknown, bearer?: string): Request {
	const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' })
	if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`)
	return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

/** One JSON-RPC exchange; the response is JSON or, for a streaming answer, the last SSE `data:` frame. */
export async function rpc(internet: Internet, url: string, bearer: string, method: string, params: object): Promise<unknown> {
	const response = await internet(mcpRequest(url, { jsonrpc: '2.0', id: crypto.randomUUID(), method, params }, bearer))
	if (response.status !== 200) throw new Error(`${method} answered ${response.status}`)
	const text = await response.text()
	if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(text)
	const last = text.split('\n').filter((line) => line.startsWith('data:')).at(-1)
	if (last === undefined) throw new Error('expected an SSE data frame')
	return JSON.parse(last.slice('data:'.length))
}

export interface ToolResult {
	readonly isError: boolean
	readonly text: string
}

export async function callTool(internet: Internet, url: string, bearer: string, name: string, args: object): Promise<ToolResult> {
	const { result } = toolResultSchema.parse(await rpc(internet, url, bearer, 'tools/call', { name, arguments: args }))
	const [content] = result.content
	if (content === undefined) throw new Error('a tool result without content')
	return { isError: result.isError === true, text: content.text }
}

/** A successful tool's JSON payload, parsed with the caller's schema. */
export function toolJson<T>(result: ToolResult, schema: z.ZodType<T>): T {
	if (result.isError) throw new Error(`the tool failed: ${result.text}`)
	return schema.parse(JSON.parse(result.text))
}

function hiddenFields(html: string): [string, string][] {
	return [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((match) => [match[1] ?? '', unescapeHtml(match[2] ?? '')])
}

function unescapeHtml(value: string): string {
	return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

function base64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
