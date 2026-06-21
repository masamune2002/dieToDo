//! Axum + SQLite backend for the Dice To-Do app.
//!
//! - Serves the static front-end from `static/`.
//! - Cookie-session auth (username/password, Argon2 hashes). No SSO.
//! - Per-user to-do state (master + today lists).
//! - Admin users can list / create / delete users.
//!
//! On first run, an `admin` user is created with a password taken from the
//! `ADMIN_PASSWORD` env var, or randomly generated and printed to the log.
//!
//! Endpoints:
//!   POST   /api/login        { username, password }      -> sets session cookie
//!   POST   /api/logout                                    -> clears session
//!   GET    /api/me                                        -> { username, role }
//!   GET    /api/state                                     -> { seeded, master, daily }   (auth)
//!   PUT    /api/state        { master, daily }            -> 204                          (auth)
//!   GET    /api/users                                     -> [{ id, username, role }]     (admin)
//!   POST   /api/users        { username, password, role } -> { id, username, role }       (admin)
//!   DELETE /api/users/{id}                                -> 204                          (admin)

use argon2::password_hash::{rand_core::OsRng, SaltString};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use rand::distributions::Alphanumeric;
use rand::{thread_rng, Rng};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

const SESSION_DAYS: i64 = 7;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
}

struct CurrentUser {
    id: i64,
    username: String,
    role: String,
    seeded: bool,
}

#[derive(Serialize, Deserialize)]
struct Task {
    id: String,
    text: String,
}

#[derive(Serialize)]
struct StateOut {
    seeded: bool,
    master: Vec<Task>,
    daily: Vec<Task>,
}

#[derive(Deserialize)]
struct StateIn {
    master: Vec<Task>,
    daily: Vec<Task>,
}

#[derive(Deserialize)]
struct LoginIn {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct MeOut {
    username: String,
    role: String,
}

#[derive(Deserialize)]
struct CreateUserIn {
    username: String,
    password: String,
    role: Option<String>,
}

#[derive(Serialize)]
struct UserOut {
    id: i64,
    username: String,
    role: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let db_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://todo.db?mode=rwc".into());
    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("failed to open SQLite database");

    init_db(&db).await.expect("failed to initialise schema");
    ensure_admin(&db).await.expect("failed to ensure admin user");

    let app = Router::new()
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/state", get(get_state).put(put_state))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", axum::routing::delete(delete_user))
        .with_state(AppState { db })
        .fallback_service(ServeDir::new("static"))
        .layer(TraceLayer::new_for_http());

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    tracing::info!("listening on http://{addr}");
    axum::serve(listener, app).await.expect("server error");
}

// ---------------------------------------------------------------------------
// schema + bootstrap
// ---------------------------------------------------------------------------

async fn init_db(db: &SqlitePool) -> sqlx::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'user',
            seeded        INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL
        )",
    )
    .execute(db)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )",
    )
    .execute(db)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tasks (
            id       TEXT NOT NULL,
            user_id  INTEGER NOT NULL,
            text     TEXT NOT NULL,
            list     TEXT NOT NULL CHECK (list IN ('master','daily')),
            position INTEGER NOT NULL,
            PRIMARY KEY (user_id, id)
        )",
    )
    .execute(db)
    .await?;
    Ok(())
}

