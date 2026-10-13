# references/public-intake.md — the public intake recipe

A visitor who has no account submits a form on a public page, confirms the e-mail address through a link, attaches
files, and asks for a new link when the first one is lost. HR reviews the records, an HR lead edits the code list of
open positions, and HR exports every candidate with an audit row. This file is an application of its own (`intake`);
its `package.json`, `tsconfig.json` and `src/app-kit.ts` are those of `app-setup.md`.

Every piece lets in someone who is not signed in, so ask the human before you build it, and say what each one lets the
visitor do. The visitor never reaches a handler without a credential:

1. **A public page** (`c.spa('/', { access: { public: true } })`) holds the form. It reads no data.
2. **A form** appends one row to its inbox table and answers `{ received: true }`, for a new and a known address
   alike. It runs no handler: a handler would give every anonymous request a transaction, and a different answer for
   a known address would tell a stranger who registered.
3. **A cron job** drains the inbox, creates the record, issues a link bound to it (`issues`), and sends the e-mail.
   Each form kicks it (`then: 'intake'`), so it runs within seconds of a submission; its schedule is the recovery.
4. **A link mount** serves the visitor's own record: `verify` and the record's files, under the link's key.
5. **A second form** asks for a new link. The job revokes the old one and sends a new one, within a budget per address.

## The vocabulary, the migrations and the policies

```ts src/vocabulary.ts
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'intake',
	dimensions: { candidate: {} },
	actions: {
		'candidates.read': 'Read candidate records and their files',
		'candidates.review': 'Move a candidate through the review',
		'candidates.verify': "Confirm a candidate's e-mail address",
		'candidates.attach': 'Attach files to a candidate record',
		'candidates.invite': "Issue a candidate's portal link",
		'candidates.process': 'Register candidates and send their links',
		'positions.read': 'Read the open positions',
		'positions.manage': 'Edit the open positions',
		'exports.read': 'Read the log of candidate exports',
	},
	roles: {
		hr: { grants: ['candidates.read', 'candidates.review', 'positions.read'] },
		hr_lead: { grants: ['positions.read', 'positions.manage', 'exports.read'] },
	},
})
```

- `candidate` is a top-level dimension with no members: a candidate is a record, not a scope people are invited to.
- `hr` and `hr_lead` have no `member`, so an administrator grants them in IAM, usually without a scope (a global
  grant). The code list and the export of every candidate need that grant: they are data of the whole application.
- The link's holder and the job get their actions from the link mount and the job's `actions`, not from a role.

```sql db/migrations/20261013090000_intake.sql
CREATE TYPE candidate_status AS ENUM ('new', 'screening', 'interview', 'hired', 'rejected');
CREATE TYPE link_state AS ENUM ('due', 'issued', 'sent');

-- The link delivery is the intake job's own state: each step is recorded here before the next effect starts.
CREATE TABLE candidates (
	id UUID PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	status candidate_status NOT NULL DEFAULT 'new',
	verified_at TIMESTAMPTZ,
	link_state link_state NOT NULL DEFAULT 'due',
	link_id TEXT,
	revoke_link_id TEXT,
	sends INTEGER NOT NULL DEFAULT 0,
	window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
);

-- The review's history: one row per decision, written in the decision's own transaction.
CREATE TABLE candidate_events (
	id UUID PRIMARY KEY,
	candidate_id UUID NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
	status candidate_status NOT NULL,
	note TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX candidate_events_candidate ON candidate_events (candidate_id);

-- The forms' inboxes: a column per input field, except the honeypot and the challenge token.
CREATE TABLE registrations (
	email TEXT NOT NULL,
	name TEXT NOT NULL
);
CREATE TABLE resend_requests (
	email TEXT NOT NULL
);
```

```sql db/migrations/20261013090050_application_data.sql
-- Data of the whole application: the code list an HR lead edits, and the log of every export of all candidates.
CREATE TABLE positions (
	id UUID PRIMARY KEY,
	title TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
);
CREATE TABLE candidate_exports (
	id UUID PRIMARY KEY,
	row_count INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```sql db/migrations/20261013090100_attachments.sql
