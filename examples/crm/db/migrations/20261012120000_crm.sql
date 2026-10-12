-- The CRM's schema. An org is the scope value IAM grants roles in; no table owns it. A company lies in an org, a
-- contact and a deal in a company, a task in a deal. Every row carries its whole containment chain, and each contained
-- table references UNIQUE (id, <chain>) of its container, so a moved company moves its contacts, deals and tasks.

CREATE TYPE deal_stage AS ENUM ('lead', 'qualified', 'proposal', 'won', 'lost');
CREATE TYPE activity_kind AS ENUM ('note', 'call', 'email', 'meeting');

CREATE TABLE companies (
	id UUID PRIMARY KEY,
	org_id TEXT NOT NULL,
	name TEXT NOT NULL,
	website TEXT,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, org_id)
);
CREATE INDEX companies_org ON companies (org_id);

CREATE TABLE contacts (
	id UUID PRIMARY KEY,
	company_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	name TEXT NOT NULL,
	email TEXT,
	phone TEXT,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, company_id, org_id),
	FOREIGN KEY (company_id, org_id) REFERENCES companies (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX contacts_company ON contacts (company_id);

-- `source` is where a deal came from (a referral, an event), free text; `owner` is the member who owns it.
CREATE TABLE deals (
	id UUID PRIMARY KEY,
	company_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	title TEXT NOT NULL,
	value INTEGER NOT NULL,
	stage deal_stage NOT NULL,
	source TEXT,
	owner TEXT NOT NULL,
	owner_label TEXT NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, company_id, org_id),
	FOREIGN KEY (company_id, org_id) REFERENCES companies (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX deals_company ON deals (company_id);

CREATE TABLE tasks (
	id UUID PRIMARY KEY,
	deal_id UUID NOT NULL,
	company_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	title TEXT NOT NULL,
	due_on DATE NOT NULL,
	assignee TEXT NOT NULL,
	assignee_label TEXT NOT NULL,
	done BOOLEAN NOT NULL DEFAULT false,
	overdue BOOLEAN NOT NULL DEFAULT false,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, deal_id, company_id, org_id),
	FOREIGN KEY (deal_id, company_id, org_id) REFERENCES deals (id, company_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX tasks_deal ON tasks (deal_id);
CREATE INDEX tasks_open_due ON tasks (due_on) WHERE NOT done;

-- Activities are notes on a contact or on a deal. A child table has one parent, so each parent has its own table.
CREATE TABLE contact_activities (
	id UUID PRIMARY KEY,
	contact_id UUID NOT NULL,
	company_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	kind activity_kind NOT NULL,
	body TEXT NOT NULL,
	author_label TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (contact_id, company_id, org_id) REFERENCES contacts (id, company_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX contact_activities_contact ON contact_activities (contact_id);

CREATE TABLE deal_activities (
	id UUID PRIMARY KEY,
	deal_id UUID NOT NULL,
	company_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	kind activity_kind NOT NULL,
	body TEXT NOT NULL,
	author_label TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (deal_id, company_id, org_id) REFERENCES deals (id, company_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX deal_activities_deal ON deal_activities (deal_id);

-- The `attachments` collection of a deal, as fileTableSql('attachments', { table: 'deals', … }) writes it.
CREATE TABLE fabrika_files_attachments (
	id UUID PRIMARY KEY,
	owner_id UUID,
	company_id UUID,
	org_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'live')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	content_type TEXT NOT NULL,
	sha256 TEXT,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ,
	FOREIGN KEY (owner_id, company_id, org_id) REFERENCES deals (id, company_id, org_id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX fabrika_files_attachments_owner ON fabrika_files_attachments (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX fabrika_files_attachments_removable ON fabrika_files_attachments (created_at) WHERE deleted_at IS NOT NULL OR owner_id IS NULL OR status = 'pending';
