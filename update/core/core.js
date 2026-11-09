const { app, BrowserWindow, Menu, shell, ipcMain, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { createProxyManager } = require('./proxy');
const { CORE_FILES, sha256: coreSha, verifyCoreManifest } = require(path.join(app.getAppPath(), 'lib-sign.js'));

// ============ CONFIGURE AQUI ============
// Endereço (https) da pasta onde ficam version.json e index.html das atualizações.
// Deixe vazio para desligar o aviso de atualização.
const UPDATE_URL = 'https://raw.githubusercontent.com/haehaez/lywall/main/update/';
// ========================================

// Mantém a pasta de dados antiga (presets, sessão, cache) mesmo com o nome novo do app,
// para você não perder nada ao trocar de "Parede de vídeos" para "LY(wall)".
(function pinUserData() {
  try {
    const base = app.getPath('appData');
    for (const n of ['Parede de vídeos', 'parede-de-videos', 'ParedeDeVideos']) {
      const p = path.join(base, n);
      if (['Local Storage', 'content', 'ly.log', 'proxies'].some((f) => fs.existsSync(path.join(p, f)))) { app.setPath('userData', p); return; }
    }
  } catch {}
})();

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) app.quit();

const bundledDir = path.join(app.getAppPath(), 'app');
const dataPath = (n) => path.join(app.getPath('userData'), n);
const userDir = () => dataPath('content');