CREATE TABLE fabrika_files_attachments (
	id UUID PRIMARY KEY,
	owner_id UUID,
	status TEXT NOT NULL CONSTRAINT fabrika_files_attachments_status CHECK (status IN ('pending', 'live', 'quarantined', 'rejected')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	content_type TEXT NOT NULL,
	sha256 TEXT,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ,
	object_version TEXT,
	scan_attempts INTEGER NOT NULL DEFAULT 0,
	scan_after TIMESTAMPTZ,
	FOREIGN KEY (owner_id) REFERENCES candidates (id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX fabrika_files_attachments_owner ON fabrika_files_attachments (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX fabrika_files_attachments_removable ON fabrika_files_attachments (created_at) WHERE deleted_at IS NOT NULL OR owner_id IS NULL OR status = 'pending';
CREATE INDEX fabrika_files_attachments_scan ON fabrika_files_attachments (scan_after) WHERE status = 'quarantined';
```

The file table is `fileTableSql('attachments', { table: 'candidates', key: { column: 'id', type: 'uuid' }, chain: [] })`
(`references/files.md`): a top-level owner has no chain.

```ts src/db/tables.ts
import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	candidates: {
		scope: { dimension: 'candidate' },
		actions: {
			read: 'candidates.read',
			insert: 'candidates.process',
			update: 'candidates.verify',
		},
		insert: ['email', 'name'],
		update: ['verified_at'],
		version: 'version',
		createdBy: 'created_by',
		columns: {
			status: { write: 'candidates.review' },
			link_state: { read: 'candidates.process' },
			link_id: { read: 'candidates.process' },
			revoke_link_id: { read: 'candidates.process' },
			sends: { read: 'candidates.process' },
			window_started_at: { read: 'candidates.process' },
		},
	},
	candidate_events: {
		scope: { child: 'candidates' },
		actions: { read: 'candidates.read', insert: 'candidates.review' },
		insert: ['status', 'note'],
		createdBy: 'created_by',
	},
	registrations: { scope: { inbox: 'register', read: 'candidates.process' } },
	resend_requests: { scope: { inbox: 'resend', read: 'candidates.process' } },
	positions: {
		scope: { app: 'the open positions an HR lead edits' },
		actions: {
			read: 'positions.read',
			insert: 'positions.manage',
			update: 'positions.manage',
		},
		insert: ['title'],
		update: ['title', 'active'],
		version: 'version',
		createdBy: 'created_by',
	},
	candidate_exports: {
		scope: { app: 'the log of every export of all candidates' },
		actions: { read: 'exports.read', insert: 'candidates.read' },
		insert: ['row_count'],
		createdBy: 'created_by',
	},
})
```

- `{ inbox: '<form>', read }` is a form's table: only that form appends to it, and only a site that holds `read` and
  declares the reach reads it.
- `{ app: '<why>' }` is an application table: its rows belong to no candidate. Only an endpoint declared
  `access: { action, app: true }` reaches it, through `ctx.db.app`, with the action the operation names. A position is
  deactivated, never deleted, so the table has no delete action. `candidate_exports` is appended with the export's own
  action, `candidates.read`, and read with `exports.read`.
- The delivery columns are read only with `candidates.process`, so neither HR nor the link's holder sees them.

## The contract

```ts src/schemas.ts
import { z } from 'zod/v4'

export const CandidateStatus = z.enum([
	'new',
	'screening',
	'interview',
	'hired',
	'rejected',
])
export const Register = z.strictObject({
	email: z.email().max(200),
	name: z.string().min(1).max(200),
	website: z.optional(z.string().max(200)),
	challengeToken: z.string().max(4096),
})
export const Resend = z.strictObject({ email: z.email().max(200) })
export const Me = z.strictObject({
	name: z.string(),
	email: z.string(),
	verified: z.boolean(),
})
export const Verified = z.strictObject({ verifiedAt: z.iso.datetime() })
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { candidates } from './src/candidates/endpoints'
import { intake } from './src/intake/endpoints'
import { portal } from './src/portal/endpoints'
import { positions } from './src/positions/endpoints'
import { Register, Resend } from './src/schemas'

export const contract = app.contract((c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	register: c.form('/register', {
		input: Register,
		appendTo: 'registrations',
		maxBytes: 4096,
		honeypot: 'website',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		then: 'intake',
	}),
	resend: c.form('/resend', {
		input: Resend,
		appendTo: 'resend_requests',
		maxBytes: 1024,
		then: 'intake',
	}),
	portal,
	api: c.rpc('/api', { candidates, positions }),
	hr: c.spa('/hr', {
		dir: 'dist/hr',
		access: { action: 'candidates.read', over: 'candidate' },
	}),
	files: {
		attachments: c.files({
			owner: 'candidates',
			read: 'candidates.read',
			write: 'candidates.attach',
			delete: 'candidates.review',
			maxBytes: 10485760,
			types: ['application/pdf'],
			maxPerOwner: 5,
			link: true,
			scan: true,
		}),
	},
	jobs: { intake },
	health: c.health('/healthz'),
}))
```

- **The public page.** `access: { public: true }` serves the SPA to anyone, without a token, and takes no other key.
  At `/` it answers every `GET` that no more specific endpoint serves, so the HR SPA (`/hr`) and the link's SPA (`/p`)
  keep their own. The approver sees it as "for anyone, without signing in". Put nothing on it that only members may
  read: the page calls no procedure.
- **The form's abuse control.** `honeypot` names an optional string field the page hides: a filled one gets the same
  answer and writes no row. `challenge` makes the framework verify the Turnstile token in `challengeToken` before it
  writes the row (a failed token 400, an unreachable provider 503, no row either way) and adds Turnstile's origin to
  the CSP. `TURNSTILE_SECRET` is an application variable the human sets; without it the application does not boot.
  `rate: { perClient, perForm }` (per minute, 10 and 100 by default) answers 429 past either limit.
- **Zerops shares one client address.** Until the platform reads the visitor's address behind the Zerops balancer,
  every visitor counts as one client there, so `perClient` acts as a second per-form limit: set it to the form's
  expected peak, never lower it to stop a flood. The challenge is the defense that does not depend on the address.
- **Other origins** the pages load (an image host, an API the browser calls) go in the contract's `csp` section:
  `csp: { scriptSrc: [{ origin: 'https://…', purpose: '…' }] }`, beside `connectSrc`, `imgSrc`, `frameSrc` and
  `frameAncestors`: exact `https://` origins, at most 16 each. Each new origin is a widening the approver sees.
- **Scanned files.** A visitor's upload waits `quarantined` until ClamAV answers clean (`references/files.md`): its
  download answers 409 until then. On Zerops the deploy service needs `verticalAutoscaling: { minRam: 2 }`.
- **The kick.** `then: 'intake'` makes each accepted submission start a run of the job within seconds, once its row
  committed, under the job's own key. The visitor's answer is the same constant and never waits for the run. Kicks
  coalesce on the job's lease (at most one run and one pending, however many visitors submit), so a flood adds no
  work: the run still drains the inbox in batches of 50, within each address's budget. A kick carries nothing; the
  job reads its inbox.

## The job: inbox → record → link → e-mail

```ts src/mail.ts
import { defineDeps } from '@fabrika/app/implement'

export interface Mailer {
	/** Sends the link to `to`; throws when the provider refuses, and gives up once `signal` aborts. */
	sendLink(to: string, url: string, signal: AbortSignal): Promise<void>
}

/** Read when a mail is sent: the generated tests boot the application without its variables. */
const variable = (env: Readonly<Record<string, unknown>>, name: string) => {
	const value = env[name]
	if (typeof value !== 'string' || value === '') {
		throw new Error(`the application variable ${name} is not set`)
	}
	return value
}

export const mailer = defineDeps((env): Mailer => ({
	async sendLink(to, url, signal) {
		const origin = variable(env, 'INTAKE_ORIGIN')
		const response = await fetch(variable(env, 'MAIL_API_URL'), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${variable(env, 'MAIL_API_KEY')}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				to,
				subject: 'Confirm your address',
				text: `Open ${origin}${url} to confirm your address.`,
			}),
			signal,
		})
		if (!response.ok) {
			throw new Error(`the mail provider answered ${response.status}`)
		}
	},
}))
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { mailer } from './mail'

export default serve(contract, { database: scoped(tables), deps: mailer })
```

```ts src/intake/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { mailer } from '../mail'

const Registration = z.strictObject({ email: z.string(), name: z.string() })
const Ask = z.strictObject({ email: z.string() })
const Id = z.strictObject({ id: z.string() })
const Due = z.strictObject({
	id: z.string(),
	email: z.string(),
	linkState: z.enum(['due', 'issued', 'sent']),
	linkId: z.nullable(z.string()),
	revokeLinkId: z.nullable(z.string()),
})

/** A link lives a week; an address gets at most three e-mails a day, failed deliveries included. */
const LINK_DAYS = 7
const SENDS_PER_DAY = 3

export const intake = app.cron('* * * * *', {
	actions: [
		'candidates.process',
		'candidates.invite',
		'candidates.read',
		'candidates.verify',
		'candidates.attach',
	],
	scope: 'app',
	retries: 0,
	sql: 'write',
	issues: 'portal',
})
	.handle(async ({ ctx }) => {
		const mail = mailer.get()
		// A registration becomes a candidate once; the form told the visitor nothing either way.
		await ctx.transaction(async (tx) => {
			const rows = await tx.sql(Registration)`
				delete from registrations returning email, name`
			for (const row of rows) {
				await tx.sql(Id)`
					insert into candidates (id, email, name, created_by, version)
					values (${crypto.randomUUID()}, ${row.email}, ${row.name}, ${ctx.principal.id}, 1)
					on conflict (email) do nothing
					returning id`
			}
		})
		// A resend supersedes the sent link of an unverified candidate while its budget has an e-mail left.
		await ctx.transaction(async (tx) => {
			for (
				const ask of await tx.sql(Ask)`delete from resend_requests returning email`
			) {
				await tx.sql(Id)`
					update candidates
					set link_state = 'due', revoke_link_id = link_id, link_id = null
					where email = ${ask.email} and verified_at is null and link_state = 'sent'
						and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
					returning id`
			}
		})
		// Only a row whose budget has an e-mail left: spent rows would fill the batch and starve the rest.
		const due = await ctx.transaction((tx) =>
			tx.sql(Due)`
				select id, email, link_state, link_id, revoke_link_id
				from candidates
				where link_state <> 'sent'
					and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				order by id limit 50`
		)
		for (const candidate of due) {
			// The e-mail is charged before any effect; without one left, the row waits as it is.
			const reserved = await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set
						sends = case when window_started_at < now() - interval '1 day' then 1 else sends + 1 end,
						window_started_at = case when window_started_at < now() - interval '1 day'
							then now() else window_started_at end
					where id = ${candidate.id}
						and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
					returning id`
			)
			if (reserved.length === 0) continue
			// A link issued but not known to be e-mailed, or one a resend superseded, ends first.
			const superseded = candidate.linkState === 'issued'
				? candidate.linkId
				: candidate.revokeLinkId
			if (superseded !== null) {
				ctx.signal.throwIfAborted()
				await ctx.links.revoke(superseded)
				await ctx.transaction((tx) =>
					tx.sql(Id)`
						update candidates set link_state = 'due', link_id = null, revoke_link_id = null
						where id = ${candidate.id} returning id`
				)
			}
			ctx.signal.throwIfAborted()
			const ref = await ctx.ref('candidates.invite', 'candidate', candidate.id)
			const link = await ctx.links.issue(ref, { mount: 'portal', days: LINK_DAYS })
			await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set link_state = 'issued', link_id = ${link.id}
					where id = ${candidate.id} returning id`
			)
			ctx.signal.throwIfAborted()
			await mail.sendLink(candidate.email, link.url, ctx.signal)
			await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set link_state = 'sent'
					where id = ${candidate.id} and link_id = ${link.id} returning id`
			)
		}
	})
