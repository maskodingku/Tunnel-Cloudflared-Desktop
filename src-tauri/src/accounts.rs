use std::path::PathBuf;
use std::fs;
use std::process::Command;
use tauri::{AppHandle, Manager, State};
use crate::config::{CloudflareAccount, load_config, save_config};
use crate::binary;
use crate::tunnel::TunnelProcessManager;
use serde::{Deserialize, Serialize};
use serde_json;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IngressRule {
    pub hostname: Option<String>,
    pub service: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CloudflaredConfig {
    pub tunnel: String,
    #[serde(rename = "credentials-file", skip_serializing_if = "Option::is_none")]
    pub credentials_file: Option<String>,
    pub ingress: Vec<IngressRule>,
}

#[tauri::command]
pub async fn login_cloudflare_account(
    app_handle: AppHandle,
    state: State<'_, TunnelProcessManager>
) -> Result<String, String> {
    let config = load_config(&app_handle);
    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle)
    } else {
        PathBuf::from(config.cloudflared_path)
    };

    if !binary_path.exists() {
        return Err("Cloudflared binary not found.".to_string());
    }

    // Bug Fix #1: Clear existing cert.pem in default directory to avoid cloudflared error
    if let Some(home_dir) = dirs::home_dir() {
        let cert_path = home_dir.join(".cloudflared").join("cert.pem");
        if cert_path.exists() {
            let _ = fs::remove_file(cert_path);
        }
    }

    use tokio::process::Command as TokioCommand;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use std::process::Stdio;
    use tokio::time::{timeout, Duration};

    // Suppress browser open on multiple possible env vars
    let mut cmd = TokioCommand::new(binary_path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    
    cmd.env("BROWSER", "echo")
       .env("XDG_BROWSER", "echo")
       .arg("tunnel")
       .arg("login")
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn login process: {}", e))?;
    
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    // Store the child process for potentential abort
    state.set_login_process(child);
    
    let mut login_url = String::new();
    
    let mut stderr_reader = BufReader::new(stderr).lines();
    let mut stdout_reader = BufReader::new(stdout).lines();
    
    // We'll poll for the URL with a timeout to avoid hanging the UI
    // Usually the URL appears in the first few lines
    let find_url = async {
        for _ in 0..30 {
            tokio::select! {
                line = stderr_reader.next_line() => {
                    if let Ok(Some(l)) = line {
                        if let Some(start) = l.find("https://") {
                            let url = l[start..].split_whitespace().next().unwrap_or("").to_string();
                            if url.contains("cloudflare.com") { return Some(url); }
                        }
                    }
                }
                line = stdout_reader.next_line() => {
                    if let Ok(Some(l)) = line {
                        if let Some(start) = l.find("https://") {
                            let url = l[start..].split_whitespace().next().unwrap_or("").to_string();
                            if url.contains("cloudflare.com") { return Some(url); }
                        }
                    }
                }
            }
        }
        None
    };

    if let Ok(Some(url)) = timeout(Duration::from_secs(5), find_url).await {
        login_url = url;
    }

    if login_url.is_empty() {
        return Err("Could not capture login URL. Please try again.".to_string());
    }
    
    Ok(login_url)
}

#[tauri::command]
pub fn abort_cloudflare_login(state: State<'_, TunnelProcessManager>) {
    state.abort_login_process();
}

#[tauri::command]
pub fn check_login_cert_exists() -> bool {
    // On Windows: %USERPROFILE%\.cloudflared\cert.pem
    if let Some(home_dir) = dirs::home_dir() {
        let cert_path = home_dir.join(".cloudflared").join("cert.pem");
        return cert_path.exists();
    }
    false
}

#[tauri::command]
pub async fn finalize_cloudflare_login(app_handle: AppHandle, name: String) -> Result<(), String> {
    // 1. Locate the default cert.pem created by cloudflared
    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let default_cert_path = home_dir.join(".cloudflared").join("cert.pem");

    if !default_cert_path.exists() {
        return Err("Login certificate (cert.pem) not found. Did you complete the login in your browser?".to_string());
    }

    // 2. Prepare target directory in app_data
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let account_dir = app_data_dir.join("accounts").join(&name);
    fs::create_dir_all(&account_dir).map_err(|e| e.to_string())?;
    let target_cert_path = account_dir.join("cert.pem");

    // 3. Move the cert.pem
    fs::rename(&default_cert_path, &target_cert_path).map_err(|e| e.to_string())?;

    // 4. Update config
    let mut config = load_config(&app_handle);
    
    // Check if account already exists
    if config.accounts.iter().any(|a| a.name == name) {
        // Update existing
        if let Some(acc) = config.accounts.iter_mut().find(|a| a.name == name) {
            acc.cert_path = target_cert_path.to_string_lossy().to_string();
            acc.status = "Logged In".to_string();
        }
    } else {
        // Add new
        config.accounts.push(CloudflareAccount {
            name: name.clone(),
            cert_path: target_cert_path.to_string_lossy().to_string(),
            tunnel_count: 0,
            status: "Logged In".to_string(),
        });
    }

    save_config(&app_handle, &config)?;

    Ok(())
}

