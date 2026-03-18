use std::collections::HashMap;
use std::process::Stdio;
use tokio::process::{Child, Command};
use tokio::io::{AsyncBufReadExt, BufReader};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use serde::Serialize;
use std::time::Duration;
use tokio::time::sleep;


const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Serialize)]
struct LogPayload {
    tunnel_name: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct QuickUrlPayload {
    id: String,
    url: String,
}

#[derive(Clone, Serialize, Default)]
pub struct TunnelMetrics {
    pub tunnel_name: String,
    pub status: String,
    pub latency_ms: f64,
    pub bandwidth_in: f64,
    pub bandwidth_out: f64,
}

pub struct TunnelProcessManager {
    processes: Arc<Mutex<HashMap<String, Child>>>,
    login_process: Arc<Mutex<Option<Child>>>,
}

impl TunnelProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            login_process: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_login_process(&self, child: Child) {
        if let Ok(mut lock) = self.login_process.lock() {
            // If there's an old one, kill it
            if let Some(mut old) = lock.take() {
                let _ = old.start_kill();
            }
            *lock = Some(child);
        }
    }

    pub fn abort_login_process(&self) {
        if let Ok(mut lock) = self.login_process.lock() {
            if let Some(mut child) = lock.take() {
                let _ = child.start_kill();
            }
        }
    }

    pub async fn start_tunnel(
        &self,
        app_handle: AppHandle,
        name: String,
        token: String,
        config_file: Option<String>,
        binary_path: String,
    ) -> Result<(), String> {
        let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
        
        if processes.contains_key(&name) {
            return Err(format!("Tunnel '{}' is already running", name));
        }

        let mut cmd = Command::new(binary_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        cmd.arg("tunnel");
        cmd.arg("--metrics");
        cmd.arg("127.0.0.1:0");

        if !token.is_empty() {
            cmd.args(["run", "--token", &token]);
        } else if let Some(cfg) = config_file {
            cmd.args(["--config", &cfg, "run"]);
        } else {
            return Err("No token or config file found to start the tunnel".to_string());
        }

        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn cloudflared: {}", e))?;

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        
        processes.insert(name.clone(), child);

        let processes_clone = self.processes.clone();
        let scraper_started = Arc::new(Mutex::new(false));

        // Stream logs (stdout)
        let name_stdout = name.clone();
        let app_stdout = app_handle.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_stdout.emit("tunnel-log", LogPayload {
                    tunnel_name: name_stdout.clone(),
                    message: line,
                });
            }
        });

        // Stream logs (stderr) & Detect Metrics Port
        let name_stderr = name.clone();
        let app_stderr = app_handle.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_stderr.emit("tunnel-log", LogPayload {
                    tunnel_name: name_stderr.clone(),
                    message: line.clone(),
                });

                // Detect port: "INF starting metrics server on 127.0.0.1:65432/metrics"
                if line.to_lowercase().contains("starting metrics server on") {
                    if let Some(addr_part) = line.split("on ").last() {
                        if let Some(port_part) = addr_part.split(':').last() {
                            // Port part might be "65432/metrics"
                            let clean_port = port_part.split('/').next().unwrap_or(port_part);
                            if let Ok(port) = clean_port.trim().parse::<u16>() {
                                let mut started = scraper_started.lock().unwrap();
                                if !*started {
                                    *started = true;
                                    start_metrics_scraper(
                                        app_stderr.clone(),
                                        name_stderr.clone(),
                                        processes_clone.clone(),
                                        port
                                    );
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(())
    }

    pub async fn start_quick_tunnel(
        &self,
        app_handle: AppHandle,
        id: String,
        name: String,
        target_url: String,
        binary_path: String,
        no_tls_verify: bool,
        http_host_header: String,
    ) -> Result<(), String> {
        let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
        
        if processes.contains_key(&id) {
            return Err(format!("Quick Tunnel '{}' is already running", name));
        }

        let mut cmd = Command::new(binary_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut args = vec!["tunnel", "--metrics", "127.0.0.1:0", "--url", &target_url];
        if no_tls_verify {
            args.push("--no-tls-verify");
        }
        if !http_host_header.is_empty() {
            args.push("--http-host-header");
            args.push(&http_host_header);
        }

        let mut child = cmd
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn cloudflared: {}", e))?;

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        
        processes.insert(id.clone(), child);

        // State for metrics scraper
        let processes_qt = self.processes.clone();
        let scraper_started = Arc::new(Mutex::new(false));

        // Stream logs & Parse URL (stdout)
        let app_stdout = app_handle.clone();
        let name_stdout = name.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_stdout.emit("tunnel-log", LogPayload {
                    tunnel_name: name_stdout.clone(),
                    message: line,
                });
            }
        });

        // Stream logs (stderr) & Detect Metrics Port & Parse Public URL
        let id_stderr = id.clone();
        let app_stderr = app_handle.clone();
        let name_stderr = name.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            let mut url_found = false;
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_stderr.emit("tunnel-log", LogPayload {
                    tunnel_name: name_stderr.clone(),
                    message: line.clone(),
                });

                // Detect Metrics Port
                if line.to_lowercase().contains("starting metrics server on") {
                    if let Some(addr_part) = line.split("on ").last() {
                        if let Some(port_part) = addr_part.split(':').last() {
                            let clean_port = port_part.split('/').next().unwrap_or(port_part);
                            if let Ok(port) = clean_port.trim().parse::<u16>() {
                                let mut started = scraper_started.lock().unwrap();
                                if !*started {
                                    *started = true;
                                    start_metrics_scraper(
                                        app_stderr.clone(),
                                        id_stderr.clone(),
                                        processes_qt.clone(),
                                        port
                                    );
                                }
                            }
                        }
                    }
                }

                if !url_found && line.contains(".trycloudflare.com") {
                    // Simple parsing for https://*.trycloudflare.com
                    if let Some(start) = line.find("https://") {
                        let rest = &line[start..];
                        if let Some(end) = rest.find(' ') {
                            let url = &rest[..end];
                            url_found = true;
                            let _ = app_stderr.emit("quick-tunnel-url-ready", QuickUrlPayload {
                                id: id_stderr.clone(),
                                url: url.to_string(),
                            });
                        } else {
                            url_found = true;
                            let _ = app_stderr.emit("quick-tunnel-url-ready", QuickUrlPayload {
                                id: id_stderr.clone(),
                                url: rest.to_string(),
                            });
                        }
                    }
                }
            }
        });

        Ok(())
    }

    pub fn stop_tunnel(&self, name: &str) -> Result<(), String> {
        let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = processes.remove(name) {
            let _ = child.start_kill();
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let mut processes = self.processes.lock().unwrap();
        for (_, mut child) in processes.drain() {
            let _ = child.start_kill();
        }
    }
}