```

The job keeps three invariants. Keep them when you change it:

- **The budget is charged first.** Each delivery reserves one e-mail of the address's daily budget, in its own
  transaction, before any effect. A delivery that fails after the e-mail left is still counted, so a provider that
  times out cannot make the job mail one address without end. Only a row with an e-mail left is selected for the batch
  of 50, so spent rows never crowd out the others; the reservation checks the budget again in its own transaction.
- **Each step is recorded before the next effect.** Revoke a superseded link, then record it; issue, then record the
  link's id (`issued`); send, then record `sent`. A run that stops anywhere (a crash, a refused e-mail, IAM down) is
  finished by the next run its budget allows: an `issued` row's link is revoked and replaced, so exactly one live link
  was e-mailed. The e-mail is at least once. The link's key is never stored: only the job saw it.
- **An effect starts only while the attempt is live.** `ctx.signal.throwIfAborted()` runs before each IAM call and the
  e-mail, and the e-mail takes `ctx.signal`. The runner aborts a timed-out attempt before the next one starts, so no
  effect of a stale attempt follows the next one's. `ctx.links` itself refuses to call IAM for an ended attempt.

More on the job:

- **`issues: 'portal'`** gives the job `ctx.links.issue(ref, { mount, days })` and `ctx.links.revoke(id)` for the
  links it issued. Its `actions` must hold the mount's `issuedBy` and every grant of the mount, or the contract is
  refused: IAM lets an issuer delegate only what it holds. The link is bound to one candidate (the `Ref`), and the
  approver sees the job's `issues` marked "needs closer review".
- **`sql: 'write'`** is the declared reach into the inboxes: `delete … returning` takes each row exactly once. A job is
  app-wide, so its statements need no scope fragment (`tx.sql.scope` of its `Within` is every row).
- **The latency.** The forms' kick starts a run within seconds of a submission, so the e-mail leaves seconds later,
  while the address has an e-mail of its daily budget left; a spent one waits until a day after the window's first
  e-mail. Keep the schedule (`* * * * *`): it is the recovery path. A kicked run that dies (a crash, a deploy, a
  refused e-mail) leaves its rows, and the next scheduled run finishes them, within a minute. `retries: 0`: that run
  is the retry. A failed run leaves a pending kick to the schedule too.
- **A revoked link** still works until the token the proxy holds for it expires, at most 5 minutes. Revocation is the
  stop at IAM; it is not instant.
- The e-mail goes through `deps` (`src/mail.ts`), built from application variables the human sets (`INTAKE_ORIGIN`,
  `MAIL_API_URL`, `MAIL_API_KEY`). `link.url` is `/p/#<key>`: the key is in the fragment, which no server and no
  `Referer` sees.