#[tauri::command]
pub async fn list_account_tunnels(app_handle: AppHandle, name: String) -> Result<String, String> {
    let config = load_config(&app_handle);
    let account = config.accounts.iter().find(|a| a.name == name)
        .ok_or_else(|| format!("Account '{}' not found", name))?;

    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle)
    } else {
        PathBuf::from(config.cloudflared_path)
    };

    let mut cmd = Command::new(binary_path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .arg("--origincert")
        .arg(&account.cert_path)
        .arg("tunnel")
        .arg("list")
        .arg("--output")
        .arg("json")
        .output()
        .map_err(|e| format!("Failed to run cloudflared: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub async fn sync_account_tunnels(app_handle: AppHandle, account_name: String) -> Result<(), String> {
    let mut config = load_config(&app_handle);
    let account = config.accounts.iter().find(|a| a.name == account_name)
        .ok_or_else(|| format!("Account '{}' not found", account_name))?.clone();

    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle)
    } else {
        PathBuf::from(&config.cloudflared_path)
    };

    // 1. Fetch remote tunnels
    let mut cmd = Command::new(&binary_path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .arg("--origincert")
        .arg(&account.cert_path)
        .arg("tunnel")
        .arg("list")
        .arg("--output")
        .arg("json")
        .output()
        .map_err(|e| format!("Failed to list tunnels: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let tunnels: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse tunnels: {}", e))?;

    let tunnel_list = tunnels.as_array()
        .ok_or_else(|| "Invalid tunnel list format".to_string())?;

    for t in tunnel_list {
        let id = t["id"].as_str().unwrap_or_default();
        let name = t["name"].as_str().unwrap_or_default();
        
        if id.is_empty() { continue; }

        // Check if already in config (by ID)
        if config.tunnels.iter().any(|existing| existing.id.as_deref() == Some(id)) {
            continue;
        }

        // 2. Fetch token for this tunnel
        let mut token_cmd = Command::new(&binary_path);
        #[cfg(windows)]
        token_cmd.creation_flags(CREATE_NO_WINDOW);

        let token_output = token_cmd
            .arg("--origincert")
            .arg(&account.cert_path)
            .arg("tunnel")
            .arg("token")
            .arg(id)
            .output()
            .map_err(|e| format!("Failed to fetch token for {}: {}", name, e))?;

        if token_output.status.success() {
            let token = String::from_utf8_lossy(&token_output.stdout).trim().to_string();
            if !token.is_empty() {
                config.tunnels.push(crate::config::TunnelConfig {
                    name: name.to_string(),
                    token,
                    status: "STOPPED".to_string(),
                    id: Some(id.to_string()),
                    account_tag: Some(account_name.clone()),
                    config_file: None,
                    creds_file: None,
                });
            }
        }
    }

    save_config(&app_handle, &config)?;
    Ok(())
}

#[tauri::command]
pub async fn remove_cloudflare_account(app_handle: AppHandle, name: String) -> Result<(), String> {
    let mut config = load_config(&app_handle);
    
    if let Some(pos) = config.accounts.iter().position(|a| a.name == name) {
        let account = config.accounts.remove(pos);
        
        // Cascade Delete: Remove all tunnels associated with this account
        config.tunnels.retain(|t| t.account_tag.as_deref() != Some(&name));
        
        // Remove directory
        let cert_path = PathBuf::from(account.cert_path);
        if let Some(parent) = cert_path.parent() {
            if parent.exists() && parent.ends_with(&name) {
                let _ = fs::remove_dir_all(parent);
            }
        }
        
        save_config(&app_handle, &config)?;
        Ok(())
    } else {
        Err(format!("Account '{}' not found", name))
    }
}

#[tauri::command]
pub async fn list_cloudflare_accounts(app_handle: AppHandle) -> Result<Vec<CloudflareAccount>, String> {
    let config = load_config(&app_handle);
    Ok(config.accounts)
}

#[tauri::command]
pub async fn create_tunnel_via_account(app_handle: AppHandle, account_name: String, tunnel_name: String) -> Result<String, String> {
    let config = load_config(&app_handle);
    let account = config.accounts.iter().find(|a| a.name == account_name)
        .ok_or_else(|| format!("Account '{}' not found", account_name))?;

    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle)
    } else {
        PathBuf::from(config.cloudflared_path)
    };

    // 1. Create the tunnel
    // We specify a temporary config file path to ensure cloudflared writes it where we can find it
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let account_dir = app_data_dir.join("accounts").join(&account_name);
    let temp_creds_path = account_dir.join("temp_creds.json");
    
    // Ensure account dir exists
    fs::create_dir_all(&account_dir).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&binary_path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let create_output = cmd
        .arg("--origincert")
        .arg(&account.cert_path)
        .arg("tunnel")
        .arg("create")
        .arg("--credentials-file")
        .arg(&temp_creds_path)
        .arg(&tunnel_name)
        .output()
        .map_err(|e| format!("Failed to create tunnel: {}", e))?;

    if !create_output.status.success() {
        let err = String::from_utf8_lossy(&create_output.stderr).to_string();
        return Err(format!("Cloudflare Error: {}", err));
    }

    let stdout = String::from_utf8_lossy(&create_output.stdout).to_string();
    // Parse Tunnel ID from output: "Created tunnel <name> with id <id>"
    let tunnel_id = stdout.split("with id ")
        .nth(1)
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "Failed to parse Tunnel ID from output".to_string())?;

    // 2. Rename temp creds to <id>.json in the account dir
    let target_creds_path = account_dir.join(format!("{}.json", tunnel_id));
    fs::rename(&temp_creds_path, &target_creds_path).map_err(|e| format!("Failed to move credentials: {}", e))?;

    // 4. Create config.yml
    let config_yml_path = account_dir.join(format!("{}.yml", tunnel_name));
    let yml_content = format!(
"tunnel: {}
credentials-file: {}

ingress:
  - service: http_status:404", 
        tunnel_id, target_creds_path.to_string_lossy()
    );
    fs::write(&config_yml_path, yml_content).map_err(|e| e.to_string())?;

    // Return a JSON with the details
    let result = serde_json::json!({
        "id": tunnel_id,
        "name": tunnel_name,
        "config_file": config_yml_path.to_string_lossy(),
        "creds_file": target_creds_path.to_string_lossy()
    });

    Ok(result.to_string())
}