async fn ensure_admin(db: &SqlitePool) -> sqlx::Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(db)
        .await?;
    if count > 0 {
        return Ok(());
    }

    let (password, from_env) = match std::env::var("ADMIN_PASSWORD") {
        Ok(p) if !p.is_empty() => (p, true),
        _ => (gen_token(16), false),
    };
    // Admin starts unseeded so the demo tasks appear on first login.
    sqlx::query("INSERT INTO users (username, password_hash, role, seeded, created_at) VALUES ('admin', ?, 'admin', 0, ?)")
        .bind(hash_password(&password))
        .bind(now_unix())
        .execute(db)
        .await?;

    if from_env {
        tracing::info!("Created admin user 'admin' (password from ADMIN_PASSWORD env var)");
    } else {
        tracing::info!("==================================================");
        tracing::info!("  Created admin user");
        tracing::info!("    username: admin");
        tracing::info!("    password: {password}");
        tracing::info!("  (shown once — set ADMIN_PASSWORD to choose your own)");
        tracing::info!("==================================================");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn gen_token(n: usize) -> String {
    thread_rng()
        .sample_iter(&Alphanumeric)
        .take(n)
        .map(char::from)
        .collect()
}

fn hash_password(pw: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .expect("hash password")
        .to_string()
}

fn verify_password(pw: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(pw.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

fn err500<E: std::fmt::Display>(e: E) -> StatusCode {
    tracing::error!("internal error: {e}");
    StatusCode::INTERNAL_SERVER_ERROR
}

/// Resolve the logged-in user from the session cookie, or `None`.
async fn current_user(db: &SqlitePool, jar: &CookieJar) -> Option<CurrentUser> {
    let token = jar.get("session")?.value().to_string();
    let row = sqlx::query(
        "SELECT u.id, u.username, u.role, u.seeded
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?",
    )
    .bind(&token)
    .bind(now_unix())
    .fetch_optional(db)
    .await
    .ok()??;
    Some(CurrentUser {
        id: row.get("id"),
        username: row.get("username"),
        role: row.get("role"),
        seeded: row.get::<i64, _>("seeded") != 0,
    })
}

async fn require_user(db: &SqlitePool, jar: &CookieJar) -> Result<CurrentUser, StatusCode> {
    current_user(db, jar).await.ok_or(StatusCode::UNAUTHORIZED)
}

async fn require_admin(db: &SqlitePool, jar: &CookieJar) -> Result<CurrentUser, StatusCode> {
    let u = require_user(db, jar).await?;
    if u.role == "admin" {
        Ok(u)
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

// ---------------------------------------------------------------------------
// auth handlers
// ---------------------------------------------------------------------------

async fn login(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(body): Json<LoginIn>,
) -> Result<(CookieJar, Json<MeOut>), StatusCode> {
    let row = sqlx::query("SELECT id, password_hash, role FROM users WHERE username = ?")
        .bind(&body.username)
        .fetch_optional(&st.db)
        .await
        .map_err(err500)?;

    let row = row.ok_or(StatusCode::UNAUTHORIZED)?;
    let hash: String = row.get("password_hash");
    if !verify_password(&body.password, &hash) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let user_id: i64 = row.get("id");
    let role: String = row.get("role");

    let token = gen_token(48);
    let expires = now_unix() + SESSION_DAYS * 86_400;
    sqlx::query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(&token)
        .bind(user_id)
        .bind(expires)
        .execute(&st.db)
        .await
        .map_err(err500)?;

    let cookie = Cookie::build(("session", token))
        .http_only(true)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::days(SESSION_DAYS))
        .build();

    Ok((
        jar.add(cookie),
        Json(MeOut {
            username: body.username,
            role,
        }),
    ))
}

async fn logout(State(st): State<AppState>, jar: CookieJar) -> (CookieJar, StatusCode) {
    if let Some(c) = jar.get("session") {
        let _ = sqlx::query("DELETE FROM sessions WHERE token = ?")
            .bind(c.value())
            .execute(&st.db)
            .await;
    }
    let removal = Cookie::build(("session", "")).path("/").build();
    (jar.remove(removal), StatusCode::NO_CONTENT)
}

async fn me(State(st): State<AppState>, jar: CookieJar) -> Result<Json<MeOut>, StatusCode> {
    let u = require_user(&st.db, &jar).await?;
    Ok(Json(MeOut {
        username: u.username,
        role: u.role,
    }))
}

// ---------------------------------------------------------------------------
// per-user state
// ---------------------------------------------------------------------------

async fn get_state(
    State(st): State<AppState>,
    jar: CookieJar,
) -> Result<Json<StateOut>, StatusCode> {
    let u = require_user(&st.db, &jar).await?;

    let rows =
        sqlx::query("SELECT id, text, list FROM tasks WHERE user_id = ? ORDER BY list, position")
            .bind(u.id)
            .fetch_all(&st.db)
            .await
            .map_err(err500)?;

    let mut master = Vec::new();
    let mut daily = Vec::new();
    for row in rows {
        let task = Task {
            id: row.get("id"),
            text: row.get("text"),
        };
        if row.get::<String, _>("list") == "daily" {
            daily.push(task);
        } else {
            master.push(task);
        }
    }

    Ok(Json(StateOut {
        seeded: u.seeded,
        master,
        daily,
    }))
}

async fn put_state(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(body): Json<StateIn>,
) -> Result<StatusCode, StatusCode> {
    let u = require_user(&st.db, &jar).await?;

    let mut tx = st.db.begin().await.map_err(err500)?;
    sqlx::query("DELETE FROM tasks WHERE user_id = ?")
        .bind(u.id)
        .execute(&mut *tx)
        .await
        .map_err(err500)?;

    for (list, items) in [("master", &body.master), ("daily", &body.daily)] {
        for (i, t) in items.iter().enumerate() {
            sqlx::query(
                "INSERT INTO tasks (id, user_id, text, list, position) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&t.id)
            .bind(u.id)
            .bind(&t.text)
            .bind(list)
            .bind(i as i64)
            .execute(&mut *tx)
            .await
            .map_err(err500)?;
        }
    }

    sqlx::query("UPDATE users SET seeded = 1 WHERE id = ?")
        .bind(u.id)
        .execute(&mut *tx)
        .await
        .map_err(err500)?;

    tx.commit().await.map_err(err500)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// user management (admin only)
// ---------------------------------------------------------------------------

async fn list_users(
    State(st): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<UserOut>>, StatusCode> {
    require_admin(&st.db, &jar).await?;
    let rows = sqlx::query("SELECT id, username, role FROM users ORDER BY id")
        .fetch_all(&st.db)
        .await
        .map_err(err500)?;
    let users = rows
        .into_iter()
        .map(|r| UserOut {
            id: r.get("id"),
            username: r.get("username"),
            role: r.get("role"),
        })
        .collect();
    Ok(Json(users))
}

async fn create_user(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(body): Json<CreateUserIn>,
) -> Result<(StatusCode, Json<UserOut>), StatusCode> {
    require_admin(&st.db, &jar).await?;

    let username = body.username.trim();
    if username.is_empty() || body.password.len() < 6 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let role = match body.role.as_deref() {
        Some("admin") => "admin",
        _ => "user",
    };

    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&st.db)
        .await
        .map_err(err500)?;
    if exists.is_some() {
        return Err(StatusCode::CONFLICT);
    }

    // New users created via the panel start with an empty (already-seeded) list.
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash, role, seeded, created_at)
         VALUES (?, ?, ?, 1, ?) RETURNING id",
    )
    .bind(username)
    .bind(hash_password(&body.password))
    .bind(role)
    .bind(now_unix())
    .fetch_one(&st.db)
    .await
    .map_err(err500)?;

    Ok((
        StatusCode::CREATED,
        Json(UserOut {
            id,
            username: username.to_string(),
            role: role.to_string(),
        }),
    ))
}

async fn delete_user(
    State(st): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
) -> Result<StatusCode, StatusCode> {
    let admin = require_admin(&st.db, &jar).await?;
    if admin.id == id {
        // Don't let an admin delete their own account (avoids lockout).
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut tx = st.db.begin().await.map_err(err500)?;
    sqlx::query("DELETE FROM tasks WHERE user_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(err500)?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(err500)?;
    let res = sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(err500)?;
    tx.commit().await.map_err(err500)?;

    if res.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}
