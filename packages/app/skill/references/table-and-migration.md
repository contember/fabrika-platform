# references/table-and-migration.md — the vocabulary, migrations and table policies

The order is fixed: the vocabulary, then the migration, then `fabrika db migrate` and `fabrika db codegen`, then the
table policies, which take the generated `columns`.

## The vocabulary

```ts src/vocabulary.ts
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'tasks',
	dimensions: {
		org: { members: { manage: 'members.manage', list: 'tasks.read' } },
		project: { in: 'org' },
		task: { in: 'project' },
	},
	actions: {
		'tasks.read': 'Read projects, tasks and comments',
		'tasks.write': 'Create and edit projects, tasks and comments',
		'tasks.assign': 'Assign a task to a member',
		'members.manage': 'Invite and remove members',
	},
	roles: {
		owner: {
			grants: ['tasks.read', 'tasks.write', 'tasks.assign', 'members.manage'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
		member: {
			grants: ['tasks.read', 'tasks.write'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
	},
})
```

- A **dimension** is a kind of scope value. `in` is its container: every task lies in one project, every project in
  one org. A grant on a container reaches everything inside it. A top-level dimension (`org`) is the value IAM grants
  roles in; no table needs to own it.
- An **action** is an exact name; a role lists actions and there is no `*`. Give an operation that only some roles
  may do its own action (`tasks.assign`).
- A **membership role** (`member: { scope, assignableBy }`) is granted in one value of `scope`. `external: true` on
  one lets a person from outside the organization (a partner's account) hold it; IAM gives such a person no other
  role. `{ member: true }` then admits them too, so a staff-only endpoint names an action only internal roles grant.
  `ctx.members` answers each member's `affiliation`.
  `members: { manage, list }` on a dimension gives `ctx.members` to the endpoints on, in or below it: a lookup of one
  member everywhere, the list with `list`, management with `manage` (`references/endpoint.md`).
- `admin` is reserved: IAM defines it for every application. `defineVocabulary` refuses it.
- `locale: 'cs'` (or `'en'`) and `displayName: 'Tasks'` beside `app` set the language and the name IAM uses for the
  application on its sign-in, password and invitation pages and e-mails. Without `locale` IAM speaks its default
  language, `en`. Without `displayName` the sign-in and password pages and mails name no application, and an invitation
  names it by its id (`tasks@prod`). The approver sees each change.
- `mail` beside them words IAM's e-mails in the application's own way: per message (`invitation`, `enrollment`,
  `reset`) and language, a one-line `subject` and a plain `text` with `{{name}}` placeholders, for example
  `mail: { reset: { cs: { subject: 'Nové heslo do {{displayName}}', text: 'Heslo si nastavíte zde:\n{{actionUrl}}' } } }`.
  The text must hold `{{actionUrl}}`, the one-time link IAM builds, and the subject must not; IAM writes the HTML part
  itself. Every message fills
  `{{displayName}}`, `{{recipient}}`, `{{actionUrl}}` and `{{expiry}}`; an invitation also `{{inviterLabel}}`,
  `{{companyLabel}}` and `{{message}}`. Another placeholder is refused. A message or language without a template is IAM's
  own wording.
- `creator: '<role>'` on a top-level dimension lets an endpoint with `creates: '<dimension>'` make a new value and
  grant the caller that role there.

## The migration

```sql db/migrations/20261012090000_tasks.sql
-- An org is the scope IAM grants roles in; no table owns it. Every contained table repeats its container's chain and
-- references UNIQUE (id, <chain>) of its container, so a moved project moves its tasks.
CREATE TABLE projects (
	id UUID PRIMARY KEY,
	org_id TEXT NOT NULL,
	name TEXT NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, org_id)
);
CREATE INDEX projects_org ON projects (org_id);

CREATE TYPE task_status AS ENUM ('open', 'doing', 'done');

CREATE TABLE tasks (
	id UUID PRIMARY KEY,
	project_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	title TEXT NOT NULL,
	status task_status NOT NULL DEFAULT 'open',
	assignee TEXT,
	assignee_label TEXT,
	due_on DATE,
	overdue BOOLEAN NOT NULL DEFAULT false,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, project_id, org_id),
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON UPDATE CASCADE
);
CREATE INDEX tasks_project ON tasks (project_id);

CREATE TABLE task_comments (
	id UUID PRIMARY KEY,
	task_id UUID NOT NULL,
	project_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	body TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (task_id, project_id, org_id) REFERENCES tasks (id, project_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX task_comments_task ON task_comments (task_id);

CREATE TABLE project_exports (
	id UUID PRIMARY KEY,
	project_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	row_count INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX project_exports_project ON project_exports (project_id);

-- A code list: shared rows that every endpoint reads, and only a migration writes.
CREATE TABLE priorities (
	code TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	rank INTEGER NOT NULL
);
INSERT INTO priorities (code, label, rank) VALUES ('low', 'Low', 1), ('normal', 'Normal', 2), ('high', 'High', 3);
```

- `bunx fabrika db new <slug>` writes `db/migrations/<UTC YYYYMMDDHHMMSS>_<slug>.sql`. Without a shell, use that name.
- The key is `id`. A contained table has `<container>_id` and every column of its container's chain (`project_id`,
  `org_id`), `UNIQUE (id, <chain>)`, and a composite foreign key `(<container>_id, <chain>) → <container
  table> (id, <chain>)`. A child table (`task_comments`) does the same with its parent. Without the composite key the
  table policy is refused, and an `over` list cannot reach the table from an outer dimension.
