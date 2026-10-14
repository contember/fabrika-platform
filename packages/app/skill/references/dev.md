# references/dev.md — previewing the application with `fabrika app dev`

`bunx fabrika app dev` serves the application on `http://127.0.0.1:3000/` through its test kit: the proxy decision,
the stand-in IAM, a throwaway schema of `FABRIKA_TEST_POSTGRES_URL`, and each SPA from its build (run
`bun run build:web` first). Use it to look at the screens, never in place of a test.

## The seed

`dev/seed.ts` runs once, before the first request. It receives the kit, the API the tests use, writes through the
endpoints, and answers whom and what the picker offers. `--seed=<module>` names another file.

```ts dev/seed.ts
import { createClient } from '@fabrika/app/client'
import type { DevSeed } from '@fabrika/app/testing'
import { contract } from '../fabrika.contract'

const seed: DevSeed<typeof contract> = async (dev) => {
	const acme = dev.scope('org', 'acme')
	const ada = dev.testCaller([{ role: 'owner', scope: acme }], {
		label: 'Ada Lovelace',
		email: 'ada@acme.example',
	})
	const ben = dev.testCaller([{ role: 'member', scope: acme }], {
		label: 'Ben Okafor',
		email: 'ben@acme.example',
	})
	const api = createClient(contract, 'api', { fetch: dev.browser(ada) })
	await api.projects.create({ orgId: acme.value, name: 'Website relaunch' })
	await api.members.invite({
		orgId: acme.value,
		email: 'cleo@acme.example',
		role: 'member',
	})
	return {
		personas: [
			{ name: 'Ada', description: 'Owns Acme: invites and assigns', caller: ada },
			{ name: 'Ben', description: 'A member who works the tasks', caller: ben },
		],
		scopes: { org: [{ value: acme.value, label: 'Acme' }] },
	}
}

export default seed
```

- A persona is a person the seed made with `dev.testCaller` (a session, never `via: 'key'`), with a unique `name` and
  a one-line `description`. The picker shows its roles, the scope values it holds them in, and `external`.
- `links` lists pages a link holder opens: `{ title, description, url }`, where `url` is what the application's own
  endpoint answered from `ctx.links.issue` (`/s/#<key>`). Never build a link URL by hand.
- `scopes` names the values the seed made, by dimension, with the label a person knows them by; the picker offers
  them for a membership role.
- Check every call the seed makes: an endpoint that refuses answers a status, and the seed goes on without its data.
  A seed that throws stops `app dev` with `seed_failed` and no message, because the message may carry a credential;
  run the same calls in a test to see why.
- Mail the application sends through its own stand-ins is the seed's business. The invitations IAM would e-mail are
  listed by `app dev` itself.

## In the browser

- `/__fabrika/dev` is the picker: the personas, another role of the vocabulary (a membership role with a scope value),
  anonymous, the link pages, and the mail IAM sent. It speaks the vocabulary's `locale` and shows its `displayName`.
- Every SPA page carries a toolbar in the bottom corner: who you are, the personas to switch to (the page reloads as
  that caller), the picker, the link pages, and the mail. An invitation's link accepts it; the browser is the invited
  person from then on.
- The choice stays in a cookie the application never sees. The data is gone when the command stops.
- It serves this machine only (`--host` is a loopback address, `--port=0` picks a free port), answers no request
  addressed to another host name, and runs no cron job: test those with `kit.runJob`.
