import { api } from './js/api.js';

// State Management
const state = {
  config: null,
  currentView: 'dashboard',
  binaryExists: false,
  logs: {}, // tunnelName -> array of logs
};

// UI Elements
const els = {
  navLinks: document.querySelectorAll('.nav-link'),
  content: document.getElementById('content'),
  viewTitle: document.getElementById('view-title'),
};

// Routing
const routes = {
  dashboard: renderDashboard,
  tunnels: renderTunnels,
  quick_tunnels: renderQuickTunnels,
  accounts: renderAccounts,
  logs: renderLogs,
  settings: renderSettings,
};

async function init() {
  state.config = await api.getConfig();
  state.binaryExists = await api.checkBinary();
  state.metrics = {}; // tunnelName -> metrics object

  setupNav();
  setupSocialLinks();
  renderView('dashboard');

  api.onMetrics((metrics) => {
    state.metrics[metrics.tunnel_name] = metrics;
    // Update UI if we are on dashboard or tunnels view
    if (state.currentView === 'dashboard') {
      updateDashboardMetrics();
    } else if (state.currentView === 'tunnels') {
      updateTunnelRow(metrics);
    } else if (state.currentView === 'quick_tunnels') {
      updateQuickTunnelRow(metrics);
    }
  });
  // Auto-start tunnels if enabled
  if (state.config.auto_start && state.binaryExists) {
    console.log('Auto-start enabled, starting tunnels...');
    for (const tunnel of state.config.tunnels) {
      try {
        await api.startTunnel(tunnel.name, tunnel.token);
        tunnel.status = 'running';
      } catch (e) {
        console.error(`Failed to auto-start tunnel ${tunnel.name}:`, e);
      }
    }
    await api.saveConfig(state.config);
    renderView(state.currentView); // Refresh current view to show running status
  }

  api.onLog((payload) => {
    if (!state.logs[payload.tunnel_name]) state.logs[payload.tunnel_name] = [];
    state.logs[payload.tunnel_name].push(payload.message);
    // keep only last 1000 logs
    if (state.logs[payload.tunnel_name].length > 1000) state.logs[payload.tunnel_name].shift();

    // If we are currently in log view, we might want to update it
    if (state.currentView === 'logs') {
      updateLogDisplay(payload.tunnel_name, payload.message);
    }
  });

  api.onQuickUrl((payload) => {
    const qt = (state.config.quick_tunnels || []).find(t => t.id === payload.id);
    if (qt) {
      qt.public_url = payload.url;
      qt.status = 'running';
      if (state.currentView === 'quick_tunnels') {
        renderQuickTunnels();
      }
      if (state.currentView === 'dashboard') {
        renderDashboard();
      }
    }
  });

  api.onDownloadProgress((payload) => {
    state.downloadProgress = payload;
    const downloadBtn = document.getElementById('btn-download');
    if (downloadBtn) {
      downloadBtn.textContent = `Downloading ${Math.round(payload.percentage)}%`;
      downloadBtn.style.background = `linear-gradient(to right, #3b82f6 ${payload.percentage}%, #1e293b ${payload.percentage}%)`;
    }
  });
}

function setupNav() {
  els.navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const view = link.getAttribute('data-view');
      renderView(view);
    });
  });
}

function setupSocialLinks() {
  const socialLinks = document.querySelectorAll('.flex.items-center.justify-center.gap-4.mt-2.pt-2 a');
  socialLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = link.getAttribute('href');
      api.openUrl(url);
    });
  });
}

function renderView(view) {
  state.currentView = view;
  els.navLinks.forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-view') === view);
  });

  if (view === 'tunnels') {
    els.viewTitle.textContent = 'Tunnel With Token';
  } else {
    els.viewTitle.textContent = view.charAt(0).toUpperCase() + view.slice(1).replace('_', ' ');
  }

  if (routes[view]) {
    routes[view]();
  }
}