#[tauri::command]
pub async fn delete_remote_tunnel(app_handle: AppHandle, account_name: String, tunnel_name: String) -> Result<(), String> {
    let config = load_config(&app_handle);
    let account = config.accounts.iter().find(|a| a.name == account_name)
        .ok_or_else(|| format!("Account '{}' not found", account_name))?;

    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle)
    } else {
        PathBuf::from(config.cloudflared_path)
    };

    // Run tunnel delete -f <name>
    let mut cmd = Command::new(binary_path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .arg("--origincert")
        .arg(&account.cert_path)
        .arg("tunnel")
        .arg("delete")
        .arg("-f")
        .arg(tunnel_name)
        .output()
        .map_err(|e| format!("Failed to delete remote tunnel: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Cloudflare Error: {}", err))
    }
}

#[tauri::command]
pub async fn add_tunnel_dns_route(app_handle: AppHandle, account_name: String, tunnel_name: String, hostname: String) -> Result<(), String> {
    let config = load_config(&app_handle);
    let account = config.accounts.iter().find(|a| a.name == account_name)
        .ok_or_else(|| format!("Account '{}' not found", account_name))?;

    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle)
    } else {
        PathBuf::from(config.cloudflared_path)
    };

    // Run tunnel route dns <tunnel_name> <hostname>
    let mut cmd = Command::new(binary_path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .arg("--origincert")
        .arg(&account.cert_path)
        .arg("tunnel")
        .arg("route")
        .arg("dns")
        .arg("--overwrite-dns")
        .arg(tunnel_name)
        .arg(hostname)
        .output()
        .map_err(|e| format!("Failed to route DNS: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Cloudflare Error: {}", err))
    }
}

