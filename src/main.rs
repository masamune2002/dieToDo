//! Minimal Axum + SQLite backend for the Dice To-Do app.
//!
//! - Serves the static front-end from `static/`.
//! - Persists the whole to-do state (master + today lists) in SQLite.
//!
//! Endpoints:
//!   GET  /api/state  -> { seeded: bool, master: [Task], daily: [Task] }
//!   PUT  /api/state  <- { master: [Task], daily: [Task] }   (replaces all)
//!
//! The front-end writes the entire state on every change (small lists), so the
//! PUT handler simply replaces the contents transactionally. `seeded` lets the
//! client tell a brand-new server apart from one the user has deliberately
//! emptied (so we only seed example tasks once).

use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::net::SocketAddr;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

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

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).init();

    // `?mode=rwc` creates the file if it doesn't exist.
    let db_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://todo.db?mode=rwc".into());
    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("failed to open SQLite database");

    init_db(&db).await.expect("failed to initialise schema");

    let app = Router::new()
        .route("/api/state", get(get_state).put(put_state))
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

async fn init_db(db: &SqlitePool) -> sqlx::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tasks (
            id       TEXT PRIMARY KEY,
            text     TEXT NOT NULL,
            list     TEXT NOT NULL CHECK (list IN ('master','daily')),
            position INTEGER NOT NULL
        )",
    )
    .execute(db)
    .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .execute(db)
        .await?;
    Ok(())
}

fn err500<E: std::fmt::Display>(e: E) -> StatusCode {
    tracing::error!("db error: {e}");
    StatusCode::INTERNAL_SERVER_ERROR
}

async fn get_state(State(st): State<AppState>) -> Result<Json<StateOut>, StatusCode> {
    let rows = sqlx::query("SELECT id, text, list FROM tasks ORDER BY list, position")
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

    let seeded = sqlx::query("SELECT 1 FROM meta WHERE key = 'seeded'")
        .fetch_optional(&st.db)
        .await
        .map_err(err500)?
        .is_some();

    Ok(Json(StateOut {
        seeded,
        master,
        daily,
    }))
}

async fn put_state(
    State(st): State<AppState>,
    Json(body): Json<StateIn>,
) -> Result<StatusCode, StatusCode> {
    let mut tx = st.db.begin().await.map_err(err500)?;

    sqlx::query("DELETE FROM tasks")
        .execute(&mut *tx)
        .await
        .map_err(err500)?;

    for (list, items) in [("master", &body.master), ("daily", &body.daily)] {
        for (i, t) in items.iter().enumerate() {
            sqlx::query("INSERT INTO tasks (id, text, list, position) VALUES (?, ?, ?, ?)")
                .bind(&t.id)
                .bind(&t.text)
                .bind(list)
                .bind(i as i64)
                .execute(&mut *tx)
                .await
                .map_err(err500)?;
        }
    }

    sqlx::query(
        "INSERT INTO meta (key, value) VALUES ('seeded', '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'",
    )
    .execute(&mut *tx)
    .await
    .map_err(err500)?;

    tx.commit().await.map_err(err500)?;
    Ok(StatusCode::NO_CONTENT)
}