// Views
function renderDashboard() {
  const totalTunnels = state.config.tunnels.length;
  const activeTunnels = state.config.tunnels.filter(t => t.status === 'running').length;

  els.content.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 animate-in slide-in-from-bottom-4 duration-500">
            <div class="bg-devops-card p-5 rounded-2xl border border-devops-border">
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Total Tunnels</p>
                <h3 class="text-3xl font-bold text-white mt-1">${totalTunnels}</h3>
            </div>
            <div class="bg-devops-card p-5 rounded-2xl border border-devops-border">
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Active</p>
                <div class="flex items-center gap-2 mt-1">
                    <h3 class="text-3xl font-bold text-green-500">${activeTunnels}</h3>
                    <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                </div>
            </div>
            <div class="bg-devops-card p-5 rounded-2xl border border-devops-border">
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Quick Tunnels</p>
                <div class="flex items-center gap-2 mt-1">
                    <h3 class="text-3xl font-bold text-yellow-500">${(state.config.quick_tunnels || []).filter(t => t.status === 'running').length}</h3>
                    <div class="text-[10px] text-slate-400 font-mono">/ ${(state.config.quick_tunnels || []).length}</div>
                </div>
            </div>
            <div class="bg-devops-card p-5 rounded-2xl border border-devops-border">
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Download (Total)</p>
                <h3 id="dash-total-in" class="text-2xl font-bold text-blue-400 mt-1">0 B/s</h3>
            </div>
            <div class="bg-devops-card p-5 rounded-2xl border border-devops-border">
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Upload (Total)</p>
                <h3 id="dash-total-out" class="text-2xl font-bold text-purple-400 mt-1">0 B/s</h3>
            </div>
        </div>

        <div class="mt-8 bg-devops-card rounded-2xl border border-devops-border overflow-hidden">
            <div class="px-6 py-4 border-b border-devops-border flex items-center justify-between">
                <h4 class="font-semibold text-white">System Status</h4>
            </div>
            <div class="p-6 space-y-4">
                <div class="flex items-center justify-between p-4 bg-devops-dark rounded-xl border border-devops-border">
                    <div class="flex items-center gap-4">
                        <div class="w-10 h-10 bg-blue-500/10 rounded-lg flex items-center justify-center text-blue-500 font-bold">B</div>
                        <div>
                            <p class="text-sm font-semibold text-white">Cloudflared Binary</p>
                            <p class="text-xs text-slate-400">${state.binaryExists ? 'Detected and ready' : 'Not found'}</p>
                        </div>
                    </div>
                    ${state.binaryExists
      ? `
                        <div class="flex gap-2">
                            <button id="btn-open-folder" class="px-4 py-2 bg-slate-700 text-white text-xs font-bold rounded-lg hover:bg-slate-600 transition-colors">Open Folder</button>
                            <span class="px-3 py-1 bg-green-500/10 text-green-500 text-[10px] font-bold rounded-full border border-green-500/20 flex items-center">READY</span>
                        </div>
                        `
      : '<button id="btn-download" class="px-4 py-2 bg-devops-accent text-white text-xs font-bold rounded-lg hover:bg-blue-600 transition-colors">Download</button>'}
                </div>
            </div>
        </div>
    `;

  const openFolderBtn = document.getElementById('btn-open-folder');
  if (openFolderBtn) {
    openFolderBtn.addEventListener('click', () => api.openBinaryFolder());
  }

  const downloadBtn = document.getElementById('btn-download');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Downloading...';
      try {
        await api.downloadBinary();
        state.binaryExists = true;
        renderDashboard();
      } catch (e) {
        alert('Download failed: ' + e);
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Download';
      }
    });
  }
}

function renderTunnels() {
  els.content.innerHTML = `
        <div class="flex justify-between items-center mb-6">
            <h3 class="text-xl font-bold text-white">Tunnel Connector</h3>
            <button id="btn-add-tunnel" class="px-4 py-2 bg-devops-accent text-white text-sm font-bold rounded-lg hover:bg-blue-600 transition-all flex items-center gap-2">
                <span>+</span> Add Tunnel
            </button>
        </div>

        <div class="mb-6 p-4 bg-blue-500/5 border border-blue-500/20 rounded-2xl flex gap-4 items-start animate-in slide-in-from-top-2 duration-500">
            <div class="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center text-blue-500 flex-shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            </div>
            <div>
                <p class="text-xs font-bold text-blue-400 uppercase tracking-wider mb-1">Informasi Konfigurasi</p>
                <p class="text-xs text-slate-400 leading-relaxed">
                    Jika Anda menggunakan Tunnel Connector, konfigurasi endpoint seperti domain, hostname, dan routing tidak dapat diubah dari aplikasi ini. 
                    <span class="text-white font-medium">Semua pengaturan tersebut harus dilakukan melalui Cloudflare Zero Trust Dashboard.</span>
                </p>
            </div>
        </div>

        <div class="bg-devops-card rounded-2xl border border-devops-border overflow-hidden animate-in fade-in duration-500">
            <table class="w-full text-left">
                <thead class="bg-devops-dark/50 border-b border-devops-border">
                    <tr>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Name</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Status</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Latency</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Bandwidth</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-devops-border">
                    ${state.config.tunnels.length === 0 ? `
                        <tr>
                            <td colspan="5" class="px-6 py-12 text-center text-slate-500 italic">No tunnels configured. Click "Add Tunnel" to start.</td>
                        </tr>
                    ` : state.config.tunnels.map((t, idx) => {
    const m = state.metrics[t.name] || { status: t.status, latency_ms: 0, bandwidth_in: 0, bandwidth_out: 0 };
    return `
                        <tr class="hover:bg-slate-800/30 transition-colors group">
                            <td class="px-6 py-4">
                                <div class="flex items-center gap-2">
                                    <div class="font-medium text-white">${t.name}</div>
                                    ${t.account_tag ? `<span class="px-1.5 py-0.5 bg-devops-accent/10 border border-devops-accent/20 text-devops-accent text-[8px] font-bold rounded uppercase">via ${t.account_tag}</span>` : ''}
                                </div>
                                <div class="font-mono text-[9px] text-slate-500 truncate max-w-[150px]">${t.token}</div>
                            </td>
                            <td class="px-6 py-4">
                                <span id="metrics-status-${t.name}" class="px-2 py-1 ${t.status === 'running' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'} text-[10px] font-bold rounded-full border">
                                    ${t.status.toUpperCase()}
                                </span>
                            </td>
                            <td class="px-6 py-4 font-mono text-xs text-slate-300" id="metrics-latency-${t.name}">
                                ${formatLatency(m.latency_ms)}
                            </td>
                            <td class="px-6 py-4 font-mono text-[10px] space-x-2" id="metrics-bandwidth-${t.name}">
                                <span class="text-blue-400">↓ ${formatBytes(m.bandwidth_in)}</span>
                                <span class="text-purple-400">↑ ${formatBytes(m.bandwidth_out)}</span>
                            </td>
                            <td class="px-6 py-4 text-right space-x-2">
                                 <button onclick="toggleTunnel('${t.name}', '${t.status}')" class="p-2 px-3 bg-slate-700/50 hover:bg-slate-700 text-slate-300 text-xs rounded-lg transition-colors">
                                     ${t.status === 'running' ? 'Stop' : 'Start'}
                                 </button>
                                 ${t.account_tag ? `
                                    <button onclick="showEndpointsModal('${t.name}')" class="p-2 px-3 bg-devops-accent/10 hover:bg-devops-accent/20 text-devops-accent text-xs rounded-lg transition-colors flex items-center gap-1 inline-flex">
                                        <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                                        </svg>
                                        Endpoint
                                    </button>
                                 ` : ''}
                                <button onclick="showDeleteTunnelModal('${t.name}')" class="p-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-lg transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                </button>
                            </td>
                        </tr>
                    `}).join('')}
                </tbody>
            </table>
        </div>
    `;

  document.getElementById('btn-add-tunnel').addEventListener('click', showAddTunnelModal);
}

function renderQuickTunnels() {
  const quickTunnels = state.config.quick_tunnels || [];
  els.content.innerHTML = `
        <div class="flex justify-between items-center mb-6">
            <h3 class="text-xl font-bold text-white">Quick Tunnels <span class="text-[10px] bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 px-2 py-0.5 rounded-full ml-2">TEMPORARY</span></h3>
            <button id="btn-add-quick" class="px-4 py-2 bg-yellow-500 text-black text-sm font-bold rounded-lg hover:bg-yellow-400 transition-all flex items-center gap-2">
                ⚡ Create Quick Tunnel
            </button>
        </div>

        <div class="mb-6 p-4 bg-yellow-500/5 border border-yellow-500/10 rounded-2xl flex gap-4 items-start animate-in slide-in-from-top-2 duration-500">
            <div class="w-10 h-10 bg-yellow-500/10 rounded-xl flex items-center justify-center text-yellow-500 flex-shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            </div>
            <div>
                <p class="text-xs font-bold text-yellow-500 uppercase tracking-wider mb-1">Panduan Quick Tunnel</p>
                <div class="text-xs text-slate-400 leading-relaxed space-y-2">
                    <p>Quick Tunnel memungkinkan Anda membuat Cloudflare Tunnel secara instan tanpa memerlukan akun Cloudflare atau Tunnel Token.</p>
                    <p>Aplikasi ini akan menjalankan perintah <code class="bg-black/40 px-1 rounded text-yellow-200/70">cloudflared</code> untuk membuat tunnel sementara yang langsung terhubung ke layanan lokal Anda. <span class="text-white">Quick Tunnel bersifat sementara dan URL yang diberikan dapat berubah setiap kali tunnel dijalankan.</span></p>
                    <p>URL yang diberikan juga tidak dapat dikonfigurasi (seperti custom domain). Fitur ini cocok untuk testing, demo, atau berbagi akses sementara ke aplikasi lokal.</p>
                </div>
            </div>
        </div>

        <div class="bg-devops-card rounded-2xl border border-devops-border overflow-hidden animate-in fade-in duration-500">
            <table class="w-full text-left">
                <thead class="bg-devops-dark/50 border-b border-devops-border">
                    <tr>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Name</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Local URL</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Public URL</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Status</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Latency</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-devops-border">
                    ${quickTunnels.length === 0 ? `
                        <tr>
                            <td colspan="6" class="px-6 py-12 text-center text-slate-500 italic">No quick tunnels yet. Create one to expose local dev servers instantly.</td>
                        </tr>
                    ` : quickTunnels.map((qt) => {
    const m = state.metrics[qt.id] || { status: qt.status, latency_ms: 0, bandwidth_in: 0, bandwidth_out: 0 };
    return `
                        <tr class="hover:bg-slate-800/30 transition-colors group">
                            <td class="px-6 py-4 font-medium text-white">${qt.name}</td>
                            <td class="px-6 py-4 font-mono text-xs text-slate-400">${qt.protocol}://${qt.hostname}:${qt.port}</td>
                            <td class="px-6 py-4">
                                ${qt.status === 'running' && qt.public_url ? `
                                    <div class="flex items-center gap-2">
                                        <a href="${qt.public_url}" target="_blank" class="text-devops-accent text-xs font-mono hover:underline font-bold">${qt.public_url}</a>
                                        <button onclick="copyQuickUrl('${qt.public_url}')" class="p-1.5 hover:bg-slate-700 rounded text-slate-400" title="Copy URL">
                                            <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                                            </svg>
                                        </button>
                                    </div>
                                ` : qt.status === 'starting' ? `
                                    <span class="text-xs text-slate-500 italic animate-pulse">Generating URL...</span>
                                ` : `
                                    <span class="text-xs text-slate-600">-- Offline --</span>
                                `}
                            </td>
                            <td class="px-6 py-4">
                                <span id="qt-status-${qt.id}" class="px-2 py-1 ${qt.status === 'running' ? 'bg-green-500/10 text-green-500 border-green-500/20' : qt.status === 'starting' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'} text-[10px] font-bold rounded-full border">
                                    ${qt.status.toUpperCase()}
                                </span>
                            </td>
                            <td class="px-6 py-4">
                                <div class="font-mono text-[10px] text-slate-300" id="qt-metrics-latency-${qt.id}">${formatLatency(m.latency_ms)}</div>
                                <div class="font-mono text-[9px] mt-1 space-x-1" id="qt-metrics-bandwidth-${qt.id}">
                                    <span class="text-blue-400/80">↓${formatBytes(m.bandwidth_in)}</span>
                                    <span class="text-purple-400/80">↑${formatBytes(m.bandwidth_out)}</span>
                                </div>
                            </td>
                            <td class="px-6 py-4 text-right space-x-2">
                                <button onclick="showEditQuickTunnelModal('${qt.id}')" class="p-2 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors" title="Edit Configuration">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                    </svg>
                                </button>
                                <button onclick="toggleQuickTunnel('${qt.id}', '${qt.status}')" class="p-2 px-3 bg-slate-700/50 hover:bg-slate-700 text-slate-300 text-xs rounded-lg transition-colors">
                                    ${qt.status === 'running' || qt.status === 'starting' ? 'Stop' : 'Start'}
                                </button>
                                <button onclick="deleteQuickTunnel('${qt.id}')" class="p-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-lg transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                </button>
                            </td>
                        </tr>
                    `}).join('')}
                </tbody>
            </table>
        </div>
    `;

  document.getElementById('btn-add-quick').addEventListener('click', showAddQuickTunnelModal);
}

function renderAccounts() {
  const accounts = state.config.accounts || [];
  els.content.innerHTML = `
        <div class="flex justify-between items-center mb-6">
            <h3 class="text-xl font-bold text-white">Cloudflare Accounts</h3>
            <button id="btn-add-account" class="px-4 py-2 bg-devops-accent text-white text-sm font-bold rounded-lg hover:bg-blue-600 transition-all flex items-center gap-2">
                <span>+</span> Add Account
            </button>
        </div>

        <div class="mb-6 p-4 bg-devops-card border border-devops-border rounded-2xl flex gap-4 items-start animate-in slide-in-from-top-2 duration-500">
            <div class="w-10 h-10 bg-devops-accent/10 rounded-xl flex items-center justify-center text-devops-accent flex-shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            </div>
            <div>
                <p class="text-xs text-slate-400 leading-relaxed italic">
                    Login dengan akun Cloudflare memungkinkan aplikasi mengelola tunnel secara langsung seperti membuat tunnel baru, melihat daftar tunnel, dan mengelola endpoint routing.
                </p>
            </div>
        </div>

        <div class="bg-devops-card rounded-2xl border border-devops-border overflow-hidden animate-in fade-in duration-500">
            <table class="w-full text-left">
                <thead class="bg-devops-dark/50 border-b border-devops-border">
                    <tr>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Account Name</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase">Status</th>
                        <th class="px-6 py-4 text-xs font-bold text-slate-400 uppercase text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-devops-border">
                    ${accounts.length === 0 ? `
                        <tr>
                            <td colspan="3" class="px-6 py-12 text-center text-slate-500 italic">No accounts linked yet. Click "Add Account" to login.</td>
                        </tr>
                    ` : accounts.map((acc) => `
                        <tr class="hover:bg-slate-800/30 transition-colors group">
                            <td class="px-6 py-4 font-medium text-white">${acc.name}</td>
                            <td class="px-6 py-4">
                                <span class="px-2 py-1 bg-green-500/10 text-green-500 border border-green-500/20 text-[10px] font-bold rounded-full">
                                    ${acc.status.toUpperCase()}
                                </span>
                            </td>
                            <td class="px-6 py-4 text-right space-x-2">
                                <button onclick="viewAccountTunnels('${acc.name}')" class="p-2 px-3 bg-slate-700/50 hover:bg-slate-700 text-slate-300 text-xs rounded-lg transition-colors">
                                    View Tunnels
                                </button>
                                <button onclick="removeAccount('${acc.name}')" class="p-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-lg transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;

  document.getElementById('btn-add-account').addEventListener('click', showAddAccountModal);
}

window.showAddAccountModal = () => {
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
  modal.innerHTML = `
        <div class="bg-devops-card w-full max-w-sm rounded-2xl border border-devops-border shadow-2xl animate-in zoom-in-95 duration-200">
            <div class="p-6 border-b border-devops-border flex justify-between items-center">
                <h3 class="text-lg font-bold text-white">Add Cloudflare Account</h3>
                <button id="modal-close" class="text-slate-400 hover:text-white">&times;</button>
            </div>
            <div class="p-6 space-y-4">
                <p class="text-xs text-slate-400">Step 1: Click the button below to authorize this application in your browser.</p>
                <button id="btn-start-login" class="w-full bg-devops-accent text-white font-bold py-3 rounded-xl hover:bg-blue-600 transition-all">
                    Login via Browser
                </button>
                
                <div id="finalize-step" class="hidden space-y-4 pt-4 border-t border-devops-border">
                    <p class="text-xs text-slate-400 font-bold">Step 2: After login is successful in browser, give this account an alias name.</p>
                    <input type="text" id="account-alias" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent" placeholder="e.g. My Personal Account">
                    <button id="btn-finalize" class="w-full bg-green-600 text-white font-bold py-3 rounded-xl hover:bg-green-500 transition-all">
                        Finalize & Add Account
                    </button>
                </div>
            </div>
        </div>
    `;

  document.body.appendChild(modal);

  const close = () => modal.remove();
  document.getElementById('modal-close').onclick = close;

  const startBtn = document.getElementById('btn-start-login');
  const finalizeStep = document.getElementById('finalize-step');
  const finalizeBtn = document.getElementById('btn-finalize');

  startBtn.onclick = async () => {
    try {
      await api.loginCloudflareAccount();
      startBtn.textContent = 'Login Initiated...';
      startBtn.classList.replace('bg-devops-accent', 'bg-slate-700');
      finalizeStep.classList.remove('hidden');
    } catch (e) {
      alert('Failed to start login: ' + e);
    }
  };

  finalizeBtn.onclick = async () => {
    const name = document.getElementById('account-alias').value.trim();
    if (!name) return alert('Please enter an account alias');

    finalizeBtn.disabled = true;
    finalizeBtn.textContent = 'Verifying...';
    try {
      await api.finalizeCloudflareLogin(name);
      state.config = await api.getConfig();
      close();
      renderAccounts();
    } catch (e) {
      alert('Failed to finalize login: ' + e);
      finalizeBtn.disabled = false;
      finalizeBtn.textContent = 'Finalize & Add Account';
    }
  };
};

window.viewAccountTunnels = async (name) => {
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
  modal.innerHTML = `
        <div class="bg-devops-card w-full max-w-4xl rounded-3xl border border-devops-border shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
            <div class="p-6 border-b border-devops-border flex justify-between items-center bg-devops-dark/20">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 bg-devops-accent/10 rounded-2xl flex items-center justify-center text-devops-accent">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                    </div>
                    <div>
                        <h3 class="text-lg font-bold text-white">Cloudflare Tunnels</h3>
                        <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${name}</p>
                    </div>
                </div>
                <button id="modal-close" class="p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
            <div id="tunnels-list-container" class="flex-1 overflow-auto">
                <div class="flex items-center justify-center py-24">
                    <div class="flex flex-col items-center gap-4">
                        <div class="w-8 h-8 border-3 border-devops-accent border-t-transparent rounded-full animate-spin"></div>
                        <span class="text-xs font-bold text-slate-500 uppercase tracking-widest animate-pulse">Syncing with Cloudflare...</span>
                    </div>
                </div>
            </div>
        </div>
    `;

  document.body.appendChild(modal);
  document.getElementById('modal-close').onclick = () => modal.remove();

  try {
    const rawOutput = await api.listAccountTunnels(name);
    let tunnels = [];

    try {
      tunnels = JSON.parse(rawOutput) || [];
    } catch (parseErr) {
      console.error('Failed to parse tunnel JSON:', parseErr);
      // Fallback for empty or malformed output
      if (rawOutput && rawOutput.includes('id')) {
        // Not ideally JSON but let's try to show something
        document.getElementById('tunnels-list-container').innerHTML = `<pre class="p-6 text-xs text-slate-400 font-mono">${rawOutput}</pre>`;
        return;
      }
      tunnels = [];
    }

    const container = document.getElementById('tunnels-list-container');

    if (!tunnels || tunnels.length === 0) {
      container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <div class="w-16 h-16 bg-slate-800/50 rounded-full flex items-center justify-center text-slate-600 mb-4">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414a1 1 0 00-.707-.293H4" />
                    </svg>
                </div>
                <h4 class="text-lg font-bold text-slate-400">No Tunnels Found</h4>
                <p class="text-xs text-slate-500 mt-1 max-w-xs">You haven't created any tunnels on this account yet. Click "Add Tunnel" to get started.</p>
            </div>
        `;
      return;
    }

    container.innerHTML = `
        <div class="p-2">
            <table class="w-full text-left border-separate border-spacing-y-2">
                <thead>
                    <tr class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                        <th class="px-6 py-2">Tunnel Info</th>
                        <th class="px-6 py-2">Status</th>
                        <th class="px-6 py-2">Created At</th>
                        <th class="px-6 py-2">Connections</th>
                    </tr>
                </thead>
                <tbody class="space-y-2">
                    ${tunnels.map(t => {
      // Calculate status since JSON doesn't provide it directly
      const hasConnections = t.connections && t.connections.length > 0;
      const status = hasConnections ? 'healthy' : 'inactive';
      const isHealthy = status === 'healthy';

      const badgeClass = isHealthy ? 'bg-green-500/10 text-green-500 border-green-500/20' :
        'bg-slate-500/10 text-slate-500 border-slate-500/20';

      // Handle potential case differences from different cloudflared versions
      const createdAt = t.created_at || t.createdAt;

      return `
                        <tr class="bg-devops-dark/30 hover:bg-devops-dark/50 transition-all group rounded-2xl">
                            <td class="px-6 py-4 rounded-l-2xl">
                                <div class="flex flex-col">
                                    <span class="text-xs font-bold text-white group-hover:text-devops-accent transition-colors">${t.name}</span>
                                    <span class="text-[10px] font-mono text-slate-600 mt-1">${t.id}</span>
                                </div>
                            </td>
                            <td class="px-6 py-4">
                                <div class="flex items-center gap-2">
                                    <span class="w-1.5 h-1.5 rounded-full ${isHealthy ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}"></span>
                                    <span class="px-2 py-0.5 border rounded-lg text-[9px] font-bold uppercase tracking-wider ${badgeClass}">
                                        ${status}
                                    </span>
                                </div>
                            </td>
                            <td class="px-6 py-4">
                                <span class="text-[11px] text-slate-400 font-medium">
                                    ${createdAt ? new Date(createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A'}
                                </span>
                            </td>
                            <td class="px-6 py-4 rounded-r-2xl">
                                <div class="flex items-center gap-2">
                                    <div class="flex -space-x-1">
                                        ${Array.from({ length: Math.min(3, t.connections?.length || 0) }).map(() =>
        `<div class="w-2.5 h-2.5 rounded-full bg-blue-500/40 border border-devops-dark shadow-sm"></div>`
      ).join('')}
                                    </div>
                                    <span class="text-[10px] font-bold text-slate-500">${t.connections?.length || 0} Active</span>
                                </div>
                            </td>
                        </tr>
                        `;
    }).join('')}
                </tbody>
            </table>
        </div>
    `;
  } catch (e) {
    document.getElementById('tunnels-list-container').innerHTML = `
        <div class="p-12 text-center text-red-400">
            <div class="w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
            </div>
            <p class="font-bold uppercase tracking-widest text-[10px]">Failed to fetch tunnels</p>
            <p class="text-xs mt-2 opacity-60">${e}</p>
        </div>
    `;
  }
};

window.removeAccount = async (name) => {
  if (confirm(`Remove account "${name}" and delete its credentials?`)) {
    try {
      await api.removeCloudflareAccount(name);
      state.config = await api.getConfig();
      renderAccounts();
    } catch (e) {
      alert('Failed to remove account: ' + e);
    }
  }
};

window.toggleQuickTunnel = async (id, status) => {
  try {
    const qt = state.config.quick_tunnels.find(t => t.id === id);
    if (status === 'running' || status === 'starting') {
      await api.stopTunnel(id);
      if (qt) {
        qt.status = 'stopped';
        qt.public_url = '';
      }
    } else {
      if (qt) {
        qt.status = 'starting';
        await api.startQuickTunnel(qt.id, qt.name, `${qt.protocol}://${qt.hostname}:${qt.port}`);
      }
    }
    await api.saveConfig(state.config);
    renderQuickTunnels();
  } catch (e) {
    alert('Action failed: ' + e);
    const qt = state.config.quick_tunnels.find(t => t.id === id);
    if (qt) qt.status = 'stopped';
    renderQuickTunnels();
  }
};

window.deleteQuickTunnel = async (id) => {
  const qt = state.config.quick_tunnels.find(t => t.id === id);
  if (!qt) return;

  if (qt.status === 'running' || qt.status === 'starting') {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4';
    modal.innerHTML = `
      <div class="bg-devops-card w-full max-w-sm rounded-3xl border border-yellow-500/20 shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
          <div class="p-6 text-center">
              <div class="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center text-yellow-500 mx-auto mb-4 border border-yellow-500/20">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
              </div>
              <h3 class="text-lg font-bold text-white">Quick Tunnel Running</h3>
              <p class="text-xs text-slate-400 mt-2">Finish your session with <span class="text-white font-bold">"${qt.name}"</span> before deleting.</p>
          </div>
          <div class="p-4 bg-devops-dark/50">
              <button onclick="this.closest('.fixed').remove()" class="w-full py-3 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded-xl transition-all">Got it</button>
          </div>
      </div>
    `;
    document.body.appendChild(modal);
    return;
  }

  if (confirm(`Delete this quick tunnel configuration?`)) {
    state.config.quick_tunnels = state.config.quick_tunnels.filter(t => t.id !== id);
    await api.saveConfig(state.config);
    renderQuickTunnels();
  }
};

window.copyQuickUrl = (url) => {
  navigator.clipboard.writeText(url);
  // alert('URL copied to clipboard!');
};

window.showEditQuickTunnelModal = (id) => {
  const qt = state.config.quick_tunnels.find(t => t.id === id);
  if (!qt) return;

  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
  modal.innerHTML = `
        <div class="bg-devops-card w-full max-w-sm rounded-2xl border border-devops-border shadow-2xl animate-in zoom-in-95 duration-200">
            <div class="p-6 border-b border-devops-border flex justify-between items-center">
                <h3 class="text-lg font-bold text-white flex items-center gap-2">📂 Edit Quick Tunnel</h3>
                <button id="modal-close" class="text-slate-400 hover:text-white">&times;</button>
            </div>
            <form id="edit-quick-form" class="p-6 space-y-4">
                <div>
                    <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Tunnel Name</label>
                    <input type="text" name="name" required value="${qt.name}" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors">
                </div>
                <div class="grid grid-cols-3 gap-3">
                    <div class="col-span-1">
                        <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Protocol</label>
                        <select name="protocol" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none appearance-none">
                            <option value="http" ${qt.protocol === 'http' ? 'selected' : ''}>HTTP</option>
                            <option value="https" ${qt.protocol === 'https' ? 'selected' : ''}>HTTPS</option>
                        </select>
                    </div>
                    <div class="col-span-2">
                        <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Hostname</label>
                        <input type="text" name="hostname" required value="${qt.hostname}" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors">
                    </div>
                </div>
                <div>
                    <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Local Port</label>
                    <input type="number" name="port" required value="${qt.port}" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors">
                </div>
                <div>
                   <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Public URL (Readonly)</label>
                   <input type="text" readonly value="${qt.public_url || '-- Offline --'}" class="w-full bg-devops-dark/50 border border-devops-border rounded-xl px-4 py-2 text-[10px] text-slate-500 font-mono focus:outline-none cursor-not-allowed">
                </div>
                <div class="pt-4 flex gap-3">
                    <button type="button" id="modal-cancel" class="flex-1 bg-slate-700 text-white font-bold py-3 rounded-xl hover:bg-slate-600 transition-all">Cancel</button>
                    <button type="submit" class="flex-[2] bg-devops-accent text-white font-bold py-3 rounded-xl hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/10">
                        Save Changes
                    </button>
                </div>
                ${qt.status === 'running' ? '<p class="text-[9px] text-yellow-500/70 text-center italic">Saving will restart the tunnel and generate a new URL.</p>' : ''}
            </form>
        </div>
    `;

  document.body.appendChild(modal);

  const close = () => modal.remove();
  document.getElementById('modal-close').onclick = close;
  document.getElementById('modal-cancel').onclick = close;

  document.getElementById('edit-quick-form').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const wasRunning = (qt.status === 'running' || qt.status === 'starting');

    // 1. Stop if running
    if (wasRunning) {
      await api.stopTunnel(qt.id);
    }

    // 2. Update config
    qt.name = formData.get('name');
    qt.protocol = formData.get('protocol');
    qt.hostname = formData.get('hostname');
    qt.port = parseInt(formData.get('port'));
    qt.public_url = ''; // Reset public URL as it will change
    qt.status = 'stopped';

    // 3. Save to disk
    await api.saveConfig(state.config);

    // 4. Restart if it was running
    if (wasRunning) {
      qt.status = 'starting';
      await api.startQuickTunnel(qt.id, qt.name, `${qt.protocol}://${qt.hostname}:${qt.port}`);
    }

    close();
    renderQuickTunnels();
  };
};

function showAddQuickTunnelModal() {
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
  modal.innerHTML = `
        <div class="bg-devops-card w-full max-w-sm rounded-2xl border border-devops-border shadow-2xl animate-in zoom-in-95 duration-200">
            <div class="p-6 border-b border-devops-border flex justify-between items-center">
                <h3 class="text-lg font-bold text-white flex items-center gap-2">⚡ New Quick Tunnel</h3>
                <button id="modal-close" class="text-slate-400 hover:text-white">&times;</button>
            </div>
            <form id="add-quick-form" class="p-6 space-y-4">
                <div>
                    <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Tunnel Name</label>
                    <input type="text" name="name" required class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-yellow-500/50 transition-colors" placeholder="e.g. Frontend App">
                </div>
                <div class="grid grid-cols-3 gap-3">
                    <div class="col-span-1">
                        <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Protocol</label>
                        <select name="protocol" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none appearance-none">
                            <option value="http">HTTP</option>
                            <option value="https">HTTPS</option>
                        </select>
                    </div>
                    <div class="col-span-2">
                        <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Hostname</label>
                        <input type="text" name="hostname" required value="localhost" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-yellow-500/50 transition-colors">
                    </div>
                </div>
                <div>
                    <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Local Port</label>
                    <input type="number" name="port" required class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-yellow-500/50 transition-colors" placeholder="8080">
                </div>
                <div class="pt-4">
                    <button type="submit" class="w-full bg-yellow-500 text-black font-bold py-3 rounded-xl hover:bg-yellow-400 transition-all shadow-lg shadow-yellow-500/10">
                        Launch Quick Tunnel
                    </button>
                </div>
            </form>
        </div>
    `;

  document.body.appendChild(modal);

  const close = () => modal.remove();
  document.getElementById('modal-close').onclick = close;

  document.getElementById('add-quick-form').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);

    const qt = {
      id: crypto.randomUUID(),
      name: formData.get('name'),
      protocol: formData.get('protocol'),
      hostname: formData.get('hostname'),
      port: parseInt(formData.get('port')),
      public_url: '',
      status: 'stopped'
    };

    if (!state.config.quick_tunnels) state.config.quick_tunnels = [];
    state.config.quick_tunnels.push(qt);
    await api.saveConfig(state.config);
    close();
    renderQuickTunnels();
  };
}

