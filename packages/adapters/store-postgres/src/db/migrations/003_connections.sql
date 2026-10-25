ALTER TABLE connections DROP CONSTRAINT connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check CHECK (kind IN ('mcp','webhook'));
ALTER TABLE connections ADD COLUMN secret text;
