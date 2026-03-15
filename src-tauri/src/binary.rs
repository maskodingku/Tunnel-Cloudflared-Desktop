use std::path::PathBuf;
use std::fs;
use tauri::{AppHandle, Manager, Emitter};
use futures_util::StreamExt;
use reqwest::Client;
use std::io::Write;

pub fn get_binary_path(app_handle: &AppHandle) -> PathBuf {
    let path = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("cloudflared-windows-amd64.exe");
    println!("Binary path: {:?}", path);
    path
}

pub fn check_binary(app_handle: &AppHandle) -> bool {
    get_binary_path(app_handle).exists()
}

#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    percentage: f64,
    downloaded: u64,
    total: u64,
}

pub async fn download_binary(app_handle: &AppHandle) -> Result<(), String> {
    let target_path = get_binary_path(app_handle);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
    let client = Client::new();
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    
    let total_size = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    
    let mut file = fs::File::create(&target_path).map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        
        downloaded += chunk.len() as u64;
        
        if total_size > 0 {
            let percentage = (downloaded as f64 / total_size as f64) * 100.0;
            let _ = app_handle.emit("binary-download-progress", DownloadProgress {
                percentage,
                downloaded,
                total: total_size,
            });
        }
    }

    Ok(())
}