- `version INTEGER NOT NULL` makes `expectVersion` and the 409 work; `created_by TEXT NOT NULL` with `createdBy` in
  the policy records the caller. The data layer generates `id` and writes `version` and `created_by`.
- A column with a fixed set of values is an `ENUM` type, not a `CHECK` on text: the generated tests fill text columns
  with markers, which a `CHECK` refuses.
- Codegen types: `date` is a `YYYY-MM-DD` string; `timestamptz` reads a `Date` and takes a `Date` or a strict ISO 8601 string with `Z` or an offset;
  `int8` and `numeric` are strings; an enum is its literal union. JSON, `bytea`, arrays and domains are refused.
- Plain SQL of the application's own schema only. Refused: another schema (`public.`, `app_…`), any `fabrika_*`
  object (except a file collection's table, `references/files.md`), `GRANT`, roles, `CREATE EXTENSION`, `COPY`,
  `SET`, transaction control, `SECURITY DEFINER`, a domain, `serial` and sequences (use `GENERATED ALWAYS AS IDENTITY`),
  a function overload, and calls outside the reviewed built-ins.
- Never edit, rename or delete a committed migration; add a new one. Change a schema by expand, switch, contract, and
  ask before you drop or rename anything.

## Database code is a declared deviation

A function, trigger, view, rule, policy or `DO` block in a migration is allowed. The migration file declares it, and
the approver sees it marked "needs closer review". Prefer a handler when the rule is the application's; use database
code when it must hold for every writer.

```sql db/migrations/20261012110000_done_clears_overdue.sql
CREATE FUNCTION tasks_done_clears_overdue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status = 'done' THEN
		NEW.overdue := false;
	END IF;
	RETURN NEW;
END
$$;

CREATE TRIGGER tasks_done_clears_overdue BEFORE UPDATE ON tasks
	FOR EACH ROW EXECUTE FUNCTION tasks_done_clears_overdue();
```

The platform runs `fabrika db codegen --verify` at every start; it fails when the schema holds database code that no
migration declares.

## The table policies

```ts src/db/tables.ts
import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
		insert: ['name'],
		update: ['name'],
		version: 'version',
		createdBy: 'created_by',
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: {
			read: 'tasks.read',
			insert: 'tasks.write',
			update: 'tasks.write',
			delete: 'tasks.write',
		},
		insert: ['title', 'due_on'],
		update: ['title', 'status', 'due_on', 'overdue'],
		version: 'version',
		createdBy: 'created_by',
		columns: {
			assignee: { write: 'tasks.assign' },
			assignee_label: { write: 'tasks.assign' },
		},
	},
	task_comments: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['body'],
		createdBy: 'created_by',
	},
	project_exports: {
		scope: { child: 'projects' },
		actions: { read: 'tasks.read', insert: 'tasks.read' },
		insert: ['row_count'],
		createdBy: 'created_by',
	},
	priorities: {
		scope: { reference: 'the priority codes; a migration changes them' },
		actions: { read: 'tasks.read' },
	},
})
```

- Every table has a policy. Its scope is one of: `{ dimension: '<d>' }` (the table owns the dimension's values),
  `{ child: '<table>' }` (rows that belong to one row of the parent), `{ app: '<why>' }` (rows of the whole
  application, such as a code list an administrator edits) or `{ reference: '<why>' }` (shared rows every endpoint
  reads and none writes; a migration changes them).
- An application table takes `actions`, `insert`, `update`, `version`, `createdBy` and `columns` like a dimension
  table, and no container. Only an `app: true` endpoint reaches it (`ctx.db.app.<table>`, `references/endpoint.md`),
  and only a caller who holds the operation's action as a global grant. Data that a link holder or a scoped member
  reads stays a reference table.
- A reference table (`priorities`) takes `actions: { read: '<action>' }` and, at most, `columns` with read actions: no
  `insert`, `update`, `version` or `createdBy`. Its rows change by a migration only. No handle writes it, and
  `unscoped: { priorities: 'write' }` is refused by tsc and the checker.
- The key (`id`), the container column (`<container>_id`), a child's column (`<parent dimension>_id`) and the chain
  are derived. State `in: { column }` or `column` only off that convention.
- `actions` maps `read`, `insert`, `update` and `delete` to vocabulary actions. `insert` and `update` list the columns
  that those actions write; nothing else is writable.
- `columns: { <column>: { read: '<action>' } }` hides a column from every capability of another action, in the data
  and in the types. `columns: { <column>: { write: '<action>' } }` lets only that action update the column (and that
  action updates nothing else); the column is then not in `update`.
- A column has one write action. A state that two actions change is two columns: in `references/public-intake.md` the
  link holder's `candidates.verify` sets `verified_at`, HR's `candidates.review` sets `status`, and `logic.ts` derives
  the stage HR sees from both (`stageOf`).
- An audit or history table is an ordinary child table that a handler writes in its own transaction:
  `project_exports` logs each export of a project's tasks, so its insert action is the export's read action
  (`references/endpoint.md`). The log of an export across every record is an application table instead
  (`references/public-intake.md`). There is no framework audit API.
- IAM already audits sign-ins (its auth log, refusals included) and every grant and revocation (its admin events
  `iam.grant.create` and `iam.grant.revoke`): do not rebuild either in the application. An operator's access to the
  database or to the provider's console is outside Fabrika.