## The visitor's link: verify once, attach files

```ts src/portal/endpoints.ts
import { app } from '../app-kit'
import { Me, Verified } from '../schemas'

export const portal = app.link('/p', {
	spa: 'dist/portal',
	dimension: 'candidate',
	grants: ['candidates.read', 'candidates.verify', 'candidates.attach'],
	issuedBy: 'candidates.invite',
	maxDays: 7,
	procedures: (l) => ({
		me: l.query({ output: Me, access: { action: 'candidates.read' } })
			.handle(async ({ ctx }) => {
				const row = await ctx.db.target.get()
				return {
					name: row.name,
					email: row.email,
					verified: row.verified_at !== null,
				}
			}),
		verify: l.mutation({
			output: Verified,
			access: { action: 'candidates.verify' },
		})
			.handle(async ({ ctx }) => {
				const row = await ctx.db.target.getForUpdate()
				if (row.verified_at !== null) {
					return { verifiedAt: row.verified_at.toISOString() }
				}
				const now = new Date()
				await ctx.db.target.update({ verified_at: now }, {
					expectVersion: row.version,
				})
				return { verifiedAt: now.toISOString() }
			}),
	}),
})
```

- **Single use is the application's state.** `verify` sets `verified_at` once, under `getForUpdate`; a second call
  answers the same time. IAM counts no uses: the proxy honors a token it holds without asking IAM.