// ---------- utilidades ----------
function log(msg) {
  try {
    const f = dataPath('ly.log');
    let old = '';
    try { old = fs.readFileSync(f, 'utf8'); } catch {}
    if (old.length > 200000) old = old.slice(-100000);
    fs.writeFileSync(f, old + new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
};
const readInfo = (dir) => readJSON(path.join(dir, 'version.json')) || {};
const readVer = (dir) => readInfo(dir).version || null;
const blockedVersion = () => (readJSON(dataPath('blocked.json')) || {}).version || null;

// ---------- assinatura das atualizações ----------
// Se existir o arquivo update-public.pem (criado por "npm run keygen"), só são
// aceitas atualizações assinadas com a chave privada correspondente.
const publicKey = (() => {
  try { return crypto.createPublicKey(fs.readFileSync(path.join(app.getAppPath(), 'update-public.pem'))); } catch { return null; }
})();
const sigMessage = (i) => `${i.version}\n${i.sha256}\n${i.releasedAt || ''}\n${i.file || 'index.html'}`;
function sigOk(i) {
  if (!publicKey) return false; // sem chave embutida: NENHUMA atualização é aceita
  try { return !!i.sha256 && !!i.sig && crypto.verify(null, Buffer.from(sigMessage(i)), publicKey, Buffer.from(String(i.sig), 'base64')); }
  catch { return false; }
}

// ---------- política de segurança da página (CSP) ----------
// Só a versão desktop recebe a política; o site publicado continua intacto.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: file:; media-src data: blob: file:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
let currentDir = bundledDir;
function loadApp(dir) {
  currentDir = dir;
  let file = path.join(dir, 'index.html');
  try {
    const html = fs.readFileSync(file, 'utf8');
    if (!/Content-Security-Policy/i.test(html)) {
      const out = dataPath('run');
      fs.mkdirSync(out, { recursive: true });
      const f = path.join(out, 'index.html');
      fs.writeFileSync(f, html.replace(/<head[^>]*>/i, (m) => m + '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'));
      file = f;
    }
  } catch (e) { log('CSP: página carregada sem política (' + e.message + ')'); }
  win.loadFile(file);
}

// usa a versão baixada se for mais nova que a que veio dentro do .exe
function activeDir() {
  const u = userDir(), uv = readVer(u), bv = readVer(bundledDir) || '0';
  if (uv && fs.existsSync(path.join(u, 'index.html')) && cmp(uv, bv) > 0) return u;
  return bundledDir;
}

let win, pending = null, loadedAt = 0, proxies = null, lastInvalid = null;
const base = () => (UPDATE_URL.endsWith('/') ? UPDATE_URL : UPDATE_URL + '/');
const updatesOn = () => /^https:\/\//i.test(UPDATE_URL);

// ---------- atualização da página ----------
let pendingCore = null;
const coreBase = () => base() + 'core/';
const installedCoreVersion = () => {
  try { return JSON.parse(fs.readFileSync(path.join(UD_(), 'core-remote', 'manifest.json'), 'utf8')).version; }
  catch { return require(path.join(app.getAppPath(), 'package.json')).version; }
};
function UD_() { return app.getPath('userData'); }
async function checkCore() {
  pendingCore = null;
  if (!updatesOn() || !publicKey) return null;
  try {
    const r = await fetch(coreBase() + 'manifest.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    const m = await r.json();
    if (verifyCoreManifest(m, publicKey)) { log('programa publicado recusado: assinatura inválida'); return null; }
    if (cmp(m.version, installedCoreVersion()) <= 0) return null;
    const bl = (() => { try { const a = JSON.parse(fs.readFileSync(path.join(UD_(), 'blocked-core.json'), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } })();
    if (bl.includes(m.version)) return null;
    pendingCore = m;
    return m.version;
  } catch { return null; }
}
async function applyCoreUpdate() {
  const m = pendingCore;
  if (!m) return;
  const stage = path.join(UD_(), 'core-staging');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const name of CORE_FILES) {
    const r = await fetch(coreBase() + name + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' em ' + name);
    const buf = Buffer.from(await r.arrayBuffer());
    if (coreSha(buf) !== m.files[name]) throw new Error('hash de ' + name + ' não confere');
    fs.writeFileSync(path.join(stage, name), buf);
  }
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(m, null, 2));
  const cur = path.join(UD_(), 'core-remote'), prev = path.join(UD_(), 'core-prev');
  fs.rmSync(prev, { recursive: true, force: true });
  if (fs.existsSync(cur)) fs.renameSync(cur, prev);
  fs.renameSync(stage, cur);
  log('programa ' + m.version + ' preparado: vale ao reabrir o app');
  pendingCore = null;
}
async function checkUpdate() {
  let p; try { p = await checkPage(); } catch (e) { log('checagem da página falhou: ' + (e && e.message)); throw e; }
  const cv = await checkCore();
  if (cv && !p.available) return { available: true, version: 'programa ' + cv, current: p.current, notes: 'Atualização do programa. Será aplicada ao reabrir o app.', core: cv };
  if (cv) p.core = cv;
  return p;
}
async function checkPage() {
  const cur = readVer(activeDir()) || '0';
  if (!updatesOn()) return { available: false, current: cur };
  const r = await fetch(base() + 'version.json?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const info = await r.json();
  if (!sigOk(info)) {
    log('atualização ignorada: assinatura ausente ou inválida (versão ' + (info.version || '?') + ')');
    pending = null;
    // avisa a janela: a versão publicada existe mas não pode ser aceita
    try { if (win && !win.isDestroyed() && info.version !== lastInvalid) { lastInvalid = info.version; win.webContents.send('update:invalid', { version: String(info.version || '?'), current: cur }); } } catch {}
    return { available: false, current: cur, invalid: true };
  }
  const bl = blockedVersion(), floor = readVer(bundledDir) || '0';
  if (info.version && cmp(info.version, floor) < 0) { pending = null; log('atualização recusada: versão ' + info.version + ' é mais antiga que a do .exe'); return { available: false, current: cur }; }
  if (info.version && cmp(info.version, floor) === 0) { pending = null; return { available: false, current: cur }; } // mesma versão do .exe: está em dia, sem aviso
  if (info.version && cmp(info.version, cur) > 0 && !(bl && cmp(info.version, bl) <= 0)) {
    pending = info;
    return { available: true, version: info.version, current: cur, notes: String(info.notes || '').slice(0, 600) };
  }
  pending = null;
  return { available: false, current: cur };
}

async function applyUpdate() {
  if (pendingCore) {
    try { await applyCoreUpdate(); }
    catch (e) { log('programa: falha ao preparar: ' + (e && e.message)); return { ok: false, error: 'Falha ao preparar o programa: ' + (e && e.message) }; }
    if (!pending && !(await checkPage().then((x) => x.available).catch(() => false))) return { ok: true, core: true };
  }
  // até 2 tentativas: se a 1ª falhar (ex.: saiu uma versão mais nova no meio do caminho),
  // o app confere o GitHub de novo, atualiza o aviso e tenta mais uma vez
  let lastErr = 'Falha desconhecida.';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      if (!pending || attempt > 0) { const c = await checkUpdate(); if (!c.available) return { ok: false, error: c.invalid ? 'Atualização sem assinatura válida.' : 'Nenhuma atualização disponível.' }; }
      const r = await fetch(base() + (pending.file || 'index.html') + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!sigOk(pending)) { lastErr = 'Assinatura inválida na hora de aplicar.'; log('atualização ' + pending.version + ' recusada: assinatura não confere na aplicação'); break; }
      if (!pending.sha256) { lastErr = 'Atualização sem hash.'; break; }
      if (pending.sha256) {
        const h = crypto.createHash('sha256').update(buf).digest('hex');
        if (h.toLowerCase() !== String(pending.sha256).toLowerCase()) { lastErr = 'Arquivo corrompido (hash não confere).'; log('atualização ' + pending.version + ': ' + lastErr + (attempt === 0 ? ' Conferindo de novo...' : '')); continue; }
      }
      if (buf.length < 1000 || !buf.toString('utf8', 0, 4000).toLowerCase().includes('<html')) { lastErr = 'Arquivo inválido.'; break; }
      const dir = userDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html.tmp'), buf);
      fs.renameSync(path.join(dir, 'index.html.tmp'), path.join(dir, 'index.html'));
      fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({
        version: pending.version,
        releasedAt: pending.releasedAt || new Date().toISOString(),
        notes: String(pending.notes || '').slice(0, 600),
      }));
      log('atualização aplicada: ' + pending.version + (attempt ? ' (na 2ª tentativa)' : ''));
      pending = null;
      loadApp(dir);
      return { ok: true };
    } catch (e) {
      lastErr = String(e && e.message || e);
      log('falha ao atualizar (tentativa ' + (attempt + 1) + '): ' + lastErr);
    }
  }
  log('atualização recusada: ' + lastErr);
  return { ok: false, error: lastErr };
}

// ---------- rede de segurança ----------
// Se a página baixada não abrir, volta para a que veio dentro do .exe e
// marca aquela versão como ruim para não baixá-la de novo.
const onUserContent = () => currentDir === userDir();
function rollback(reason) {
  const dir = userDir(), v = readVer(dir);
  log('rollback da versão ' + v + ': ' + reason);
  try {
    if (v) fs.writeFileSync(dataPath('blocked.json'), JSON.stringify({ version: v, reason, at: new Date().toISOString() }));
    const bad = dir + '.bad';
    fs.rmSync(bad, { recursive: true, force: true });
    fs.renameSync(dir, bad);
  } catch (e) {
    log('falha ao isolar a versão ruim: ' + e.message);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  if (win && !win.isDestroyed()) loadApp(bundledDir);
}

// ---------- tamanho e posição da janela ----------
function loadState() {
  const s = readJSON(dataPath('window-state.json')) || {};
  const clamp = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, +n)) : d);
  const st = { width: clamp(s.width, 640, 10000, 1400), height: clamp(s.height, 400, 10000, 860), maximized: !!s.maximized };
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x + 100 > b.x && s.x < b.x + b.width - 100 && s.y + 50 > b.y && s.y < b.y + b.height - 50;
    });
    if (visible) { st.x = s.x; st.y = s.y; }
  }
  return st;
}
let saveT = 0;
function saveState() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getNormalBounds();
      fs.writeFileSync(dataPath('window-state.json'), JSON.stringify({ ...b, maximized: win.isMaximized() }));
    } catch {}
  }, 500);
}

