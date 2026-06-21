# Dice To-Do

A to-do app where a 3D physics die picks your next task. Front-end is a single
self-contained `static/index.html` (Three.js + Rapier via CDN); the backend is a
small **Axum + SQLite** server with username/password auth and per-user lists.

## Run

```bash
cargo run                 # builds + starts the server on http://localhost:3000
# then open http://localhost:3000 and sign in
```

On first run an **`admin`** user is created. Its password is taken from
`ADMIN_PASSWORD` if set, otherwise randomly generated and **printed to the
server log** (shown once):

```
  Created admin user
    username: admin
    password: q8F3...        <- copy this
```

Config via env vars:

- `PORT` — listen port (default `3000`)
- `DATABASE_URL` — SQLite URL (default `sqlite://todo.db?mode=rwc`, created if missing)
- `ADMIN_PASSWORD` — initial admin password (optional; generated + logged if unset)

The SQLite file (`todo.db`) is created in the working directory and is
git-ignored.

## Accounts & data

- Sign in on the login screen. Each user has their **own** master/Today lists.
- An **admin** sees a **Users** button (top of the Master column) → a panel to
  list, add (username + password + role), and remove users. New users start
  with an empty list; the auto-created admin gets the demo tasks on first login.
- Admins can't delete their own account (avoids lockout). Removing a user also
  deletes their tasks and active sessions.

## API

| Method | Path             | Body / Response | Auth |
|--------|------------------|-----------------|------|
| `POST`   | `/api/login`     | `{ username, password }` → sets `session` cookie | — |
| `POST`   | `/api/logout`    | clears the session | — |
| `GET`    | `/api/me`        | `{ username, role }` | session |
| `GET`    | `/api/state`     | `{ seeded, master, daily }` (this user's lists) | session |
| `PUT`    | `/api/state`     | `{ master, daily }` → `204` (replaces this user's lists) | session |
| `GET`    | `/api/users`     | `[{ id, username, role }]` | admin |
| `POST`   | `/api/users`     | `{ username, password, role }` → `{ id, username, role }` | admin |
| `DELETE` | `/api/users/{id}`| `204` | admin |

Auth is a cookie session (`HttpOnly`, `SameSite=Lax`, 7-day expiry); passwords
are hashed with **Argon2**. The front-end writes the whole state on every change
(the lists are small), so `PUT /api/state` replaces that user's rows in a
transaction. `seeded` distinguishes a brand-new account from one the user has
deliberately emptied, so demo tasks are seeded at most once.

### Schema

```sql
users(id PK, username UNIQUE, password_hash, role, seeded, created_at)
sessions(token PK, user_id, expires_at)
tasks(id, user_id, text, list CHECK(list IN ('master','daily')), position, PRIMARY KEY(user_id, id))
```

> Security note: cookies are not flagged `Secure` (so it works over plain HTTP on
> localhost). Put the server behind HTTPS and add the `Secure` flag before
> exposing it publicly. No SSO yet.

## Tests

Headless-Chromium checks. They log in as `admin`/`adminpass`, so run the server
with a **fresh DB** and that password:

```bash
rm -f todo.db; ADMIN_PASSWORD=adminpass cargo run &     # fresh server
node verify_auth.mjs      # login screen, admin login, user CRUD, per-user isolation
node verify_persist.mjs   # seed → save → reload-from-DB (server-side persistence)
node verify_todo.mjs      # full UI regression (layout, drag, die mapping, overlay)
node verify_contain.mjs   # die stays on-screen across window sizes
```