- A link procedure acts on the link's own object: no `from`, no id in the input. A key of another candidate reaches
  only that candidate's record, and a key whose candidate is gone answers 404.
- `link: true` on the collection serves the holder `POST /p/api/files.attachments.upload?name=<name>` (the body is the
  file), `POST /p/api/files.attachments.list` (`{ limit?, after? }`) and `GET /p/api/files.attachments/:fileId`, for
  the link's candidate only: another candidate's file id answers 404. The mount must grant the collection's `write`
  and `read`. HR reaches the same files under `/api/files.attachments…` with `candidates.read`.

```ts web/portal/main.ts
import { createClient, RpcError, shareKey } from '@fabrika/app/client'
import { contract } from '../../fabrika.contract'

const key = shareKey()
const portal = key === null ? null : createClient(contract, 'portal', { key })

export const confirm = async (status: HTMLElement): Promise<void> => {
	if (portal === null) {
		status.textContent = 'This link holds no key.'
		return
	}
	try {
		const me = await portal.me()
		await portal.verify()
		status.textContent = `${me.name}, your address is confirmed.`
	} catch (error) {
		status.textContent = error instanceof RpcError
			? 'This link no longer works: ask for a new one.'
			: 'Failed'
	}
}

export const attach = async (file: File): Promise<string> => {
	if (key === null) return 'This link holds no key.'
	const response = await fetch(
		`/p/api/files.attachments.upload?name=${encodeURIComponent(file.name)}`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': file.type },
			body: file,
		},
	)
	return response.ok ? 'Received: it is being checked.' : 'Refused.'
}
```

