use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};

pub static POLLS: AtomicU64 = AtomicU64::new(0);
pub static UPDATES: AtomicU64 = AtomicU64::new(0);
pub static ERRORS: AtomicU64 = AtomicU64::new(0);

pub fn inc_polls() {
    POLLS.fetch_add(1, Ordering::Relaxed);
}

pub fn inc_updates() {
    UPDATES.fetch_add(1, Ordering::Relaxed);
}

pub fn inc_errors() {
    ERRORS.fetch_add(1, Ordering::Relaxed);
}

fn metrics_body() -> String {
    format!(
        "# HELP config_sidecar_up Sidecar process is up\n\
         # TYPE config_sidecar_up gauge\n\
         config_sidecar_up 1\n\
         # HELP config_sidecar_polls_total Config poll attempts toward control plane\n\
         # TYPE config_sidecar_polls_total counter\n\
         config_sidecar_polls_total {}\n\
         # HELP config_sidecar_updates_total Successful config file writes\n\
         # TYPE config_sidecar_updates_total counter\n\
         config_sidecar_updates_total {}\n\
         # HELP config_sidecar_errors_total Poll or write failures\n\
         # TYPE config_sidecar_errors_total counter\n\
         config_sidecar_errors_total {}\n",
        POLLS.load(Ordering::Relaxed),
        UPDATES.load(Ordering::Relaxed),
        ERRORS.load(Ordering::Relaxed),
    )
}

fn handle_connection(mut stream: std::net::TcpStream) {
    let mut buf = [0u8; 512];
    let _ = stream.read(&mut buf);
    let body = metrics_body();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; version=0.0.4; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

/// Minimal Prometheus scrape server for internal Docker/K8s networks.
pub fn spawn_metrics_server(port: u16) {
    std::thread::spawn(move || {
        let addr = format!("0.0.0.0:{port}");
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("config-sidecar metrics bind failed on {addr}: {e}");
                return;
            }
        };
        eprintln!("config-sidecar metrics listening on {addr}");
        for stream in listener.incoming().flatten() {
            handle_connection(stream);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_body_contains_counters() {
        POLLS.store(3, Ordering::Relaxed);
        UPDATES.store(1, Ordering::Relaxed);
        ERRORS.store(2, Ordering::Relaxed);
        let body = metrics_body();
        assert!(body.contains("config_sidecar_polls_total 3"));
        assert!(body.contains("config_sidecar_updates_total 1"));
        assert!(body.contains("config_sidecar_errors_total 2"));
    }
}
