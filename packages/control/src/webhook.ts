// The GitHub webhook handler — the ONE unauthenticated route. It is HMAC-gated instead: the route's
// connection secret verifies the `X-Hub-Signature-256` over the raw body before anything touches the
// database. On a verified push it maps repo+ref → (app, env) through the connection's bound apps, creates
// a `pending` run, and enqueues the deploy. A push that no env subscribes to is a 204 no-op.

import { type JobQueue, uuidv7 } from '@fabrika/platform'
import type { ControlRepositories } from './db'
import { error, json } from './http'
import { refMatches } from './ref-match'
import { normalizeRepoUrl, parseGitHubRepo, type PushEvent, type PushWebhookVerifier } from './repo-source'
import type { DeployJobMessage } from './run-lifecycle'

export interface WebhookDeps {
	repositories: ControlRepositories
	verifier: PushWebhookVerifier
	queue: JobQueue<DeployJobMessage>
	/** The connection the route names; only apps bound to it and its installation are triggered. */
	connectionId: string
}

/**
 * Handle `POST /webhooks/github/:connectionId`. Verify the HMAC, decode the push, and for every (app, env) whose
 * `trigger_ref` matches the pushed ref, create + enqueue a run. Returns:
 *   - 401 when the signature is missing/invalid (HMAC gate — the only auth on this route),
 *   - 204 when verified but no env subscribes to the ref (acknowledged no-op),
 *   - 200 with the created run ids when one or more deploys were triggered.
 */
export async function handleWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
	let push: PushEvent | null
	try {
		push = await deps.verifier.verifyWebhook(request)
	} catch {
		return error(401, 'invalid webhook signature')
	}
	if (push === null) {
		// Either a bad signature or an undecodable body — both are 401 on this HMAC-gated route (we do
		// not distinguish, to avoid leaking which check failed).
		return error(401, 'invalid webhook signature')
	}
	if (push.installationId === null) return new Response(null, { status: 204 })

	const apps = await getConnectionApps(normalizeRepoUrl(push.repoUrl), push.installationId, deps.connectionId, deps.repositories)
	if (apps.length === 0) {
		// No app registered for this repo — acknowledge so GitHub doesn't retry.
		return new Response(null, { status: 204 })
	}

	const triggered: string[] = []
	for (const app of apps) {
		// Match the pushed ref against every env's trigger_ref (exact or glob, e.g. `refs/tags/v*`). More
		// than one env can subscribe (different patterns) — trigger each. The DEPLOYED ref is always the
		// concrete pushed ref, never the pattern.
		const envs = await deps.repositories.registry.listTriggerEnvs(app.id)
		for (const appEnv of envs) {
			if (appEnv.trigger_ref === null || !refMatches(appEnv.trigger_ref, push.ref)) {
				continue
			}
			const run = await deps.repositories.runs.createRun({
				id: uuidv7(),
				appId: app.id,
				env: appEnv.env,
				ref: push.ref,
				commitSha: push.commitSha,
				trigger: 'webhook',
			})
			await deps.queue.send({ runId: run.id })
			triggered.push(run.id)
		}
	}

	if (triggered.length === 0) {
		return new Response(null, { status: 204 })
	}
	return json({ triggered })
}

async function getConnectionApps(
	repoUrl: string,
	installationId: number,
	connectionId: string,
	repositories: ControlRepositories,
) {
	const connection = await repositories.githubConnections.getConnectionById(connectionId)
	if (connection === null || connection.installationId !== installationId) return []
	const repository = parseGitHubRepo(repoUrl)
	if (repository === null || repository.owner.toLowerCase() !== connection.appOwner.toLowerCase()) return []
	return repositories.registry.getAppsByRepoUrlAndSourceConnection(repoUrl, connectionId, installationId)
}
