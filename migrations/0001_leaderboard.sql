-- Players: a name and a hash of the secret the device keeps. No account, no email, no IP.
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The name as it is compared (src/server/names.ts): one device per folded name.
  folded TEXT NOT NULL UNIQUE,
  -- SHA-256 of the secret, hex.
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Set by an admin: the identity no longer works, its runs are gone, and the name stays taken.
  banned_at INTEGER
);

-- Each player's best run per board (track + rules), with the replay it was filed from.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (id),
  track TEXT NOT NULL,
  rules INTEGER NOT NULL,
  -- The server's own time (Math.floor of runReplay), whole milliseconds.
  time_ms INTEGER NOT NULL,
  steering TEXT NOT NULL,
  -- The replay as text (replayToText).
  replay TEXT NOT NULL,
  -- When this run was posted, in ms: of two equal times the earlier one ranks first.
  posted_at INTEGER NOT NULL,
  UNIQUE (player_id, track, rules)
);

CREATE INDEX runs_by_board ON runs (track, rules, time_ms, posted_at, id);
