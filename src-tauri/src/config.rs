use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TunnelConfig {
    pub name: String,
    pub token: String,
    pub status: String,
    pub id: Option<String>,
    pub account_tag: Option<String>,
    pub config_file: Option<String>,
    pub creds_file: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct QuickTunnelConfig {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: u16,
    pub public_url: String,
    pub status: String,
    #[serde(default)]
    pub no_tls_verify: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CloudflareAccount {
    pub name: String,
    pub cert_path: String,
    pub tunnel_count: u32,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub cloudflared_path: String,
    pub tunnels: Vec<TunnelConfig>,
    pub quick_tunnels: Vec<QuickTunnelConfig>,
    pub accounts: Vec<CloudflareAccount>,
    pub auto_start: bool,
    pub theme: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            cloudflared_path: String::new(),
            tunnels: Vec::new(),
            quick_tunnels: Vec::new(),
            accounts: Vec::new(),
            auto_start: false,
            theme: "dark".to_string(),
        }
    }
}

pub fn get_config_path(app_handle: &AppHandle) -> PathBuf {
    app_handle
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.json")
}

pub fn load_config(app_handle: &AppHandle) -> AppConfig {
    let path = get_config_path(app_handle);
    let mut config = if path.exists() {
        let content = fs::read_to_string(path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        AppConfig::default()
    };
    
    // Reset all statuses to STOPPED on startup
    for tunnel in &mut config.tunnels {
        tunnel.status = "STOPPED".to_string();
    }

    for qt in &mut config.quick_tunnels {
        qt.status = "STOPPED".to_string();
        qt.public_url = String::new();
    }
    
    config
}

pub fn save_config(app_handle: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = get_config_path(app_handle);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(())
}
