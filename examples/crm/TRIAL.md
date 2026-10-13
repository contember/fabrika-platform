# The fresh-agent trial on the CRM

Inputs for part 3 of WU11 in `docs/archive/sprint-2026-10-11-paved-road-framework.md`. A trial agent sees only the
`fabrika-app` skill files of `@fabrika/app` (`packages/app/skill/`) and a copy of `examples/crm` with one endpoint
group removed. It writes that group from the brief below. The pass: at most 3 tsc and checker runs per group in total
(tsc and `fabrika-check` added together), no edited generated file, and no loosened access to make a test pass. Record
every tsc and checker run, and how many of them failed. Regenerating files with `fabrika db codegen` or `fabrika db
test-scaffold` is the skill's loop, not an edit.

## The groups

| Group | Brief                | Removed from the copy                    | Reference implementation                          |
| ----- | -------------------- | ---------------------------------------- | ------------------------------------------------- |
| A     | Companies & contacts | `src/companies/`, `src/contacts/`        | 10 endpoints                                      |
| B     | Deals                | `src/deals/`                             | 9 endpoints, `logic.ts`                           |
| C     | Tasks                | `src/tasks/`, the `overdue` job          | 3 endpoints and one cron job                      |
| D     | Activities           | `src/activities/`                        | 4 endpoints on two child tables                   |
| E     | Orgs and people      | `src/orgs/endpoints.ts` (not `logic.ts`) | 2 endpoints, one reads the org's member directory |

## The starting copy

For the group under trial, from the root of a fabrika-platform checkout that still holds `examples/crm`:

1. Copy `examples/crm` to `examples/crm-trial-<group>/` (lowercase, such as `crm-trial-c`) and set its
   `package.json` `name` to `fabrika-example-crm-trial-<group>`. Bun refuses two workspaces of one name, so the copy
   must not keep `fabrika-example-crm`.
2. In the copy, delete what the table names, with its `__tests__/`. Group E keeps `src/orgs/logic.ts`: the deals and
   tasks slices pick a person with its `picked`.
3. In `fabrika.contract.ts`, delete the group's imports and its keys in `c.rpc('/api', { … })`. For group C also delete
   the `jobs: { overdue }` section. Leave the
   `attachments` collection, the SPA mount and the health check.
4. Delete `src/__tests__/endpoint-access.test.ts` (the agent regenerates it with `fabrika db test-scaffold`) and the
   authored tests that call the group: `src/__tests__/crm.test.ts` always, `src/deals/__tests__/deals.test.ts` and
   `src/tasks/__tests__/overdue.test.ts` (it creates a company and a deal) for A and B. Keep them for the judge.
5. In `src/__tests__/endpoint-access.fixtures.ts`, delete every `seeds` and `members` entry of a removed endpoint, and
   keep the others (the checker refuses an entry of an endpoint that does not exist): for B the two `api.deals.*` seeds
   and `members['api.deals.assign']`, for C `members['api.tasks.create']`. A, D and E change nothing there.
6. Delete the SPA, which calls every group by name and is not part of the trial: `web/`, `build-web.ts`, the
   `build:web` script of `package.json`, the `- bun run build:web` line of `zerops.yaml`, and `"web/**/*"` from the
   `include` of `tsconfig.json`. Delete this file too.
7. Run `bun install` at the checkout's root, then in the copy `bunx fabrika db test-scaffold`. The copy starts green:
   `bunx tsc --noEmit`, `bunx fabrika-check .` (0 refusals, 0 hints) and `bun test --isolate` with
   `FABRIKA_TEST_POSTGRES_URL` set. Checked on WU22 beside `examples/crm` for C (139 tests pass) and E (143),
   and on WU25 for B (111).