window.toggleTunnel = async (name, status) => {
  try {
    if (status === 'running') {
      await api.stopTunnel(name);
      const tunnel = state.config.tunnels.find(t => t.name === name);
      if (tunnel) tunnel.status = 'stopped';
      delete state.metrics[name]; // Clear metrics to prevent stale "connecting" UI
    } else {
      const tunnel = state.config.tunnels.find(t => t.name === name);
      await api.startTunnel(name, tunnel.token);
      if (tunnel) tunnel.status = 'running';
    }
    await api.saveConfig(state.config);
    renderTunnels();
  } catch (e) {
    alert('Action failed: ' + e);
  }
};

window.showEndpointsModal = async (tunnelName) => {
  const tunnel = state.config.tunnels.find(t => t.name === tunnelName);
  if (!tunnel) return;

  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4';
  modal.innerHTML = `
        <div class="bg-devops-card w-full max-w-2xl rounded-3xl border border-devops-border shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden flex flex-col max-h-[80vh]">
            <div class="p-6 border-b border-devops-border bg-devops-dark/20 flex justify-between items-center">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 bg-devops-accent/10 rounded-2xl flex items-center justify-center text-devops-accent">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                    </div>
                    <div>
                        <h3 class="text-lg font-bold text-white">Tunnel Endpoints</h3>
                        <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${tunnelName}</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button id="btn-fetch-cloud" class="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold rounded-lg transition-all flex items-center gap-2" title="Cloud -> App: Overwrite local config with remote settings">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                        Fetch
                    </button>
                    <button id="btn-push-cloud" class="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold rounded-lg transition-all flex items-center gap-2" title="App -> Cloud: Update dashboard with local ingress rules">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                        Push
                    </button>
                    <button id="btn-add-endpoint-trigger" class="px-3 py-1.5 bg-devops-accent text-white text-[10px] font-bold rounded-lg hover:bg-blue-600 transition-all flex items-center gap-2 ml-1">
                        + Add 
                    </button>
                    <button id="modal-close" class="p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </div>
            <div id="endpoints-list-container" class="flex-1 overflow-auto p-2">
                <!-- List injected here -->
            </div>
            <div id="sync-status" class="hidden px-6 py-2 bg-blue-500/10 border-t border-devops-border">
               <p class="text-[9px] text-blue-400 animate-pulse font-bold uppercase tracking-widest">🔄 Synchronizing with Cloudflare...</p>
            </div>
            <div class="p-4 bg-devops-dark/30 border-t border-devops-border">
                <p class="text-[9px] text-slate-500 italic text-center">
                    Endpoints sync with local <span class="text-slate-400 font-mono">config.yml</span>. Manual changes on Cloudflare dashboard require "Sync".
                </p>
            </div>
        </div>
    `;

  document.body.appendChild(modal);

  const container = document.getElementById('endpoints-list-container');
  const syncBtn = document.getElementById('btn-sync-cloud');
  const syncStatus = document.getElementById('sync-status');

  const refreshList = async () => {
    container.innerHTML = `
      <div class="flex items-center justify-center py-20">
          <div class="flex flex-col items-center gap-4">
              <div class="w-8 h-8 border-3 border-devops-accent border-t-transparent rounded-full animate-spin"></div>
              <span class="text-xs font-bold text-slate-500 uppercase tracking-widest animate-pulse">Reading config.yml...</span>
          </div>
      </div>
    `;

    try {
      const endpoints = await api.getTunnelEndpoints(tunnel.config_file);
      if (!endpoints || endpoints.length === 0) {
        container.innerHTML = `
              <div class="flex flex-col items-center justify-center py-16 text-center">
                  <div class="w-16 h-16 bg-slate-800/50 rounded-full flex items-center justify-center text-slate-600 mb-4">
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.826L10.242 9.172a4 4 0 015.656 0l4 4a4 4 0 11-5.656 5.656l-1.103-1.103" />
                      </svg>
                  </div>
                  <h4 class="text-sm font-bold text-slate-400">No Endpoints Configured</h4>
                  <p class="text-[10px] text-slate-500 mt-1 max-w-xs px-6">This tunnel doesn't have any ingress rules in its local config yet. Click "Add Endpoint" to register a hostname.</p>
              </div>
          `;
        return;
      }

      container.innerHTML = `
          <div class="p-2">
              <table class="w-full text-left border-separate border-spacing-y-2">
                  <thead>
                      <tr class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                          <th class="px-6 py-2">Hostname</th>
                          <th class="px-6 py-2">Service Mapping</th>
                          <th class="px-6 py-2 text-right">Actions</th>
                      </tr>
                  </thead>
                  <tbody>
                      ${endpoints.map((ep) => `
                          <tr class="bg-devops-dark/40 hover:bg-slate-800 transition-colors group rounded-2xl">
                              <td class="px-6 py-4 rounded-l-2xl">
                                  <div class="flex flex-col">
                                      <span class="text-[11px] font-bold text-white group-hover:text-devops-accent transition-colors">${ep.hostname}</span>
                                      <span class="text-[9px] text-slate-500 mt-0.5">Public Hostname</span>
                                  </div>
                              </td>
                              <td class="px-6 py-4">
                                  <div class="flex items-center gap-2">
                                      <div class="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                                      <span class="text-[10px] font-mono text-slate-400">${ep.service}</span>
                                  </div>
                              </td>
                              <td class="px-6 py-4 rounded-r-2xl text-right">
                                  <div class="flex items-center justify-end gap-2">
                                      <a href="https://${ep.hostname}" target="_blank" class="p-2 bg-slate-700/30 hover:bg-devops-accent text-slate-400 hover:text-white rounded-lg transition-all" title="Open in Browser">
                                          <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                          </svg>
                                      </a>
                                      <button data-hostname="${ep.hostname}" class="btn-delete-endpoint p-2 hover:bg-red-500/20 text-slate-600 hover:text-red-500 rounded-lg transition-all" title="Delete Endpoint">
                                          <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                          </svg>
                                      </button>
                                  </div>
                              </td>
                          </tr>
                      `).join('')}
                  </tbody>
              </table>
          </div>
      `;

      // Attach delete events
      container.querySelectorAll('.btn-delete-endpoint').forEach(btn => {
        btn.onclick = (e) => handleDeleteEndpoint(e.currentTarget.dataset.hostname);
      });

    } catch (e) {
      container.innerHTML = `
          <div class="p-12 text-center text-red-400">
              <p class="font-bold uppercase tracking-widest text-[10px]">Failed to read config</p>
              <p class="text-[10px] mt-2 opacity-60">${e}</p>
          </div>
      `;
    }
  };

  const handleDeleteEndpoint = async (hostname) => {
    if (!confirm(`Are you sure you want to delete endpoint "${hostname}"?`)) return;

    try {
      await api.deleteTunnelEndpoint(tunnel.config_file, hostname);

      // Push deletion to Cloudflare dashboard
      const account = state.config.accounts.find(a => a.name === tunnel.account_tag);
      if (account) {
        try {
          await api.pushTunnelConfig(account.cert_path, tunnel.config_file);
        } catch (pushErr) {
          console.warn('Push to Cloudflare dashboard failed (non-fatal):', pushErr);
        }
      }

      // Auto-restart if running
      if (tunnel.status === 'running') {
        syncStatus.classList.remove('hidden');
        syncStatus.innerHTML = `<p class="text-[9px] text-blue-400 animate-pulse font-bold uppercase tracking-widest">🔄 Restarting tunnel to apply changes...</p>`;

        await api.stopTunnel(tunnelName);
        await new Promise(r => setTimeout(r, 1500));
        await api.startTunnel(tunnelName, tunnel.token || '');
        tunnel.status = 'running';

        syncStatus.classList.add('hidden');
      }

      refreshList();
    } catch (err) {
      alert('Delete failed: ' + err);
    }
  };

  const fetchBtn = document.getElementById('btn-fetch-cloud');
  const pushBtn = document.getElementById('btn-push-cloud');

  const handleFetch = async () => {
    const account = state.config.accounts.find(a => a.name === tunnel.account_tag);
    if (!account) {
      alert('Account not found for this tunnel. Cannot fetch.');
      return;
    }

    fetchBtn.disabled = true;
    pushBtn.disabled = true;
    syncStatus.classList.remove('hidden');
    syncStatus.innerHTML = `<p class="text-[9px] text-blue-400 animate-pulse font-bold uppercase tracking-widest">🔄 Fetching from Cloudflare...</p>`;

    try {
      await api.syncTunnelEndpoints(account.cert_path, tunnel.id || null, tunnel.config_file);

      // Auto-restart if running
      if (tunnel.status === 'running') {
        syncStatus.innerHTML = `<p class="text-[9px] text-blue-400 animate-pulse font-bold uppercase tracking-widest">🔄 Fetch successful! Restarting tunnel...</p>`;
        await api.stopTunnel(tunnelName);
        await new Promise(r => setTimeout(r, 1500));
        await api.startTunnel(tunnelName, tunnel.token || '');
      }

      syncStatus.classList.add('hidden');
      refreshList();
    } catch (err) {
      alert('Fetch failed: ' + err);
      syncStatus.classList.add('hidden');
    } finally {
      fetchBtn.disabled = false;
      pushBtn.disabled = false;
    }
  };

  const handlePush = async () => {
    const account = state.config.accounts.find(a => a.name === tunnel.account_tag);
    if (!account) {
      alert('Account not found for this tunnel. Cannot push.');
      return;
    }

    fetchBtn.disabled = true;
    pushBtn.disabled = true;
    syncStatus.classList.remove('hidden');
    syncStatus.innerHTML = `<p class="text-[9px] text-blue-400 animate-pulse font-bold uppercase tracking-widest">🔼 Pushing to Cloudflare...</p>`;

    try {
      await api.pushTunnelConfig(account.cert_path, tunnel.config_file);
      syncStatus.innerHTML = `<p class="text-[9px] text-emerald-400 font-bold uppercase tracking-widest">✅ Dashboard updated successfully!</p>`;
      setTimeout(() => syncStatus.classList.add('hidden'), 2000);
    } catch (err) {
      alert('Push failed: ' + err);
      syncStatus.classList.add('hidden');
    } finally {
      fetchBtn.disabled = false;
      pushBtn.disabled = false;
    }
  };

  document.getElementById('modal-close').onclick = () => modal.remove();
  document.getElementById('btn-add-endpoint-trigger').onclick = () => {
    modal.remove();
    showAddEndpointModal(tunnelName, tunnel.account_tag);
  };
  fetchBtn.onclick = handleFetch;
  pushBtn.onclick = handlePush;

  refreshList();
};