The public page sends the form with a plain `fetch`: a form has no typed client, and its answer never depends on the
data.

```ts web/site/register.ts
export const register = async (
	form: HTMLFormElement,
	challengeToken: string,
): Promise<boolean> => {
	const data = new FormData(form)
	const field = (name: string) => {
		const value = data.get(name)
		return typeof value === 'string' ? value : ''
	}
	const response = await fetch('/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: field('email'),
			name: field('name'),
			website: field('website'),
			challengeToken,
		}),
	})
	return response.ok
}
```

- The page renders the Turnstile widget with its public site key and `action` set to the form's mount name
  (`register`), and passes the widget's token. Say "check your inbox" on success whatever the address was.
- The resend form is the same call to `/resend` with `{ email }`. It answers the same for an unknown, a verified and a
  rate-limited address; the job decides.
- Build each SPA into its `dir` (`dist/site`, `dist/portal`, `dist/hr`): one `Bun.build` per `index.html` in
  `build-web.ts`.

## HR: the list, the review and its history

```ts src/candidates/logic.ts
type Status = 'new' | 'screening' | 'interview' | 'hired' | 'rejected'

const NEXT: Readonly<Record<Status, readonly Status[]>> = {
	new: ['screening', 'rejected'],
	screening: ['interview', 'rejected'],
	interview: ['hired', 'rejected'],
	hired: [],
	rejected: [],
}

export const canMove = (from: Status, to: Status): boolean =>
	NEXT[from].includes(to)
```

