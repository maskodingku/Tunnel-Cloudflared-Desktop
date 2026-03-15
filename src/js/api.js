const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export const api = {
    getConfig: () => invoke('get_config'),
    saveConfig: (config) => invoke('save_app_config', { config }),
    checkBinary: () => invoke('check_binary_exists'),
    downloadBinary: () => invoke('download_cloudflared'),
    startTunnel: (name, token) => invoke('start_tunnel', { name, token }),
    stopTunnel: (name) => invoke('stop_tunnel', { name }),
    openBinaryFolder: () => invoke('open_binary_folder'),
    startQuickTunnel: (id, name, url) => invoke('start_quick_tunnel', { id, name, url }),
    loginCloudflareAccount: () => invoke('login_cloudflare_account'),
    finalizeCloudflareLogin: (name) => invoke('finalize_cloudflare_login', { name }),
    listAccountTunnels: (name) => invoke('list_account_tunnels', { name }),
    removeCloudflareAccount: (name) => invoke('remove_cloudflare_account', { name }),
    createTunnelViaAccount: (accountName, tunnelName) => invoke('create_tunnel_via_account', { accountName, tunnelName }),
    deleteRemoteTunnel: (accountName, tunnelName) => invoke('delete_remote_tunnel', { accountName, tunnelName }),
    addTunnelDnsRoute: (accountName, tunnelName, hostname) => invoke('add_tunnel_dns_route', { accountName, tunnelName, hostname }),
    updateLocalTunnelIngress: (configFile, hostname, protocol, destHost, destPort) =>
        invoke('update_local_tunnel_ingress', { configFile, hostname, protocol, destHost, destPort }),
    getTunnelEndpoints: (configFile) => invoke('get_tunnel_endpoints', { configFile }),
    deleteTunnelEndpoint: (configFile, hostname) => invoke('delete_tunnel_endpoint', { configFile, hostname }),
    syncTunnelEndpoints: (certPath, tunnelId, configFile) => invoke('sync_tunnel_endpoints', { certPath, tunnelId, configFile }),
    pushTunnelConfig: (certPath, configFile) => invoke('push_tunnel_config', { certPath, configFile }),
    openUrl: (url) => invoke('open_external_url', { url }),
    onDownloadProgress: (callback) => listen('binary-download-progress', (event) => callback(event.payload)),
    onLog: (callback) => listen('tunnel-log', (event) => callback(event.payload)),
    onMetrics: (callback) => listen('tunnel-metrics', (event) => callback(event.payload)),
    onQuickUrl: (callback) => listen('quick-tunnel-url-ready', (event) => callback(event.payload)),
};