#[tauri::command]
pub async fn update_local_tunnel_ingress(
    config_file: String,
    hostname: String,
    protocol: String,
    dest_host: String,
    dest_port: u16,
    cert_path: Option<String>,
    tunnel_id: Option<String>,
) -> Result<(), String> {
    let service = if protocol == "unix" {
        format!("unix:{}", dest_host)
    } else {
        format!("{}://{}:{}", protocol, dest_host, dest_port)
    };

    if !config_file.is_empty() && std::path::Path::new(&config_file).exists() {
        let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
        let mut config: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;

        config.ingress.retain(|r| r.hostname.is_some() && r.hostname != Some(hostname.clone()));
        config.ingress.push(IngressRule { hostname: Some(hostname), service });
        config.ingress.push(IngressRule { hostname: None, service: "http_status:404".to_string() });

        let new_content = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
        fs::write(config_file, new_content).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if let (Some(cert), Some(tid)) = (cert_path, tunnel_id) {
        let token = parse_cert_pem(&cert)?;
        let account_id = token.account_tag.ok_or("No accountID")?;
        let api_key = token.api_token.or(token.service_key).ok_or("No API key")?;

        let client = reqwest::Client::new();
        let url = format!("https://api.cloudflare.com/client/v4/accounts/{}/cfd_tunnel/{}/configurations", account_id, tid);
        let resp = client.get(&url).header("Authorization", format!("Bearer {}", api_key)).send().await.map_err(|e| e.to_string())?;
        let api_resp: CfApiResponse<CfTunnelConfig> = resp.json().await.map_err(|e| e.to_string())?;
        let mut ingress = api_resp.result.and_then(|r| r.config).and_then(|c| c.ingress).unwrap_or_default();

        ingress.retain(|r| r.hostname.is_some() && r.hostname != Some(hostname.clone()));
        ingress.push(CfIngressRule { hostname: Some(hostname), service: Some(service), origin_request: None });
        ingress.push(CfIngressRule { hostname: None, service: Some("http_status:404".to_string()), origin_request: None });

        let body = serde_json::json!({ "config": { "ingress": ingress } });
        let put_resp = client.put(&url).header("Authorization", format!("Bearer {}", api_key)).json(&body).send().await.map_err(|e| e.to_string())?;
        if !put_resp.status().is_success() {
            return Err(format!("API error: {}", put_resp.text().await.unwrap_or_default()));
        }
        return Ok(());
    }

    Err("Config info missing".to_string())
}

#[tauri::command]
pub async fn push_tunnel_config(
    cert_path: String,
    config_file: String
) -> Result<(), String> {
    if !std::path::Path::new(&config_file).exists() {
        return Err("Config file not found".to_string());
    }
    let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
    let local_config: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
    let tunnel_id = local_config.tunnel.clone();

    let token = parse_cert_pem(&cert_path)?;
    let account_id = token.account_tag.ok_or("No accountID")?;
    let api_key = token.api_token.or(token.service_key).ok_or("No API key")?;

    let ingress_payload: Vec<serde_json::Value> = local_config.ingress.iter().map(|r| {
        let mut obj = serde_json::Map::new();
        if let Some(ref h) = r.hostname {
            obj.insert("hostname".to_string(), serde_json::Value::String(h.clone()));
        }
        obj.insert("service".to_string(), serde_json::Value::String(r.service.clone()));
        serde_json::Value::Object(obj)
    }).collect();

    let body = serde_json::json!({ "config": { "ingress": ingress_payload } });
    let client = reqwest::Client::new();
    let url = format!("https://api.cloudflare.com/client/v4/accounts/{}/cfd_tunnel/{}/configurations", account_id, tunnel_id);
    let resp = client.put(&url).header("Authorization", format!("Bearer {}", api_key)).json(&body).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("API error: {}", resp.text().await.unwrap_or_default()));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_tunnel_endpoints(
    config_file: String,
    cert_path: Option<String>,
    tunnel_id: Option<String>,
) -> Result<Vec<IngressRule>, String> {
    if !config_file.is_empty() && std::path::Path::new(&config_file).exists() {
        let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
        let config: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
        let endpoints: Vec<IngressRule> = config.ingress.into_iter().filter(|r| r.hostname.is_some()).collect();
        return Ok(endpoints);
    }

    if let (Some(cert), Some(tid)) = (cert_path, tunnel_id) {
        let token = parse_cert_pem(&cert)?;
        let account_id = token.account_tag.ok_or("No accountID")?;
        let api_key = token.api_token.or(token.service_key).ok_or("No API key")?;

        let client = reqwest::Client::new();
        let url = format!("https://api.cloudflare.com/client/v4/accounts/{}/cfd_tunnel/{}/configurations", account_id, tid);
        let resp = client.get(&url).header("Authorization", format!("Bearer {}", api_key)).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            if let Some(rules) = json["result"]["config"]["ingress"].as_array() {
                let endpoints: Vec<IngressRule> = rules.iter().filter_map(|r| {
                    let hostname = r["hostname"].as_str().map(|s| s.to_string());
                    let service = r["service"].as_str().map(|s| s.to_string())?;
                    if hostname.is_some() {
                        Some(IngressRule { hostname, service })
                    } else { None }
                }).collect();
                return Ok(endpoints);
            }
        }
    }
    Ok(Vec::new())
}