```ts src/candidates/endpoints.ts
import { ConflictError, fromPage, fromRow } from '@fabrika/app'
import { attachment } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { CandidateStatus } from '../schemas'
import { canMove } from './logic'

const Cursor = z.string().max(500)
const Candidate = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	email: z.string(),
	status: CandidateStatus,
	verifiedAt: z.nullable(z.iso.datetime()),
	version: z.int(),
})
const CandidatePage = z.strictObject({
	items: z.array(Candidate),
	next: z.nullable(z.string()),
})
const Event = z.strictObject({
	status: CandidateStatus,
	note: z.nullable(z.string()),
	createdBy: z.string(),
	createdAt: z.iso.datetime(),
})
const History = z.strictObject({
	items: z.array(Event),
	next: z.nullable(z.string()),
})
const ListCandidates = z.strictObject({
	status: CandidateStatus.optional(),
	after: Cursor.optional(),
})
const ById = z.strictObject({ id: z.uuid() })
const HistoryOf = z.strictObject({ id: z.uuid(), after: Cursor.optional() })
const Decide = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	status: CandidateStatus,
	note: z.nullable(z.string().max(2000)),
})
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
const ExportRow = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	email: z.string(),
	status: CandidateStatus,
})
const CandidateFile = attachment({
	format: 'csv',
	filename: 'candidates.csv',
	row: ExportRow,
	maxBytes: 4194304,
})
const ExportEntry = z.strictObject({
	rowCount: z.int(),
	createdBy: z.string(),
	createdAt: z.iso.datetime(),
})
const ExportLog = z.strictObject({
	items: z.array(ExportEntry),
	next: z.nullable(z.string()),
})
const LogPage = z.strictObject({ after: Cursor.optional() })

/** The file's row limit: a larger export is refused, never cut short. */
const MAX_EXPORT_ROWS = 10000

export const candidates = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: ListCandidates,
		output: CandidatePage,
		access: { action: 'candidates.read', over: 'candidate' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Candidate,
				await ctx.db.within.candidates.list({
					where: input.status === undefined
						? []
						: [['status', '=', input.status]],
					orderBy: [['name', 'asc']],
					after: input.after,
				}),
			)
		),
	get: r.query({
		input: ById,
		output: Candidate,
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ ctx }) => fromRow(Candidate, await ctx.db.target.get())),
	history: r.query({
		input: HistoryOf,
		output: History,
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Event,
				await ctx.db.target.candidate_events.list({
					orderBy: [['created_at', 'asc']],
					after: input.after,
				}),
			)
		),
	decide: r.mutation({
		input: Decide,
		output: Saved,
		access: { action: 'candidates.review', on: 'candidate', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const candidate = await ctx.db.target.getForUpdate()
			if (!canMove(candidate.status, input.status)) {
				throw new ConflictError(
					`a ${candidate.status} candidate does not move to ${input.status}`,
				)
			}
			await ctx.db.target.candidate_events.insert({
				status: input.status,
				note: input.note,
			})
			return ctx.db.target.update({ status: input.status }, {
				expectVersion: input.expectVersion,
			})
		}),
	export: r.mutation({
		output: CandidateFile,
		access: { action: 'candidates.read', app: true },
	})
		.handle(async ({ ctx }) => {
			const rows: z.output<typeof ExportRow>[] = []
			let after: string | undefined
			do {
				const page = await ctx.db.app.candidates.list({
					orderBy: [['name', 'asc']],
					limit: 500,
					after,
				})
				rows.push(...page.items.map((row) => fromRow(ExportRow, row)))
				after = page.next ?? undefined
			} while (after !== undefined && rows.length <= MAX_EXPORT_ROWS)
			if (rows.length > MAX_EXPORT_ROWS) {
				throw new ConflictError(
					`more than ${MAX_EXPORT_ROWS} candidates: export a filtered list`,
				)
			}
			await ctx.db.app.candidate_exports.insert({ row_count: rows.length })
			return rows
		}),
	exports: r.query({
		input: LogPage,
		output: ExportLog,
		access: { action: 'exports.read', app: true },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				ExportEntry,
				await ctx.db.app.candidate_exports.list({
					orderBy: [['created_at', 'desc']],
					after: input.after,
				}),
			)
		),
}))
```

- **Application history is a table on the paved road.** `decide` writes its `candidate_events` row through the
  handle, in the invocation's one transaction: the status and its history row commit together or not at all, and
  `created_by` is the caller. There is no framework audit API; never write history from a job or after the answer.
- **An audited export of every candidate** is one `app` mutation. `ctx.db.app.candidates` lists every candidate,
  because the endpoint's action is the table's read action, and the log row goes into `candidate_exports`, whose
  insert action is that same action, in the invocation's one transaction. The file is encoded before the commit, so
  no file leaves without its row (`references/endpoint.md`). It needs no `sql` and no `unscoped`.
- **`app: true` is for data of the whole application.** The proxy admits the endpoint only for a caller who holds the
  action as a global grant: an HR member granted `candidates.read` on one candidate gets 403. `list` and `get` stay
  `over` and `on`, which serve a scoped grant too.
