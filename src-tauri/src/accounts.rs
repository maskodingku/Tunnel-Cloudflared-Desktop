use std::path::PathBuf;
use std::fs;
use std::process::Command;
use tauri::{AppHandle, Manager};
use crate::config::{CloudflareAccount, load_config, save_config};
use crate::binary;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IngressRule {
    pub hostname: Option<String>,
    pub service: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CloudflaredConfig {
    pub tunnel: String,
    #[serde(rename = "credentials-file")]
    pub credentials_file: String,
    pub ingress: Vec<IngressRule>,
}

#[tauri::command]
pub async fn login_cloudflare_account(app_handle: AppHandle) -> Result<(), String> {
    let config = load_config(&app_handle);
    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle)
    } else {
        PathBuf::from(config.cloudflared_path)
    };

    if !binary_path.exists() {
        return Err("Cloudflared binary not found.".to_string());
    }

    // Run login command. This will open the browser.
    // We don't wait for it to finish because it's interactive in the browser.
    Command::new(binary_path)
        .arg("tunnel")
        .arg("login")
        .spawn()
        .map_err(|e| format!("Failed to start login: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn finalize_cloudflare_login(app_handle: AppHandle, name: String) -> Result<(), String> {
    // 1. Locate the default cert.pem created by cloudflared
    // On Windows: %USERPROFILE%\.cloudflared\cert.pem
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

    let output = Command::new(binary_path)
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
pub async fn remove_cloudflare_account(app_handle: AppHandle, name: String) -> Result<(), String> {
    let mut config = load_config(&app_handle);
    
    if let Some(pos) = config.accounts.iter().position(|a| a.name == name) {
        let account = config.accounts.remove(pos);
        
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

    let create_output = Command::new(&binary_path)
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
    let output = Command::new(binary_path)
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
    let output = Command::new(binary_path)
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
    dest_port: u16
) -> Result<(), String> {
    let service = if protocol == "unix" {
        format!("unix:{}", dest_host)
    } else {
        format!("{}://{}:{}", protocol, dest_host, dest_port)
    };

    if !std::path::Path::new(&config_file).exists() {
        return Err("Config file not found. Please create the tunnel first.".to_string());
    }

    let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
    let mut config: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;

    // Remove existing catch-all
    config.ingress.retain(|r| r.service != "http_status:404");

    // Add new rule
    config.ingress.push(IngressRule {
        hostname: Some(hostname),
        service,
    });

    // Add back catch-all at the end
    config.ingress.push(IngressRule {
        hostname: None,
        service: "http_status:404".to_string(),
    });

    let new_content = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
    fs::write(config_file, new_content).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn push_tunnel_config(
    cert_path: String,
    config_file: String
) -> Result<(), String> {
    // 1. Read local config
    if !std::path::Path::new(&config_file).exists() {
        return Err("Config file not found".to_string());
    }
    let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
    let local_config: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
    let tunnel_id = local_config.tunnel.clone();

    // 2. Parse cert.pem for API credentials
    let token = parse_cert_pem(&cert_path)?;
    let account_id = token.account_tag
        .ok_or("No accountID found in cert.pem")?;
    let api_key = token.api_token
        .or(token.service_key)
        .ok_or("No API token found in cert.pem")?;

    // 3. Build ingress payload for Cloudflare API
    let ingress_payload: Vec<serde_json::Value> = local_config.ingress.iter().map(|r| {
        let mut obj = serde_json::Map::new();
        if let Some(ref h) = r.hostname {
            obj.insert("hostname".to_string(), serde_json::Value::String(h.clone()));
        }
        obj.insert("service".to_string(), serde_json::Value::String(r.service.clone()));
        serde_json::Value::Object(obj)
    }).collect();

    let body = serde_json::json!({
        "config": {
            "ingress": ingress_payload
        }
    });

    // 4. PUT to Cloudflare API
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/cfd_tunnel/{}/configurations",
        account_id, tunnel_id
    );

    let resp = client.put(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.map_err(|e| e.to_string())?;
        return Err(format!("Cloudflare API error {}: {}", status, err_body));
    }

    Ok(())
}

#[tauri::command]
pub async fn get_tunnel_endpoints(config_file: String) -> Result<Vec<IngressRule>, String> {
    if !std::path::Path::new(&config_file).exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
    let config: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
    
    // Filter out the catch-all rule (http_status:404) if we want to show only custom ones
    let endpoints: Vec<IngressRule> = config.ingress.into_iter()
        .filter(|r| r.hostname.is_some())
        .collect();
        
    Ok(endpoints)
}

#[tauri::command]
pub async fn delete_tunnel_endpoint(config_file: String, hostname: String) -> Result<(), String> {
    if !std::path::Path::new(&config_file).exists() {
        return Err("Config file not found.".to_string());
    }
    let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
    let mut config: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;

    let before = config.ingress.len();
    config.ingress.retain(|r| {
        r.hostname.as_deref() != Some(&hostname)
    });

    if config.ingress.len() == before {
        return Err(format!("Endpoint '{}' not found in config", hostname));
    }

    // Ensure catch-all still exists
    if !config.ingress.iter().any(|r| r.hostname.is_none()) {
        config.ingress.push(IngressRule {
            hostname: None,
            service: "http_status:404".to_string(),
        });
    }

    let new_content = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
    fs::write(config_file, new_content).map_err(|e| e.to_string())?;

    Ok(())
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

#[derive(Deserialize, Debug)]
struct CfApiResponse<T> {
    success: bool,
    result: Option<T>,
}

#[derive(Deserialize, Debug)]
struct CfTunnelConfig {
    config: Option<CfTunnelConfigInner>,
}

#[derive(Deserialize, Debug)]
struct CfTunnelConfigInner {
    ingress: Option<Vec<CfIngressRule>>,
}

#[derive(Deserialize, Debug)]
struct CfIngressRule {
    hostname: Option<String>,
    service: Option<String>,
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
    config_file: String
) -> Result<Vec<IngressRule>, String> {
    // Read tunnel_id from config.yml if not provided
    let tunnel_id = match tunnel_id {
        Some(id) if !id.is_empty() => id,
        _ => {
            // Read from config file
            if !std::path::Path::new(&config_file).exists() {
                return Err("Config file not found".to_string());
            }
            let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
            let cfg: CloudflaredConfig = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
            cfg.tunnel
        }
    };

    // 1. Parse cert.pem to get API credentials
    let token = parse_cert_pem(&cert_path)?;

    let account_id = token.account_tag
        .ok_or("No AccountTag found in cert.pem")?;

    let api_key = token.api_token
        .or(token.service_key)
        .ok_or("No API token or service key found in cert.pem")?;

    // 2. Fetch remote tunnel configuration from Cloudflare API
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/cfd_tunnel/{}/configurations",
        account_id, tunnel_id
    );

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("Cloudflare API returned {}: {}", status, body));
    }

    let api_resp: CfApiResponse<CfTunnelConfig> = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse API response: {}", e))?;

    if !api_resp.success {
        return Err("Cloudflare API returned success=false".to_string());
    }

    let remote_config = api_resp.result
        .ok_or("No result in API response")?;

    let remote_ingress = remote_config.config
        .and_then(|c| c.ingress)
        .unwrap_or_default();

    // 3. Update local config.yml with remote ingress rules
    if !std::path::Path::new(&config_file).exists() {
        return Err("Local config file not found".to_string());
    }

    let content = fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
    let mut local_config: CloudflaredConfig = serde_yaml::from_str(&content)
        .map_err(|e| e.to_string())?;

    // Replace ingress rules with remote ones
    local_config.ingress.clear();
    for rule in &remote_ingress {
        local_config.ingress.push(IngressRule {
            hostname: rule.hostname.clone(),
            service: rule.service.clone().unwrap_or_else(|| "http_status:404".to_string()),
        });
    }

    // Ensure catch-all exists
    if !local_config.ingress.iter().any(|r| r.hostname.is_none()) {
        local_config.ingress.push(IngressRule {
            hostname: None,
            service: "http_status:404".to_string(),
        });
    }

    let new_content = serde_yaml::to_string(&local_config).map_err(|e| e.to_string())?;
    fs::write(&config_file, new_content).map_err(|e| e.to_string())?;

    // 4. Return updated endpoints (filtered, no catch-all)
    let endpoints: Vec<IngressRule> = local_config.ingress.into_iter()
        .filter(|r| r.hostname.is_some())
        .collect();

    Ok(endpoints)
}
