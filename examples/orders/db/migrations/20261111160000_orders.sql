-- The firm is the scope value IAM grants in; no table owns it. A customer lies in the firm, an order in a customer, and
-- every contained table repeats its container's chain and references UNIQUE (id, <chain>) of its container.
CREATE TABLE customers (
	id TEXT NOT NULL PRIMARY KEY,
	firm_id TEXT NOT NULL,
	name TEXT NOT NULL,
	ico TEXT NOT NULL,
	city TEXT NOT NULL,
	email TEXT NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, firm_id)
);
CREATE INDEX customers_firm ON customers (firm_id);

-- The relation source: each row names the salesperson who handles one customer. The customer's name and city go with
-- it, so a salesperson lists their customers from their own assignments.
CREATE TABLE customer_reps (
	id TEXT NOT NULL PRIMARY KEY,
	customer_id TEXT NOT NULL,
	firm_id TEXT NOT NULL,
	principal_id TEXT NOT NULL,
	label TEXT NOT NULL,
	customer_name TEXT NOT NULL,
	customer_city TEXT NOT NULL,
	created_by TEXT NOT NULL,
	FOREIGN KEY (customer_id, firm_id) REFERENCES customers (id, firm_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX customer_reps_principal ON customer_reps (principal_id, customer_id);

CREATE TABLE orders (
	id TEXT NOT NULL PRIMARY KEY,
	customer_id TEXT NOT NULL,
	firm_id TEXT NOT NULL,
	number TEXT NOT NULL,
	customer_name TEXT NOT NULL,
	title TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('nova', 'potvrzena', 'expedovana', 'dorucena', 'zrusena')),
	due_on DATE NOT NULL,
	amount_czk INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, customer_id, firm_id),
	FOREIGN KEY (customer_id, firm_id) REFERENCES customers (id, firm_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX orders_customer ON orders (customer_id);

-- The invoicing records of an order: what accounting bills, and whether it has been billed.
CREATE TABLE billing (
	id TEXT NOT NULL PRIMARY KEY,
	order_id TEXT NOT NULL,
	customer_id TEXT NOT NULL,
	firm_id TEXT NOT NULL,
	amount_czk INTEGER NOT NULL,
	vat_rate INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pripraveno', 'vyfakturovano')),
	invoice_number TEXT,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	FOREIGN KEY (order_id, customer_id, firm_id) REFERENCES orders (id, customer_id, firm_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX billing_order ON billing (order_id);