- `over: 'candidate'` lists every candidate a caller holds `candidates.read` on. HR holds it globally, so
  `ctx.within.values` is `'all'`.
- The generated case of `decide` sends the first status (`new`) to a record that is `new`, which `canMove` refuses
  with 409. Give it an input in `src/__tests__/endpoint-access.fixtures.ts`:

```ts src/__tests__/endpoint-access.fixtures.ts
export const fixtures = {
	'api.candidates.decide': {
		id: '00000000-0000-4000-8000-000000000000',
		expectVersion: 1,
		status: 'screening',
		note: null,
	},
}
```

## The code list an HR lead edits

```ts src/positions/endpoints.ts
import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Position = z.strictObject({
	id: z.uuid(),
	title: z.string(),
	active: z.boolean(),
	version: z.int(),
})
const Positions = z.strictObject({
	items: z.array(Position),
	next: z.nullable(z.string()),
})
const Page = z.strictObject({ after: z.string().max(500).optional() })
const NewPosition = z.strictObject({ title: z.string().min(1).max(200) })
const EditPosition = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	title: z.string().min(1).max(200),
	active: z.boolean(),
})
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })

export const positions = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: Page,
		output: Positions,
		access: { action: 'positions.read', app: true },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Position,
				await ctx.db.app.positions.list({
					orderBy: [['title', 'asc']],
					after: input.after,
				}),
			)
		),
	add: r.mutation({
		input: NewPosition,
		output: Saved,
		access: { action: 'positions.manage', app: true },
	})
		.handle(({ input, ctx }) =>
			ctx.db.app.positions.insert({ title: input.title })
		),
	edit: r.mutation({
		input: EditPosition,
		output: Saved,
		access: { action: 'positions.manage', app: true },
	})
		.handle(({ input, ctx }) =>
			ctx.db.app.positions.update(input.id, {
				title: input.title,
				active: input.active,
			}, { expectVersion: input.expectVersion })
		),
}))
```

- `ctx.db.app.<table>` of an application table has `list`, `count` and `aggregate` with its read action, `get(id)`
  with any action it names, and in a mutation `getForUpdate(id)`, `insert(v)`, `update(id, v, { expectVersion })` and
  `remove(id, { expectVersion })` with the operation's action. Its key is generated on insert.
- The HR SPA reads the list with `positions.read`; an HR lead's page adds and edits with `positions.manage`. A
  position that is no longer open is deactivated, so a record that names it keeps its meaning.
- Only an `app` endpoint reads an application table. A code list that a link holder or a scoped endpoint must read
  is a reference table instead (`references/table-and-migration.md`), changed by a migration.

## Tests

- The generated tests cover HR's endpoints, the files and the link's procedures: the endpoint access kit asks each
  link procedure as a holder of a key bound to a seeded candidate. Each `app` endpoint gets two cases: a holder of
  its action in one candidate only is 403, and a global holder reaches it. `positions` and `candidate_exports` get a
  policy probe of their actions, held globally and in one scope. They pass here because only the job issues links;
  an endpoint that `issues` needs IAM in its tests (`SKILL.md`, "Not built yet").
- Your own test of a link procedure makes the holder `kit.testCaller([{ action: 'candidates.verify', scope: { type:
  'candidate', value: id } }], { kind: 'link', link: { mount: 'portal', chain: [{ type: 'candidate', value: id }] }
  })` and calls `createClient(contract, 'portal', { fetch: kit.fetch, key: holder.key ?? '' })`.
- The job asks IAM to issue and revoke links, so `kit.runJob('intake')` needs `testKit(app, { membership })` with an
  `IamMembershipRpc` of your own that answers `issueLink` and `revokeLink`. A test of a form passes `env: {
  TURNSTILE_SECRET: '…' }` and `challengeFetch`, a stand-in for Turnstile's answer, to `testKit`. Test each stop of a
  delivery (a refused e-mail, IAM down, a crash after each step): the next run must leave exactly one live, e-mailed
  link.
- A test that submits a form kicks the job too, and the kicked run may start at once: arm a fault before the
  submission, never between it and the run. `kit.runJob('intake')` first waits for the kicked runs, then runs once.
