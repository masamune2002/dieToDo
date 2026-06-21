# Dice To-Do

A to-do app where a 3D physics die picks your next task. Front-end is a single
self-contained `static/index.html` (Three.js + Rapier via CDN); persistence is a
small **Axum + SQLite** backend.

## Run

```bash
cargo run                 # builds + starts the server on http://localhost:3000
# then open http://localhost:3000
```

Config via env vars:

- `PORT` — listen port (default `3000`)
- `DATABASE_URL` — SQLite URL (default `sqlite://todo.db?mode=rwc`, created if missing)

The SQLite file (`todo.db`) is created in the working directory on first run and
is git-ignored.

## API

| Method | Path         | Body / Response |
|--------|--------------|-----------------|
| `GET`  | `/api/state` | → `{ seeded: bool, master: [{id,text}], daily: [{id,text}] }` |
| `PUT`  | `/api/state` | ← `{ master: [{id,text}], daily: [{id,text}] }` — replaces all, returns `204` |

The front-end writes the whole state on every change (the lists are small), so
the `PUT` handler replaces the table contents in a transaction. `seeded`
distinguishes a brand-new server from one the user has deliberately emptied, so
the example tasks are only seeded once. If the server is unreachable the
front-end falls back to `localStorage`.

### Schema

```sql
tasks(id TEXT PK, text TEXT, list TEXT CHECK(list IN ('master','daily')), position INTEGER)
meta(key TEXT PK, value TEXT)        -- holds the 'seeded' flag
```

## Tests

Headless-Chromium checks (require the server running on `:3000`):

```bash
node verify_persist.mjs   # seed → save → reload-from-DB (localStorage cleared)
node verify_todo.mjs      # full UI regression (layout, drag, die mapping, overlay)
node verify_contain.mjs   # die stays on-screen across window sizes
```