window.showDeleteTunnelModal = (name) => {
  const tunnel = state.config.tunnels.find(t => t.name === name);
  if (!tunnel) return;

  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4';

  const renderRunningWarning = () => {
    modal.innerHTML = `
      <div class="bg-devops-card w-full max-w-sm rounded-3xl border border-yellow-500/20 shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
          <div class="p-6 text-center">
              <div class="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center text-yellow-500 mx-auto mb-4 border border-yellow-500/20">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
              </div>
              <h3 class="text-lg font-bold text-white">Tunnel is Running</h3>
              <p class="text-xs text-slate-400 mt-2">You cannot delete <span class="text-white font-bold">"${name}"</span> while it is active.</p>
              <div class="mt-4 p-3 bg-yellow-500/5 border border-yellow-500/10 rounded-xl text-left">
                  <p class="text-[10px] text-slate-400 leading-relaxed">Please <span class="text-white font-bold">Stop</span> the tunnel first from the list before attempt to delete it.</p>
              </div>
          </div>
          <div class="p-4 bg-devops-dark/50">
              <button id="btn-close-warn" class="w-full py-3 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded-xl transition-all">Got it</button>
          </div>
      </div>
    `;
    modal.querySelector('#btn-close-warn').onclick = () => modal.remove();
  };

  const renderInitial = () => {
    if (tunnel.status === 'running') {
      renderRunningWarning();
      return;
    }
    modal.innerHTML = `
      <div class="bg-devops-card w-full max-w-sm rounded-3xl border border-red-500/20 shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
          <div class="p-6 text-center">
              <div class="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center text-red-500 mx-auto mb-4 border border-red-500/20">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
              </div>
              <h3 class="text-lg font-bold text-white">Delete Tunnel?</h3>
              <p class="text-xs text-slate-400 mt-2">Are you sure you want to remove <span class="text-white font-bold">"${name}"</span>?</p>
              
              ${tunnel.account_tag ? `
                <div class="mt-4 p-3 bg-red-500/5 border border-red-500/10 rounded-xl text-left">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
                        <p class="text-[10px] font-bold text-red-400 uppercase tracking-widest">Cloudflare Sync</p>
                    </div>
                    <p class="text-[10px] text-slate-400 leading-relaxed">This tunnel was created via <span class="text-white">${tunnel.account_tag}</span>. It will also be <span class="text-white border-b border-red-500/50">permanently deleted</span> from your Cloudflare account.</p>
                </div>
              ` : ''}
          </div>
          <div class="p-4 bg-devops-dark/50 flex gap-3">
              <button id="btn-cancel" class="flex-1 py-3 text-xs font-bold text-slate-400 hover:text-white transition-colors">Cancel</button>
              <button id="btn-confirm" class="flex-[2] py-3 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-xl transition-all shadow-lg shadow-red-600/10">Delete Permanently</button>
          </div>
      </div>
    `;

    modal.querySelector('#btn-cancel').onclick = () => modal.remove();
    modal.querySelector('#btn-confirm').onclick = () => handleDelete();
  };

  const renderProgress = (msg) => {
    modal.innerHTML = `
      <div class="bg-devops-card w-full max-w-sm rounded-3xl border border-devops-border shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
          <div class="p-12 text-center space-y-6">
              <div class="w-12 h-12 border-3 border-red-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
              <div>
                  <h4 class="text-sm font-bold text-white uppercase tracking-widest">${msg}</h4>
                  <p class="text-[10px] text-slate-500 mt-2">Communicating with Cloudflare APIs...</p>
              </div>
          </div>
      </div>
    `;
  };

  const renderError = (err) => {
    modal.innerHTML = `
      <div class="bg-devops-card w-full max-w-sm rounded-3xl border border-red-500/20 shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
          <div class="p-8 text-center">
              <div class="w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center text-red-500 mx-auto mb-4">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
              </div>
              <h3 class="text-sm font-bold text-white">Cloudflare sync failed</h3>
              <p class="text-[10px] text-slate-400 mt-2 px-4">${err}</p>
          </div>
          <div class="p-4 bg-devops-dark/50 flex flex-col gap-2">
              <button id="btn-force" class="w-full py-3 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold rounded-xl transition-all">Delete Locally Only</button>
              <button id="btn-retry" class="w-full py-3 text-[10px] font-bold text-slate-500 hover:text-white transition-colors">Cancel</button>
          </div>
      </div>
    `;
    modal.querySelector('#btn-retry').onclick = () => modal.remove();
    modal.querySelector('#btn-force').onclick = () => finishDeletion();
  };

  const finishDeletion = async () => {
    state.config.tunnels = state.config.tunnels.filter(t => t.name !== name);
    await api.saveConfig(state.config);
    modal.remove();
    renderTunnels();
  };

  const handleDelete = async () => {
    if (tunnel.account_tag) {
      renderProgress('Synching Cloudflare...');
      try {
        await api.deleteRemoteTunnel(tunnel.account_tag, name);
        await finishDeletion();
      } catch (err) {
        renderError(err);
      }
    } else {
      await finishDeletion();
    }
  };

  document.body.appendChild(modal);
  renderInitial();
};

