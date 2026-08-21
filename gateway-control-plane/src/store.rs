//! Control-plane owned PostgreSQL state store.
//!
//! The control plane is a **management plane** (ADR-0011): it publishes config
//! to the data plane and keeps a versioned, rollback-able history. That history
//! is the control plane's OWN operational state — NOT uam-backend's user data.
//! Per ADR-0050/0052 the gateway never touches the auth service's user schema.
//!
//! Isolation:
//!   - All objects live in a dedicated `control_plane` schema, never `public`.
//!   - Production should use a least-privilege role with access ONLY to this
//!     schema (see `PRODUCTION.md` / the DDL block below), so even a compromised
//!     control plane cannot read uam-backend's `public.users`.
//!   - `GET /config` (hot path) stays on ArcSwap — this store is only touched on
//!     writes, boot, and admin history reads.

use serde_json::Value;
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::Row;

pub const SCHEMA: &str = "control_plane";
pub const TABLE: &str = "config_revisions";

/// A durable config revision row.
pub struct Revision {
    pub version: String,
    pub action: String,
    pub actor_ip: String,
    pub created_at: String,
}

/// Returns a connection string, forcing TLS when `PG_SSL` is set. Aiven uses a
/// self-signed CA, so we use `sslmode=require` (encrypt, no CA verification).
fn connection_url() -> Option<String> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let ssl = std::env::var("PG_SSL")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !ssl {
        return Some(url);
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    Some(format!("{url}{sep}sslmode=require"))
}

/// The control-plane state store. `None`-capable: when `DATABASE_URL` is unset
/// or PG is unreachable, the control plane degrades to in-memory history only.
#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

impl Store {
    /// Connect and ensure the isolated schema + table exist.
    pub async fn connect() -> Result<Option<Store>, sqlx::Error> {
        let Some(url) = connection_url() else {
            log::warn!("DATABASE_URL not set — config history is in-memory only");
            return Ok(None);
        };
        let pool = PgPoolOptions::new()
            .max_connections(4)
            // Cold TLS handshakes to managed Postgres (Aiven ap-south-1) can
            // take >5 s; a short timeout here would silently disable the
            // durable store on every restart.
            .acquire_timeout(std::time::Duration::from_secs(20))
            .connect(&url)
            .await?;

        let store = Store { pool };
        store.ensure_schema().await?;
        log::info!(
            "PostgreSQL connected — control_plane config store durable (schema '{SCHEMA}')"
        );
        Ok(Some(store))
    }

    /// Idempotent DDL: isolated schema + revisions table + descending index.
    ///
    /// For production hardening, create a least-privilege role that can ONLY
    /// use this schema:
    /// ```sql
    /// CREATE ROLE control_plane LOGIN PASSWORD '...';
    /// CREATE SCHEMA control_plane AUTHORIZATION control_plane;
    /// GRANT USAGE ON SCHEMA control_plane TO control_plane;
    /// GRANT SELECT, INSERT, UPDATE, DELETE
    ///   ON ALL TABLES IN SCHEMA control_plane TO control_plane;
    /// ```
    async fn ensure_schema(&self) -> Result<(), sqlx::Error> {
        let ddl = format!(
            "CREATE SCHEMA IF NOT EXISTS {SCHEMA};
             CREATE TABLE IF NOT EXISTS {SCHEMA}.{TABLE} (
                 id         BIGSERIAL PRIMARY KEY,
                 version    TEXT        NOT NULL,
                 action     TEXT        NOT NULL,
                 actor_ip   TEXT        NOT NULL DEFAULT '',
                 snapshot   JSONB       NOT NULL,
                 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
             );
             CREATE INDEX IF NOT EXISTS {TABLE}_created_at_idx
                 ON {SCHEMA}.{TABLE} (created_at DESC);"
        );
        sqlx::raw_sql(&ddl).execute(&self.pool).await?;
        Ok(())
    }

    /// Append one revision. Caller decides whether failure is fatal.
    pub async fn record(
        &self,
        version: &str,
        action: &str,
        actor_ip: &str,
        snapshot: &Value,
    ) -> Result<(), sqlx::Error> {
        let q = format!(
            "INSERT INTO {SCHEMA}.{TABLE} (version, action, actor_ip, snapshot)
             VALUES ($1, $2, $3, $4)"
        );
        sqlx::query(&q)
            .bind(version)
            .bind(action)
            .bind(actor_ip)
            .bind(snapshot)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Durable history (newest first), most recent `limit` rows.
    pub async fn list(&self, limit: i64) -> Result<Vec<Revision>, sqlx::Error> {
        let q = format!(
            "SELECT version, action, actor_ip, created_at
             FROM {SCHEMA}.{TABLE}
             ORDER BY id DESC
             LIMIT $1"
        );
        let rows = sqlx::query(&q).bind(limit).fetch_all(&self.pool).await?;
        Ok(rows
            .iter()
            .map(|r| Revision {
                version: r.get("version"),
                action: r.get("action"),
                actor_ip: r.get("actor_ip"),
                created_at: r
                    .get::<sqlx::types::time::OffsetDateTime, _>("created_at")
                    .to_string(),
            })
            .collect())
    }

    /// Version strings, newest first, distinct (for `GET /config/history`).
    pub async fn versions(&self) -> Result<Vec<String>, sqlx::Error> {
        let q = format!(
            "SELECT version FROM {SCHEMA}.{TABLE}
             GROUP BY version
             ORDER BY max(id) DESC"
        );
        let rows = sqlx::query(&q).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| r.get("version")).collect())
    }

    /// Up to `limit` snapshots oldest→newest (used to rebuild in-memory history
    /// across restarts so rollback still works after a reboot).
    pub async fn history_snapshots(&self, limit: i64) -> Result<Vec<(String, Value)>, sqlx::Error> {
        let q = format!(
            "SELECT version, snapshot
             FROM (
                 SELECT version, snapshot, id
                 FROM {SCHEMA}.{TABLE}
                 ORDER BY id DESC
                 LIMIT $1
             ) recent
             ORDER BY id ASC"
        );
        let rows = sqlx::query(&q).bind(limit).fetch_all(&self.pool).await?;
        Ok(rows
            .iter()
            .map(|r| (r.get("version"), r.get("snapshot")))
            .collect())
    }

    pub async fn ping(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }
}