// ---------- IPC ----------
ipcMain.handle('update:check', () => checkUpdate().catch((e) => { log('verificação de atualização falhou: ' + (e && e.message || e)); return { available: false }; }));
// reinicia sozinho para aplicar o programa novo (o carregador reabre com a versão baixada)
function scheduleRestart() {
  log('reiniciando para aplicar o programa novo');
  setTimeout(() => { try { app.relaunch(); app.exit(0); } catch (e) { log('reinício automático falhou: ' + (e && e.message)); } }, 1500);
}
ipcMain.handle('update:apply', async () => {
  const hadCore = !!pendingCore;
  const r = await applyUpdate();
  if (r && r.ok && (hadCore || r.core)) { scheduleRestart(); return { ...r, restart: true }; }
  return r;
});
ipcMain.handle('win:minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.handle('update:version', () => readVer(activeDir()) || '0');
ipcMain.handle('update:info', () => {
  const i = readInfo(activeDir());
  return { version: i.version || '0', releasedAt: i.releasedAt || null };
});

// qualidade do vídeo (cópias leves feitas com o ffmpeg)
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpg|mpeg|ts|3gp)$/i;
ipcMain.handle('proxy:start', (e, a) => {
  try {
    if (!proxies) proxies = createProxyManager(dataPath('proxies'), { log });
    const src = String(a && a.path || ''), h = Number(a && a.height), id = String(a && a.id);
    if (!path.isAbsolute(src) || !VIDEO_EXT.test(src)) return { ok: false, error: 'Arquivo inválido.' };
    if (!(h >= 144 && h <= 2160)) return { ok: false, error: 'Qualidade inválida.' };
    return proxies.start(id, src, h, (pct) => { try { e.sender.send('proxy:progress', { id, pct }); } catch {} })
      .catch((err) => ({ ok: false, error: String(err && err.message || err) }));
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
ipcMain.handle('proxy:cancel', (e, id) => (proxies ? proxies.cancel(String(id)) : false));

// ---------- janela ----------
function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width, height: st.height, x: st.x, y: st.y, minWidth: 640, minHeight: 400,
    backgroundColor: '#0e1013', title: 'LY(wall)', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    },
  });
  if (st.maximized) win.maximize();
  Menu.setApplicationMenu(null);
  loadApp(activeDir());

  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('close', () => { clearTimeout(saveT); try { fs.writeFileSync(dataPath('window-state.json'), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {} });

  win.webContents.on('did-start-loading', () => { loadedAt = Date.now(); });
  win.webContents.on('did-finish-load', async () => {
    setTimeout(() => { try { fs.rmSync(path.join(app.getPath('userData'), 'boot-pending.json'), { force: true }); } catch {} }, 8000);
    if (!onUserContent()) return;
    try {
      const ok = await win.webContents.executeJavaScript("typeof addVideo==='function'&&!!document.getElementById('bar')");
      if (!ok) rollback('a página não inicializou');
    } catch (e) { rollback('erro ao verificar a página: ' + (e && e.message)); }
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && onUserContent()) rollback('falha ao carregar (' + desc + ')');
  });
  win.webContents.on('render-process-gone', (e, d) => {
    if (onUserContent() && d && d.reason !== 'clean-exit' && d.reason !== 'killed' && Date.now() - loadedAt < 30000) rollback('a página travou (' + d.reason + ')');
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (i.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (i.control && i.key.toLowerCase() === 'r') { win.reload(); e.preventDefault(); }
  });

  // verifica ao abrir (depois de 4s) e a cada 30 minutos
  const poll = async () => {
    try {
      const r = await checkUpdate();
      if (r.available && win && !win.isDestroyed()) win.webContents.send('update:available', r);
    } catch {}
  };
  setTimeout(poll, 4000);
  setInterval(poll, 30 * 60 * 1000);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { if (proxies) proxies.cancelAll(); });
app.on('web-contents-created', (e, contents) => { contents.on('will-attach-webview', (ev) => ev.preventDefault()); });
app.whenReady().then(() => {
  // só libera o que o app usa: tela cheia e copiar texto
  const allow = new Set(['fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allow.has(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allow.has(perm));
  createWindow();
});
app.on('window-all-closed', () => app.quit());


// ===== configuração remota (features, avisos e manutenção) — assinada com a mesma chave =====
const CFG_FILE = () => path.join(UD_(), 'config-cache.json');
const cfgPub = (() => { try { return crypto.createPublicKey(fs.readFileSync(path.join(app.getAppPath(), 'update-public.pem'))); } catch { return null; } })();
function canonJSON(v) {
  if (Array.isArray(v)) return '[' + v.map(canonJSON).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonJSON(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function cfgSigOk(c) {
  if (!cfgPub || !c || typeof c.sig !== 'string') return false;
  const rest = Object.assign({}, c); delete rest.sig;
  try { return crypto.verify(null, Buffer.from(canonJSON(rest)), cfgPub, Buffer.from(c.sig, 'base64')); } catch { return false; }
}
let cfgCache = null;
try { const c0 = JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8')); if (cfgSigOk(c0)) cfgCache = c0; } catch {}
async function refreshConfig() {
  if (!updatesOn()) return;
  try {
    const r = await fetch(base() + 'config.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const c1 = JSON.parse(await r.text());
    if (!cfgSigOk(c1)) { log('configuração recusada: assinatura inválida'); return; }
    if (cfgCache && String(c1.updatedAt || '') < String(cfgCache.updatedAt || '')) return; // nunca volta para uma versão mais antiga
    const mudou = JSON.stringify(c1) !== JSON.stringify(cfgCache);
    cfgCache = c1;
    fs.writeFileSync(CFG_FILE(), JSON.stringify(c1));
    if (mudou && win && !win.isDestroyed()) win.webContents.send('cfg:changed', cfgCache);
  } catch (e) { log('configuração: ' + (e && e.message)); }
}
ipcMain.handle('cfg:get', () => cfgCache);
refreshConfig();
setInterval(refreshConfig, 30 * 60 * 1000);