window.showAddEndpointModal = (tunnelName, accountName) => {
  const tunnel = state.config.tunnels.find(t => t.name === tunnelName);
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4';

  const renderForm = async () => {
    modal.innerHTML = `
      <div class="bg-devops-card w-full max-w-md rounded-3xl border border-devops-border shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
          <div class="p-6 border-b border-devops-border bg-devops-dark/20 flex justify-between items-center">
              <div class="flex items-center gap-3">
                  <div class="w-10 h-10 bg-devops-accent/10 rounded-2xl flex items-center justify-center text-devops-accent">
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                      </svg>
                  </div>
                  <div>
                      <h3 class="text-lg font-bold text-white">Full Endpoint Automation</h3>
                      <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${tunnelName}</p>
                  </div>
              </div>
              <button id="modal-close" class="text-slate-400 hover:text-white transition-colors">&times;</button>
          </div>
          <form id="endpoint-form" class="p-6 space-y-4">
              <div class="space-y-2">
                  <label class="block text-[10px] font-bold text-slate-500 uppercase">Public Hostname</label>
                  <input type="text" name="hostname" required class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors text-xs" placeholder="e.g. app.domain.com">
              </div>

              <div class="grid grid-cols-2 gap-4">
                  <div>
                      <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Protocol</label>
                      <select name="protocol" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors text-xs">
                          <option value="http">HTTP</option>
                          <option value="https">HTTPS</option>
                          <option value="tcp">TCP</option>
                          <option value="unix">Unix Socket</option>
                      </select>
                  </div>
                  <div>
                      <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Local Port</label>
                      <input type="number" name="port" value="8080" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors text-xs">
                  </div>
              </div>

              <div>
                  <label class="block text-[10px] font-bold text-slate-500 uppercase mb-2">Local Machine Host</label>
                  <input type="text" name="dest_host" value="localhost" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors text-xs">
              </div>
              
              <div class="p-4 bg-devops-accent/5 border border-devops-accent/10 rounded-2xl space-y-2">
                  <p class="text-[10px] font-bold text-devops-accent uppercase tracking-widest flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Zero-Token Strategy
                  </p>
                  <p class="text-[10px] text-slate-400 leading-relaxed italic">
                    Sistem akan otomatis mendaftarkan <span class="text-white">DNS CNAME</span> dan mengupdate <span class="text-white">Local Config</span>. No manual steps required!
                  </p>
              </div>

              <div class="pt-2 flex gap-3">
                  <button type="button" id="btn-cancel" class="flex-1 py-3 text-xs font-bold text-slate-400 hover:text-white transition-colors">Cancel</button>
                  <button type="submit" id="btn-submit-endpoint" class="flex-[2] py-3 bg-devops-accent hover:bg-blue-600 text-white text-xs font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20">Register & Configure</button>
              </div>
          </form>
      </div>
    `;

    document.getElementById('modal-close').onclick = () => modal.remove();
    document.getElementById('btn-cancel').onclick = () => modal.remove();
    document.getElementById('endpoint-form').onsubmit = handleEndpointSubmit;
  };

  const renderSuccess = (hostname, wasRestarted) => {
    modal.innerHTML = `
      <div class="bg-devops-card w-full max-w-md rounded-3xl border border-green-500/20 shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
          <div class="p-8 text-center">
              <div class="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center text-green-500 mx-auto mb-4 border border-green-500/20">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
              </div>
              <h3 class="text-lg font-bold text-white">Endpoint Successfully Set!</h3>
              <p class="text-xs text-slate-400 mt-2">Hostname <span class="text-green-500 font-mono">${hostname}</span> is now active.</p>
              
              <div class="mt-6 p-4 bg-devops-dark/50 rounded-2xl text-left space-y-3 border border-devops-border">
                  <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Automation Completed:</p>
                    <div class="text-[10px] text-slate-400 space-y-2 flex items-center gap-2">
                        <div class="w-4 h-4 bg-green-500/20 text-green-500 rounded flex items-center justify-center text-[8px] font-bold">✓</div>
                        DNS CNAME Created
                    </div>
                    <div class="text-[10px] text-slate-400 space-y-2 flex items-center gap-2">
                        <div class="w-4 h-4 bg-green-500/20 text-green-500 rounded flex items-center justify-center text-[8px] font-bold">✓</div>
                        Local Ingress Mapping Applied
                    </div>
                    ${wasRestarted ? `
                    <div class="text-[10px] text-slate-400 space-y-2 flex items-center gap-2">
                        <div class="w-4 h-4 bg-blue-500/20 text-blue-500 rounded flex items-center justify-center text-[8px] font-bold">↻</div>
                        Tunnel Auto-Restarted
                    </div>
                    ` : ''}
              </div>
          </div>
          <div class="p-4 bg-devops-dark/50">
              <button id="btn-done" class="w-full py-3 bg-devops-accent hover:bg-blue-600 text-white text-[10px] font-bold rounded-xl transition-all">Great!</button>
          </div>
      </div>
    `;
    document.getElementById('btn-done').onclick = () => modal.remove();
  };

  const handleEndpointSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const hostname = formData.get('hostname');
    const protocol = formData.get('protocol');
    const port = parseInt(formData.get('port'));
    const destHost = formData.get('dest_host');

    const submitBtn = document.getElementById('btn-submit-endpoint');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Automating...';

    try {
      // 1. Always create DNS Route via CLI (Zero-token)
      await api.addTunnelDnsRoute(accountName, tunnelName, hostname);

      // 2. Update local config.yml (Zero-token)
      if (tunnel.config_file) {
        submitBtn.textContent = 'Updating Local Config...';
        await api.updateLocalTunnelIngress(
          tunnel.config_file,
          hostname,
          protocol,
          destHost,
          port
        );

        // 3. Push config to Cloudflare dashboard
        const account = state.config.accounts.find(a => a.name === accountName);
        if (account) {
          submitBtn.textContent = 'Syncing to Cloudflare...';
          try {
            await api.pushTunnelConfig(account.cert_path, tunnel.config_file);
          } catch (pushErr) {
            console.warn('Push to Cloudflare dashboard failed (non-fatal):', pushErr);
          }
        }
      }

      // 3. Auto-restart tunnel if running so new config is picked up
      let wasRestarted = false;
      if (tunnel.status === 'running') {
        submitBtn.textContent = 'Restarting Tunnel...';
        try {
          await api.stopTunnel(tunnelName);
          // Small delay to let the process fully stop
          await new Promise(resolve => setTimeout(resolve, 1500));
          await api.startTunnel(tunnelName, tunnel.token || '');
          tunnel.status = 'running';
          wasRestarted = true;
        } catch (restartErr) {
          console.warn('Auto-restart failed:', restartErr);
          // Don't fail the whole operation, endpoint was still added
        }
      }

      renderSuccess(hostname, wasRestarted);
    } catch (err) {
      alert('Action failed: ' + err);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Register & Configure';
    }
  };

  document.body.appendChild(modal);
  renderForm();
};

