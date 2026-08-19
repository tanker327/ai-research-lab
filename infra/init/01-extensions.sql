-- db bootstrap: extensions needed by the schema (trigram for claim canonicalization, design §10)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
