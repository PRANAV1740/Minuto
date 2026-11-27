/**
 * The Minuto schema, as a string rather than a .sql file on disk.
 *
 * It began as `schema.sql` read at startup, which broke the moment the store
 * was imported into a bundled Next.js server: the bundle has no `schema.sql`
 * beside it, and `import.meta.url` no longer points where the source did.
 * A module constant travels with the code through any bundler, so it works
 * identically from the CLI, the tests and the web app.
 *
 * Applied by `createPostgresStore` on first use and safe to re-run: every
 * statement is idempotent.
 *
 * Shapes follow docs/ARCHITECTURE.md §6. Two deliberate choices:
 *
 *   * Action items are rows, not JSON inside the minutes, because "everything
 *     assigned to me across every meeting" is the query that makes this useful
 *     daily, and because the editor has to change one without rewriting the
 *     document around it.
 *
 *   * The minutes payload IS stored as JSON. It is a whole document read and
 *     written together and never queried field by field, so columns would buy
 *     nothing and cost a migration every time the shape moves.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meetings (
  id            UUID PRIMARY KEY,
  owner_id      TEXT        NOT NULL,
  meet_code     TEXT,
  title         TEXT        NOT NULL,
  meeting_date  DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Monotonic, so two meetings created in the same millisecond still have a
  -- defined order in the listing.
  sort_key      BIGSERIAL   NOT NULL
);

CREATE INDEX IF NOT EXISTS meetings_owner_idx ON meetings (owner_id, sort_key DESC);

CREATE TABLE IF NOT EXISTS transcript_segments (
  meeting_id    UUID    NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  t_start_ms    INTEGER NOT NULL,
  text          TEXT    NOT NULL,
  speaker_name  TEXT,
  PRIMARY KEY (meeting_id, seq)
);

CREATE TABLE IF NOT EXISTS minutes (
  id          UUID PRIMARY KEY,
  meeting_id  UUID        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL,
  payload     JSONB       NOT NULL,
  markdown    TEXT        NOT NULL,
  written_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Versions are kept, never overwritten, so regenerating never destroys the
  -- set somebody already circulated.
  UNIQUE (meeting_id, version)
);

CREATE TABLE IF NOT EXISTS action_items (
  id           UUID PRIMARY KEY,
  meeting_id   UUID      NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  minutes_id   UUID      NOT NULL REFERENCES minutes (id) ON DELETE CASCADE,
  task         TEXT      NOT NULL,
  owner_name   TEXT,
  due_date     DATE,
  confidence   TEXT      NOT NULL DEFAULT 'medium',
  status       TEXT      NOT NULL DEFAULT 'open',
  source_seqs  INTEGER[] NOT NULL DEFAULT '{}',
  CONSTRAINT action_items_status_check CHECK (status IN ('open', 'done', 'dropped')),
  CONSTRAINT action_items_confidence_check CHECK (confidence IN ('high', 'medium', 'low'))
);

CREATE INDEX IF NOT EXISTS action_items_meeting_idx ON action_items (meeting_id);
CREATE INDEX IF NOT EXISTS action_items_owner_idx   ON action_items (owner_name, status);
`;