function showAddTunnelModal() {
  const accounts = state.config.accounts || [];
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
  modal.innerHTML = `
        <div class="bg-devops-card w-full max-w-md rounded-2xl border border-devops-border shadow-2xl animate-in zoom-in-95 duration-200">
            <div class="p-6 border-b border-devops-border flex justify-between items-center">
                <h3 class="text-lg font-bold text-white">New Cloudflare Tunnel</h3>
                <button id="modal-close" class="text-slate-400 hover:text-white">&times;</button>
            </div>
            
            <div class="flex border-b border-devops-border bg-devops-dark/30">
                <button id="tab-manual" class="flex-1 py-3 text-xs font-bold uppercase tracking-wider text-slate-400 border-b-2 border-transparent transition-all">Manual Token</button>
                <button id="tab-account" class="flex-1 py-3 text-xs font-bold uppercase tracking-wider text-slate-400 border-b-2 border-transparent transition-all">Via Account</button>
            </div>

            <div id="form-container" class="p-6">
                <!-- Forms injected here -->
            </div>
        </div>
    `;

  document.body.appendChild(modal);

  const container = document.getElementById('form-container');
  const tabManual = document.getElementById('tab-manual');
  const tabAccount = document.getElementById('tab-account');

  const showManualForm = () => {
    tabManual.className = 'flex-1 py-3 text-xs font-bold uppercase tracking-wider text-white border-b-2 border-devops-accent transition-all';
    tabAccount.className = 'flex-1 py-3 text-xs font-bold uppercase tracking-wider text-slate-500 border-b-2 border-transparent transition-all hover:text-slate-300';

    container.innerHTML = `
      <form id="add-tunnel-form-manual" class="space-y-4">
          <div>
              <label class="block text-xs font-bold text-slate-400 uppercase mb-2">Tunnel Name</label>
              <input type="text" name="name" required class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors" placeholder="e.g. Home Server">
          </div>
          <div>
              <label class="block text-xs font-bold text-slate-400 uppercase mb-2">Cloudflare Token</label>
              <textarea name="token" required rows="4" class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors font-mono text-xs" placeholder="Paste your tunnel token here..."></textarea>
          </div>
          <div class="pt-4">
              <button type="submit" class="w-full bg-devops-accent text-white font-bold py-3 rounded-xl hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20">
                  Add Existing Tunnel
              </button>
          </div>
      </form>
    `;

    document.getElementById('add-tunnel-form-manual').onsubmit = handleManualSubmit;
  };

  const showAccountForm = () => {
    tabAccount.className = 'flex-1 py-3 text-xs font-bold uppercase tracking-wider text-white border-b-2 border-devops-accent transition-all';
    tabManual.className = 'flex-1 py-3 text-xs font-bold uppercase tracking-wider text-slate-500 border-b-2 border-transparent transition-all hover:text-slate-300';

    if (accounts.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 space-y-4">
            <p class="text-sm text-slate-400 italic">No logged-in accounts found.</p>
            <button onclick="renderView('accounts'); document.getElementById('modal-close').click();" class="text-xs font-bold text-devops-accent hover:underline">Go to Cloudflare Accounts to login &rarr;</button>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <form id="add-tunnel-form-account" class="space-y-4">
          <div>
              <label class="block text-xs font-bold text-slate-400 uppercase mb-2">Select Account</label>
              <select name="account" required class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none appearance-none">
                  ${accounts.map(acc => `<option value="${acc.name}">${acc.name}</option>`).join('')}
              </select>
          </div>
          <div>
              <label class="block text-xs font-bold text-slate-400 uppercase mb-2">New Tunnel Name</label>
              <input type="text" name="name" required class="w-full bg-devops-dark border border-devops-border rounded-xl px-4 py-3 text-white focus:outline-none focus:border-devops-accent transition-colors" placeholder="e.g. My Website Tunnel">
          </div>
          <div class="p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl">
            <p class="text-[10px] text-slate-400 italic">This will create a new tunnel on your Cloudflare account and automatically fetch the token.</p>
          </div>
          <div class="pt-4">
              <button type="submit" id="btn-create-auto" class="w-full bg-devops-accent text-white font-bold py-3 rounded-xl hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20">
                  Create Tunnel Instantly
              </button>
          </div>
      </form>
    `;

    document.getElementById('add-tunnel-form-account').onsubmit = handleAccountSubmit;
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const name = formData.get('name');
    const token = formData.get('token');

    if (state.config.tunnels.some(t => t.name === name)) {
      alert('A tunnel with this name already exists.');
      return;
    }

    state.config.tunnels.push({ name, token, status: 'stopped' });
    await api.saveConfig(state.config);
    modal.remove();
    renderTunnels();
  };

  const handleAccountSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const accountName = formData.get('account');
    const tunnelName = formData.get('name');
    const submitBtn = document.getElementById('btn-create-auto');

    if (state.config.tunnels.some(t => t.name === tunnelName)) {
      alert('A tunnel with this name already exists in your local list.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating on Cloudflare...';

    try {
      const rawData = await api.createTunnelViaAccount(accountName, tunnelName);
      const data = JSON.parse(rawData);
      state.config.tunnels.push({
        name: data.name,
        id: data.id,
        token: '', // No longer using token for account tunnels
        status: 'stopped',
        account_tag: accountName,
        config_file: data.config_file,
        creds_file: data.creds_file
      });
      await api.saveConfig(state.config);
      modal.remove();
      renderTunnels();
    } catch (err) {
      alert('Failed to create tunnel: ' + err);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Tunnel Instantly';
    }
  };

  tabManual.onclick = showManualForm;
  tabAccount.onclick = showAccountForm;

  document.getElementById('modal-close').onclick = () => modal.remove();

  // Default to Manual if no accounts, otherwise Account might be cooler
  if (accounts.length > 0) {
    showAccountForm();
  } else {
    showManualForm();
  }
}

function renderLogs() {
  els.content.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 h-full min-h-[500px]">
            <div class="bg-devops-card rounded-2xl border border-devops-border overflow-hidden flex flex-col">
                <div class="p-4 border-b border-devops-border bg-devops-dark/50">
                    <h4 class="text-xs font-bold text-slate-400 uppercase">Source</h4>
                </div>
                <div class="flex-1 overflow-y-auto p-2 space-y-1" id="log-tunnels-list">
                    <!-- List injected by renderLogSourceList -->
                </div>
            </div>
            <div class="md:col-span-3 bg-devops-dark rounded-2xl border border-devops-border flex flex-col overflow-hidden">
                <div class="p-4 border-b border-devops-border bg-devops-card flex justify-between items-center">
                    <h4 class="text-xs font-bold text-white uppercase" id="selected-source-name">Terminal</h4>
                    <button onclick="clearLogs()" class="text-[10px] font-bold text-slate-500 hover:text-white uppercase">Clear Board</button>
                </div>
                <div id="log-board" class="flex-1 p-6 font-mono text-[11px] leading-relaxed overflow-y-auto space-y-1 text-slate-400">
                    <p class="text-slate-600">-- Select a tunnel to view logs --</p>
                </div>
            </div>
        </div>
    `;

  if (state.selectedLogSource) {
    selectLogSource(state.selectedLogSource);
  } else {
    renderLogSourceList();
  }
}

window.selectLogSource = (name) => {
  state.selectedLogSource = name;
  renderLogSourceList();

  document.getElementById('selected-source-name').textContent = `Tunnel: ${name}`;
  const board = document.getElementById('log-board');
  board.innerHTML = (state.logs[name] || []).map(msg => `<div>${msg}</div>`).join('') || '<p class="text-slate-600">-- No logs captured yet --</p>';
  board.scrollTop = board.scrollHeight;
};

function renderLogSourceList() {
  const list = document.getElementById('log-tunnels-list');
  if (!list) return;

  list.innerHTML = `
    <p class="text-[9px] font-bold text-slate-600 uppercase px-3 py-1 mt-2">Standard</p>
    ${state.config.tunnels.map(t => `
        <button onclick="selectLogSource('${t.name}')" class="log-source-btn w-full text-left px-4 py-2 rounded-xl text-sm font-medium transition-colors ${state.selectedLogSource === t.name ? 'bg-devops-accent text-white' : 'text-slate-400 hover:bg-slate-800'}">
            ${t.name}
        </button>
    `).join('')}
    <p class="text-[9px] font-bold text-slate-600 uppercase px-3 py-1 mt-4">Quick Tunnels</p>
    ${(state.config.quick_tunnels || []).map(t => `
        <button onclick="selectLogSource('${t.name}')" class="log-source-btn w-full text-left px-4 py-2 rounded-xl text-sm font-medium transition-colors ${state.selectedLogSource === t.name ? 'bg-yellow-500 text-black' : 'text-slate-400 hover:bg-slate-800'}">
            ${t.name}
        </button>
    `).join('')}
  `;
}

window.clearLogs = () => {
  if (state.selectedLogSource) {
    state.logs[state.selectedLogSource] = [];
    document.getElementById('log-board').innerHTML = '<p class="text-slate-600">-- Logs cleared --</p>';
  }
};

function updateLogDisplay(name, message) {
  if (state.selectedLogSource === name) {
    const board = document.getElementById('log-board');
    const div = document.createElement('div');
    div.textContent = message;
    board.appendChild(div);
    board.scrollTop = board.scrollHeight;
  }
}

function renderSettings() {
  els.content.innerHTML = `
        <div class="max-w-2xl animate-in slide-in-from-left-4 duration-500">
            <h3 class="text-xl font-bold text-white mb-6">Application Settings</h3>
            
            <div class="space-y-6">
                <div class="bg-devops-card p-6 rounded-2xl border border-devops-border">
                    <label class="block text-xs font-bold text-slate-400 uppercase mb-3">Binary Location</label>
                    <div class="flex gap-2">
                        <input type="text" id="setting-binary-path" class="flex-1 bg-devops-dark border border-devops-border rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-devops-accent" placeholder="Default App Path" value="${state.config.cloudflared_path}">
                        <button onclick="saveSettings()" class="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded-xl transition-colors">Apply</button>
                    </div>
                    <p class="mt-2 text-[10px] text-slate-500 italic">Leave empty to use the auto-downloaded binary in AppData.</p>
                </div>

                <div class="bg-devops-card p-6 rounded-2xl border border-devops-border flex items-center justify-between">
                    <div>
                        <p class="text-sm font-semibold text-white">Auto-start Tunnels</p>
                        <p class="text-xs text-slate-400">Restart tunnels when the application opens</p>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" id="setting-autostart" class="sr-only peer" ${state.config.auto_start ? 'checked' : ''} onchange="saveSettings()">
                        <div class="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-devops-accent"></div>
                    </label>
                </div>
            </div>
        </div>
    `;
}

window.saveSettings = async () => {
  state.config.cloudflared_path = document.getElementById('setting-binary-path')?.value || '';
  state.config.auto_start = document.getElementById('setting-autostart')?.checked || false;
  await api.saveConfig(state.config);
  // Optionally show a toast
};

// Helpers
function formatBytes(bytes) {
  if (bytes === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatLatency(ms) {
  if (ms === 0) return '-- ms';
  return ms.toFixed(1) + ' ms';
}

function updateDashboardMetrics() {
  let totalIn = 0;
  let totalOut = 0;
  for (const identifier in state.metrics) {
    const m = state.metrics[identifier];
    const tunnel = state.config.tunnels.find(t => t.name === identifier);
    const qt = (state.config.quick_tunnels || []).find(t => t.id === identifier);

    const isActive = (tunnel && tunnel.status === 'running') ||
      (qt && (qt.status === 'running' || qt.status === 'starting')) ||
      m.status === 'connected';

    if (isActive) {
      totalIn += m.bandwidth_in;
      totalOut += m.bandwidth_out;
    }
  }
  const inEl = document.getElementById('dash-total-in');
  const outEl = document.getElementById('dash-total-out');
  if (inEl) inEl.textContent = formatBytes(totalIn);
  if (outEl) outEl.textContent = formatBytes(totalOut);
}

function updateQuickTunnelRow(metrics) {
  const qt = (state.config.quick_tunnels || []).find(t => t.id === metrics.tunnel_name);
  if (!qt) return;

  // Update status in state if connected
  if (metrics.status === 'connected') {
    qt.status = 'running';
  }

  // Update DOM elements if present
  const statusEl = document.getElementById(`qt-status-${metrics.tunnel_name}`);
  const latencyEl = document.getElementById(`qt-metrics-latency-${metrics.tunnel_name}`);
  const bandwidthEl = document.getElementById(`qt-metrics-bandwidth-${metrics.tunnel_name}`);

  if (statusEl) {
    statusEl.textContent = metrics.status.toUpperCase();
    statusEl.className = `px-2 py-1 ${metrics.status === 'connected' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'} text-[10px] font-bold rounded-full border`;
  }

  if (latencyEl) latencyEl.textContent = formatLatency(metrics.latency_ms);
  if (bandwidthEl) {
    bandwidthEl.innerHTML = `
      <span class="text-blue-400/80">↓${formatBytes(metrics.bandwidth_in)}</span>
      <span class="text-purple-400/80">↑${formatBytes(metrics.bandwidth_out)}</span>
    `;
  }

  if (metrics.status === 'connected' && state.currentView === 'quick_tunnels' && !qt.public_url) {
    // Re-render table if we just got connected to ensure URL is shown
    renderQuickTunnels();
  }
}

function updateTunnelRow(metrics) {
  const latencyEl = document.getElementById(`metrics-latency-${metrics.tunnel_name}`);
  const bandwidthEl = document.getElementById(`metrics-bandwidth-${metrics.tunnel_name}`);
  const statusEl = document.getElementById(`metrics-status-${metrics.tunnel_name}`);

  if (latencyEl) latencyEl.textContent = formatLatency(metrics.latency_ms);
  if (bandwidthEl) {
    bandwidthEl.innerHTML = `
            <span class="text-blue-400">↓ ${formatBytes(metrics.bandwidth_in)}</span>
            <span class="text-purple-400">↑ ${formatBytes(metrics.bandwidth_out)}</span>
        `;
  }
  if (statusEl) {
    statusEl.textContent = metrics.status.toUpperCase();
    statusEl.className = `px-2 py-1 ${metrics.status === 'connected' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'} text-[10px] font-bold rounded-full border`;
  }
}

// Start
init();