Everything else is the agent's starting point and stays unchanged: the rest of `package.json`, `tsconfig.json` and
`zerops.yaml`, `fabrika.config.ts`, `src/vocabulary.ts`, `db/migrations/20261012120000_crm.sql`,
`src/db/schema.generated.ts`, `src/db/tables.ts`, `src/db/__tests__/*.policy-isolation.test.ts`, `src/app-kit.ts`,
`src/app.ts`, `src/schemas.ts`, `src/orgs/logic.ts` and the other groups' slices. No group needs a new migration, table policy, action or
role. An agent that adds one must ask first (the skill's "Ask the human first"); count it as a deviation from the
brief.

### The vocabulary (`src/vocabulary.ts`)

- Dimensions: `org` (IAM grants roles in it; its members are listed with `crm.read`, labels included), `company` in
  `org`, `contact` and `deal` in `company`, `task` in `deal`.
- Actions: `crm.read` (read everything and the org's members), `crm.write` (companies and contacts), `crm.delete`
  (companies, contacts, deals, attachments), `deals.write` (create, edit, move, attach), `deals.assign` (a deal's
  owner), `tasks.write`, `activities.write`, `members.manage`.
- Roles, each a member role in one org, assigned by a manager: `manager` (every action), `sales` (`crm.read`,
  `deals.write`, `tasks.write`, `activities.write`), `viewer` (`crm.read`).

### The tables (`src/db/tables.ts`, one migration)

| Table                | Scope               | Read       | Insert             | Update                                                                                     | Delete       |
| -------------------- | ------------------- | ---------- | ------------------ | ------------------------------------------------------------------------------------------ | ------------ |
| `companies`          | dimension `company` | `crm.read` | `crm.write`        | `crm.write`: `name`, `website`                                                             | `crm.delete` |
| `contacts`           | dimension `contact` | `crm.read` | `crm.write`        | `crm.write`: `name`, `email`, `phone`                                                      | `crm.delete` |
| `deals`              | dimension `deal`    | `crm.read` | `deals.write`      | `deals.write`: `title`, `value`, `stage`, `source`; `deals.assign`: `owner`, `owner_label` | `crm.delete` |
| `tasks`              | dimension `task`    | `crm.read` | `tasks.write`      | `tasks.write`: `done`, `overdue`                                                           | —            |
| `contact_activities` | child of `contacts` | `crm.read` | `activities.write` | —                                                                                          | —            |
| `deal_activities`    | child of `deals`    | `crm.read` | `activities.write` | —                                                                                          | —            |

Every table but the two activity tables has `version` and `created_by`; the activity tables have `created_by` and
`created_at`. `deals.stage` is the enum `deal_stage` (`lead`, `qualified`, `proposal`, `won`, `lost`); `value` is an
integer; `source` is nullable text; `owner` and `owner_label` are required text. `tasks.due_on` is a required `date`;
`assignee` and `assignee_label` are required text; `done` and `overdue` default to false. An activity's `kind` is the
enum `activity_kind` (`note`, `call`, `email`, `meeting`); `body` and `author_label` are required text. The
`attachments` collection belongs to `deals` and has no handler.

`src/schemas.ts` holds what several slices, or a slice and the SPA, share: `DEAL_STAGES`, `MAX_ATTACHMENT_BYTES`,
`MAX_ATTACHMENTS_PER_DEAL`, `Stage`, `Name`, `OptionalText` (a create's field the caller may leave out),
`ClearableText` (an edit's field the caller may clear), `MaybeText`, `ScopeValue`, `Cursor`, `Next`, `PrincipalId`,
`ById`, `Page`, `Versioned`, `Saved`, `Done`. A slice's own schemas live in its `endpoints.ts`.

## The briefs

Written as the product owner asks for the feature. Hand the agent the brief of its group only.

### A — Companies and contacts

Our salespeople keep the companies they work with, each in one of their orgs. Everyone in an org can browse the
companies of all the orgs they belong to, a page at a time, sorted by name, and open one. The company shows its org,
because the deal screen needs to know whose people it can offer. Only a manager adds a company to one of their orgs,
renames it, changes its website or deletes it. Deleting a company deletes its contacts and deals. When two people edit
the same company at once, the second save is refused, so nobody overwrites a change they have not seen.

Contacts are the people at a company: a name, and an e-mail address and a phone number when we have them. The same
rules hold: everyone in the org can browse the contacts of every company they can see, sorted by name, and open one;
only a manager adds, edits and deletes them.

### B — Deals

A deal is an opportunity at a company: a title, a value in whole euros, a stage in our pipeline (lead, qualified,
proposal, won, lost) and, when we know it, where it came from (a referral, an event: free text). Salespeople and
managers open deals at a company, edit the title, value and source, and move a deal from stage to stage. A won or lost
deal is closed: it cannot be moved anymore, but a salesperson can reopen it, which puts it back to proposal. Only a
closed deal can be reopened. Two people acting on the same deal at the same moment must never both succeed.

Whoever opens a deal owns it. Only a manager hands a deal over to another person of the org, picked from the org's
people. Only a manager deletes a deal. Everyone in the org can browse the deals they can see, a page at a time, sorted
by title, and open one.

The pipeline overview shows every stage in pipeline order, the empty ones too, with how many of the deals the person
may see are in it and their total value, across all of their orgs.

### C — Tasks

Tasks are follow-ups on a deal: a title, the day it is due, and the person responsible. Salespeople and managers add a
task to a deal. When they pick nobody, the task is theirs; otherwise it goes to the person of the org they picked.
They tick a task done, and can untick it. Everyone in the org sees the tasks of all the deals they can see, a page at
a time, the earliest due first.

Every hour, the system marks the open tasks whose due day has passed as overdue, and leaves the done ones alone. A run
that fails halfway and starts again must not mark a task twice or fail on one it already marked.

### D — Activities

People record what happened with a contact or a deal: a note, a call, an e-mail or a meeting, with a text of up to
5000 characters. Salespeople and managers record them. Everyone in the org reads the history of one contact or one
deal, newest first, a page at a time; each entry shows its kind, its text, who wrote it and when. Nobody edits or
deletes an entry; it goes only with the contact or deal it belongs to.

### E — Orgs and people

The app has to know which orgs the signed-in person works in, so that the new-company form can offer them. It also
lists the people of one org with their names, so that the deal-owner and task-assignee pickers can offer them. Only a
member of that org may see its people.

## Judging a run

- **Runs.** Count each `tsc --noEmit` and each `fabrika-check` the agent starts for the group, both tools together.
  Pass: at most 3 in total. Report the number of failing runs beside it (a run with an error or a refusal); it is a
  metric, not a pass criterion.
- **Generated files.** `git diff` of the copy shows no hand edit of `src/db/schema.generated.ts` or of a generated
  test: `fabrika-check`'s `generated-test-hash` refuses one, and `bunx fabrika db codegen --verify` the schema.
- **Access.** Compare the group's endpoint table with the reference: `compileContract` of both, or Control's
  `classifyAccess` with the reference as the baseline. Pass: no endpoint with a wider action or access form than the
  brief needs, no new role or grant, no new declared deviation.
- **Behaviour.** Run the reference `src/__tests__/crm.test.ts` and `src/deals/__tests__/deals.test.ts` against the
  agent's group after renaming its endpoints to the reference names, or judge by reading. The briefs fix the behaviour,
  not the names.
