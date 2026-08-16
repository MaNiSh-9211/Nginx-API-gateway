mod metrics;

use std::time::Duration;
use std::thread;
use std::fs;
use std::path::{Path, PathBuf};

/// True when the polled version differs and is non-empty.
pub fn should_update_config(current_version: &str, new_version: &str) -> bool {
    !new_version.is_empty() && new_version != current_version
}

/// Write `data` to `temp_path` then rename onto `target_path` (atomic on POSIX).
pub fn write_config_atomically(
    temp_path: &Path,
    target_path: &Path,
    data: &[u8],
) -> Result<(), String> {
    fs::write(temp_path, data).map_err(|e| format!("write {:?}: {e}", temp_path))?;
    fs::rename(temp_path, target_path)
        .map_err(|e| format!("rename {:?} -> {:?}: {e}", temp_path, target_path))
}

fn main() {
    println!("Starting Config Sidecar (Push Model)...");

    let client = ureq::builder()
        .timeout(Duration::from_secs(5))
        .build();

    let control_plane_url = std::env::var("CONTROL_PLANE_URL")
        .unwrap_or_else(|_| "http://control-plane:8081".to_string());
    let config_url = format!("{control_plane_url}/config");

    // Must match the gateway's GATEWAY_CONFIG_PATH so the data plane sees writes.
    let target_path = match std::env::var("GATEWAY_CONFIG_PATH") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => std::env::temp_dir().join("gateway_config.json"),
    };
    // Atomic replace: write a sibling temp file, then rename onto the target.
    let temp_path = target_path.with_extension("json.tmp");

    let poll_secs: u64 = std::env::var("CONFIG_POLL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);

    let metrics_port: u16 = std::env::var("METRICS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9092);
    metrics::spawn_metrics_server(metrics_port);

    let config_read_token = std::env::var("CONFIG_READ_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());

    println!(
        "Config sidecar: source={config_url} target={} interval={poll_secs}s",
        target_path.display()
    );

    let mut current_version = String::new();

    // Fetch immediately on startup — do not wait for the first sleep interval.
    loop {
        metrics::inc_polls();
        let mut req = client.get(&config_url);
        if let Some(ref token) = config_read_token {
            req = req.set("X-Config-Read-Token", token);
        }
        match req.call() {
            Ok(response) => {
                if let Ok(json_val) = response.into_json::<serde_json::Value>() {
                    let new_version = json_val["version"].as_str().unwrap_or("").to_string();
                    if should_update_config(&current_version, &new_version) {
                        println!("New config detected: {}", new_version);
                        
                        let data = serde_json::to_string(&json_val).unwrap();
                        match write_config_atomically(&temp_path, &target_path, data.as_bytes()) {
                            Ok(()) => {
                                println!("Successfully pushed config to {}", target_path.display());
                                current_version = new_version;
                                metrics::inc_updates();
                            }
                            Err(e) => {
                                eprintln!("{e}");
                                metrics::inc_errors();
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("Control plane unreachable: {}", e);
                metrics::inc_errors();
            }
        }

        // One sidecar per node → the control plane sees one poll per node per
        // interval, never one-per-worker. No thundering herd at fleet scale.
        thread::sleep(Duration::from_secs(poll_secs));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn should_update_when_version_changes() {
        assert!(should_update_config("v1", "v2"));
        assert!(!should_update_config("v2", "v2"));
        assert!(!should_update_config("v1", ""));
    }

    #[test]
    fn atomic_write_replaces_target() {
        let dir = env::temp_dir().join("config_sidecar_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("config.json");
        let temp = dir.join("config.json.tmp");
        write_config_atomically(&temp, &target, br#"{"version":"v1"}"#).unwrap();
        let contents = fs::read_to_string(&target).unwrap();
        assert!(contents.contains("v1"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_leaves_no_partial_target_on_bad_rename() {
        let dir = env::temp_dir().join("config_sidecar_test2");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("config.json");
        let temp = dir.join("config.json.tmp");
        // Target is a directory — rename should fail.
        fs::create_dir(&target).unwrap();
        assert!(write_config_atomically(&temp, &target, b"x").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