#[tauri::command]
pub async fn delete_tunnel_endpoint(
    config_file: String,
    hostname: String,
    cert_path: Option<String>,
    tunnel_id: Option<String>,
) -> Result<(), String> {
    if !config_file.is_empty() && std::path::Path::new(&config_file).exists() {
        let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
        let mut config: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
        config.ingress.retain(|r| r.hostname.is_some() && r.hostname != Some(hostname.clone()));
        config.ingress.push(IngressRule { hostname: None, service: "http_status:404".to_string() });
        let new_content = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
        fs::write(config_file, new_content).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if let (Some(cert), Some(tid)) = (cert_path, tunnel_id) {
        let token = parse_cert_pem(&cert)?;
        let account_id = token.account_tag.ok_or("No accountID")?;
        let api_key = token.api_token.or(token.service_key).ok_or("No API key")?;

        let client = reqwest::Client::new();
        let url = format!("https://api.cloudflare.com/client/v4/accounts/{}/cfd_tunnel/{}/configurations", account_id, tid);
        let resp = client.get(&url).header("Authorization", format!("Bearer {}", api_key)).send().await.map_err(|e| e.to_string())?;
        let api_resp: CfApiResponse<CfTunnelConfig> = resp.json().await.map_err(|e| e.to_string())?;
        let mut ingress = api_resp.result.and_then(|r| r.config).and_then(|c| c.ingress).unwrap_or_default();

        ingress.retain(|r| r.hostname.is_some() && r.hostname != Some(hostname.clone()));
        ingress.push(CfIngressRule { hostname: None, service: Some("http_status:404".to_string()), origin_request: None });

        let body = serde_json::json!({ "config": { "ingress": ingress } });
        let put_resp = client.put(&url).header("Authorization", format!("Bearer {}", api_key)).json(&body).send().await.map_err(|e| e.to_string())?;
        if !put_resp.status().is_success() {
            return Err(format!("API error: {}", put_resp.text().await.unwrap_or_default()));
        }
        return Ok(());
    }

    Err("Deletion failed".to_string())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SyncResult {
    pub endpoints: Vec<IngressRule>,
    pub config_file: String,
}

#[derive(Deserialize, Debug)]
struct ArgoToken {
    #[serde(rename = "accountID")]
    account_tag: Option<String>,
    #[serde(rename = "apiToken")]
    api_token: Option<String>,
    #[serde(rename = "serviceKey")]
    service_key: Option<String>,
    #[allow(dead_code)]
    #[serde(rename = "zoneID")]
    zone_id: Option<String>,
}

#[derive(Deserialize, Serialize, Debug)]
struct CfApiResponse<T> {
    success: bool,
    result: Option<T>,
}

#[derive(Deserialize, Serialize, Debug)]
struct CfTunnelConfig {
    config: Option<CfTunnelConfigInner>,
}

#[derive(Deserialize, Serialize, Debug)]
struct CfTunnelConfigInner {
    ingress: Option<Vec<CfIngressRule>>,
}

#[derive(Deserialize, Serialize, Debug)]
struct CfIngressRule {
    hostname: Option<String>,
    service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_request: Option<serde_json::Value>,
}

fn parse_cert_pem(cert_path: &str) -> Result<ArgoToken, String> {
    let content = fs::read_to_string(cert_path)
        .map_err(|e| format!("Failed to read cert.pem: {}", e))?;

    // Extract JSON between ARGO TUNNEL TOKEN markers
    let start_marker = "-----BEGIN ARGO TUNNEL TOKEN-----";
    let end_marker = "-----END ARGO TUNNEL TOKEN-----";

    let start = content.find(start_marker)
        .ok_or("No ARGO TUNNEL TOKEN found in cert.pem")?;
    let end = content.find(end_marker)
        .ok_or("Malformed cert.pem")?;

    let b64 = content[start + start_marker.len()..end].trim();

    // base64 decode

    let decoded = base64_decode(b64)?;
    let token: ArgoToken = serde_json::from_str(&decoded)
        .map_err(|e| format!("Failed to parse token JSON: {}", e))?;

    Ok(token)
}

fn base64_decode(input: &str) -> Result<String, String> {
    // Simple base64 decoder without adding a dependency
    let clean: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = Vec::new();
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;

    for ch in clean.bytes() {
        if ch == b'=' { break; }
        let val = alphabet.iter().position(|&b| b == ch)
            .ok_or_else(|| format!("Invalid base64 character: {}", ch as char))? as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    String::from_utf8(output).map_err(|e| format!("Base64 decode error: {}", e))
}

#[tauri::command]
pub async fn sync_tunnel_endpoints(
    cert_path: String,
    tunnel_id: Option<String>,
    tunnel_name: String,
    mut config_file: String
) -> Result<SyncResult, String> {
    // Read tunnel_id from config.yml if not provided
    let tunnel_id = match tunnel_id {
        Some(id) if !id.is_empty() => id,
        _ => {
            // Read from config file
            if config_file.is_empty() || !std::path::Path::new(&config_file).exists() {
                return Err("Tunnel ID required for synced tunnels or local config missing".to_string());
            }
            let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
            let cfg: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
            cfg.tunnel
        }
    };

    // 1. Parse cert.pem to get API credentials
    let token = parse_cert_pem(&cert_path)?;
    let account_id = token.account_tag.ok_or("No AccountTag found in cert.pem")?;
    let api_key = token.api_token.or(token.service_key).ok_or("No API token found")?;

    // 2. Fetch remote tunnel configuration
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/cfd_tunnel/{}/configurations",
        account_id, tunnel_id
    );

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;

    if !resp.status().is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloudflare API error: {}", err_body));
    }

    let api_resp: CfApiResponse<CfTunnelConfig> = resp.json().await
        .map_err(|e| format!("Failed to parse API response: {}", e))?;

    let remote_ingress = api_resp.result
        .and_then(|r| r.config)
        .and_then(|c| c.ingress)
        .unwrap_or_default();

    let endpoints: Vec<IngressRule> = remote_ingress.iter().filter_map(|r| {
        let hostname = r.hostname.clone();
        let service = r.service.clone()?;
        if hostname.is_some() {
            Some(IngressRule { hostname, service })
        } else {
            None
        }
    }).collect();

    // 3. Update/Create local config.yml
    if config_file.is_empty() {
        let cert_p = std::path::Path::new(&cert_path);
        let date_str = chrono::Local::now().format("%Y%m%d").to_string();
        let filename = format!("{}_{}.yml", tunnel_name, date_str);
        
        if let Some(parent) = cert_p.parent() {
            config_file = parent.join(filename).to_string_lossy().to_string();
        } else {
            // Fallback to .cloudflared if cert_path is weird
            let home = dirs::home_dir().ok_or("Could not find home directory")?;
            let config_dir = home.join(".cloudflared");
            if !config_dir.exists() {
                fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
            }
            config_file = config_dir.join(filename).to_string_lossy().to_string();
        }
    }

    let mut local_config = if std::path::Path::new(&config_file).exists() {
        let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
        serde_yaml::from_str(&content).unwrap_or_else(|_| CloudflaredConfig {
            tunnel: tunnel_id.clone(),
            credentials_file: None,
            ingress: Vec::new(),
        })
    } else {
        CloudflaredConfig {
            tunnel: tunnel_id.clone(),
            credentials_file: None,
            ingress: Vec::new(),
        }
    };

    local_config.ingress.clear();
    for r in &remote_ingress {
        local_config.ingress.push(IngressRule {
            hostname: r.hostname.clone(),
            service: r.service.clone().unwrap_or_else(|| "http_status:404".to_string()),
        });
    }
    
    // Ensure catch-all
    if !local_config.ingress.iter().any(|r| r.hostname.is_none()) {
        local_config.ingress.push(IngressRule {
            hostname: None,
            service: "http_status:404".to_string(),
        });
    }

    let new_content = serde_yaml::to_string(&local_config).map_err(|e| e.to_string())?;
    fs::write(&config_file, new_content).map_err(|e| e.to_string())?;

    Ok(SyncResult {
        endpoints,
        config_file,
    })
}