fn start_metrics_scraper(
    app_handle: AppHandle,
    name: String,
    processes: Arc<Mutex<HashMap<String, Child>>>,
    port: u16,
) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/metrics", port);
        let mut last_bytes_in = 0.0;
        let mut last_bytes_out = 0.0;
        let name_clone = name.clone();

        loop {
            // Check if process still exists
            {
                if let Ok(lock) = processes.lock() {
                    if !lock.contains_key(&name_clone) {
                        break;
                    }
                } else {
                    break;
                }
            }

            sleep(Duration::from_secs(2)).await;

            match client.get(&url).send().await {
                Ok(resp) => {
                    if let Ok(text) = resp.text().await {
                        let mut metrics = TunnelMetrics {
                            tunnel_name: name_clone.clone(),
                            status: "connecting".to_string(),
                            ..Default::default()
                        };

                        let mut current_total_in = 0.0;
                        let mut current_total_out = 0.0;
                        let mut latency_sum = 0.0;
                        let mut latency_count = 0.0;
                        let is_quic = text.contains("quic_client_smoothed_rtt");

                        for line in text.lines() {
                            if line.starts_with("cloudflared_tunnel_ha_connections") {
                                if let Some(val) = line.split_whitespace().last().and_then(|v| v.parse::<f64>().ok()) {
                                    if val > 0.0 { metrics.status = "connected".to_string(); }
                                }
                            }
                            if line.starts_with("quic_client_receive_bytes") || line.starts_with("cloudflared_tunnel_total_bytes_received_total") {
                                if let Some(val) = line.split_whitespace().last().and_then(|v| v.parse::<f64>().ok()) {
                                    current_total_in += val;
                                }
                            }
                            if line.starts_with("quic_client_sent_bytes") || line.starts_with("cloudflared_tunnel_total_bytes_sent_total") {
                                if let Some(val) = line.split_whitespace().last().and_then(|v| v.parse::<f64>().ok()) {
                                    current_total_out += val;
                                }
                            }
                            if line.starts_with("quic_client_smoothed_rtt") || line.starts_with("cloudflared_tunnel_round_trip_time_seconds{quantile=\"0.5\"}") {
                                if let Some(val) = line.split_whitespace().last().and_then(|v| v.parse::<f64>().ok()) {
                                    latency_sum += val;
                                    latency_count += 1.0;
                                }
                            }
                        }

                        if last_bytes_in > 0.0 {
                            metrics.bandwidth_in = (current_total_in - last_bytes_in).max(0.0) / 2.0;
                        }
                        if last_bytes_out > 0.0 {
                            metrics.bandwidth_out = (current_total_out - last_bytes_out).max(0.0) / 2.0;
                        }
                        last_bytes_in = current_total_in;
                        last_bytes_out = current_total_out;

                        if latency_count > 0.0 {
                            let avg = latency_sum / latency_count;
                            metrics.latency_ms = if is_quic { avg } else { avg * 1000.0 };
                        }

                        let _ = app_handle.emit("tunnel-metrics", metrics);
                    }
                }
                Err(_) => {
                    let exists = if let Ok(lock) = processes.lock() {
                        lock.contains_key(&name_clone)
                    } else {
                        false
                    };

                    if exists {
                        let _ = app_handle.emit("tunnel-metrics", TunnelMetrics {
                            tunnel_name: name_clone.clone(),
                            status: "connecting".to_string(),
                            ..Default::default()
                        });
                    }
                }
            }
        }
    });
}
