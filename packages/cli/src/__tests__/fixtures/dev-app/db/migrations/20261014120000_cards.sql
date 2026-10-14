-- A card lies on a board, the scope value IAM grants in; no table owns the board itself.
CREATE TABLE cards (
	id UUID PRIMARY KEY,
	board_id TEXT NOT NULL,
	title TEXT NOT NULL,
	created_by TEXT NOT NULL
);
