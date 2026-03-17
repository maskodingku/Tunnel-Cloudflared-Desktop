mod config;
mod binary;
mod tunnel;
mod accounts;

use tauri::{AppHandle, Manager, State};
use config::AppConfig;
use tunnel::TunnelProcessManager;
use accounts::{
    login_cloudflare_account, finalize_cloudflare_login, list_cloudflare_accounts, 
    list_account_tunnels, remove_cloudflare_account, create_tunnel_via_account, 
    delete_remote_tunnel, add_tunnel_dns_route, update_local_tunnel_ingress, 
    get_tunnel_endpoints, delete_tunnel_endpoint, sync_tunnel_endpoints,
    push_tunnel_config, check_login_cert_exists, abort_cloudflare_login,
    sync_account_tunnels
};

#[tauri::command]
async fn get_config(app_handle: AppHandle) -> AppConfig {
    config::load_config(&app_handle)
}

#[tauri::command]
async fn save_app_config(app_handle: AppHandle, config: AppConfig) -> Result<(), String> {
    config::save_config(&app_handle, &config)
}

#[tauri::command]
async fn check_binary_exists(app_handle: AppHandle) -> bool {
    binary::check_binary(&app_handle)
}

#[tauri::command]
async fn download_cloudflared(app_handle: AppHandle) -> Result<(), String> {
    binary::download_binary(&app_handle).await
}

#[tauri::command]
async fn start_tunnel(
    app_handle: AppHandle,
    state: State<'_, TunnelProcessManager>,
    name: String,
    token: String,
) -> Result<(), String> {
    let config = config::load_config(&app_handle);
    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle).to_string_lossy().to_string()
    } else {
        config.cloudflared_path
    };

    if !std::path::Path::new(&binary_path).exists() {
        return Err("Cloudflared binary not found. Please download it first.".to_string());
    }

    // Find the config for this tunnel to see if it has a local config file
    let tunnel_config = config.tunnels.iter().find(|t| t.name == name);
    let config_file = tunnel_config.and_then(|t| t.config_file.clone());

    state.start_tunnel(app_handle, name, token, config_file, binary_path).await
}

#[tauri::command]
async fn start_quick_tunnel(
    app_handle: AppHandle,
    state: State<'_, TunnelProcessManager>,
    id: String,
    name: String,
    url: String,
    no_tls_verify: bool,
) -> Result<(), String> {
    let config = config::load_config(&app_handle);
    let binary_path = if config.cloudflared_path.is_empty() {
        binary::get_binary_path(&app_handle).to_string_lossy().to_string()
    } else {
        config.cloudflared_path
    };

    if !std::path::Path::new(&binary_path).exists() {
        return Err("Cloudflared binary not found. Please download it first.".to_string());
    }

    state.start_quick_tunnel(app_handle, id, name, url, binary_path, no_tls_verify).await
}

#[tauri::command]
fn stop_tunnel(state: State<'_, TunnelProcessManager>, name: String) -> Result<(), String> {
    state.stop_tunnel(&name)
}

#[tauri::command]
async fn open_binary_folder(app_handle: AppHandle) -> Result<(), String> {
    let path = binary::get_binary_path(&app_handle);
    if let Some(parent) = path.parent() {
        let _ = tauri_plugin_opener::open_path(parent.to_string_lossy().to_string(), None::<&str>);
    }
    Ok(())
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(TunnelProcessManager::new())
        .setup(|app| {
            let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).unwrap();
            let show_item = tauri::menu::MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>).unwrap();
            let menu = tauri::menu::Menu::with_items(app, &[&show_item, &quit_item]).unwrap();

            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        let state: tauri::State<TunnelProcessManager> = app.state();
                        state.stop_all();
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api: _, .. } = event {
                let app = window.app_handle();
                let state: tauri::State<TunnelProcessManager> = app.state();
                state.stop_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_app_config,
            check_binary_exists,
            download_cloudflared,
            start_tunnel,
            start_quick_tunnel,
            stop_tunnel,
            open_binary_folder,
            login_cloudflare_account,
            abort_cloudflare_login,
            finalize_cloudflare_login,
            check_login_cert_exists,
            list_cloudflare_accounts,
            list_account_tunnels,
            sync_account_tunnels,
            remove_cloudflare_account,
            create_tunnel_via_account,
            delete_remote_tunnel,
            add_tunnel_dns_route,
            update_local_tunnel_ingress,
            get_tunnel_endpoints,
            delete_tunnel_endpoint,
            sync_tunnel_endpoints,
            push_tunnel_config,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
