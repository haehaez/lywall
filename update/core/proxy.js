// Gera cópias mais leves (proxies) dos vídeos com o ffmpeg, uma de cada vez.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const MAX_CACHE = 3 * 1024 * 1024 * 1024; // 3 GB

function ffmpegBin() {
  if (process.env.LY_FFMPEG) return process.env.LY_FFMPEG; // usado nos testes
  // O programa pode rodar de uma pasta baixada (AppData\\...\\core-remote), onde não existe node_modules.
  // Por isso o ffmpeg-static também é procurado a partir da pasta do app instalado.
  const tries = [() => require('ffmpeg-static')];
  const from = (dir) => () => require('module').createRequire(path.join(dir, 'package.json'))('ffmpeg-static');
  try { tries.push(from(require('electron').app.getAppPath())); } catch {}
  if (process.resourcesPath) tries.push(from(path.join(process.resourcesPath, 'app.asar')));
  let p = null;
  for (const t of tries) { try { p = t(); if (p) break; } catch {} }
  if (!p) throw new Error('ffmpeg-static não encontrado');
  // dentro do .exe o binário fica em app.asar.unpacked
  return String(p).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

// testa uma vez se o encoder da placa NVIDIA (NVENC) funciona neste computador
let nvencOK = null;
function probeNvenc() {
  if (nvencOK !== null) return Promise.resolve(nvencOK);
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.3',
        '-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { windowsHide: true });
    } catch { nvencOK = false; return resolve(false); }
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 8000);
    p.on('error', () => { clearTimeout(t); nvencOK = false; resolve(false); });
    p.on('close', (c) => { clearTimeout(t); nvencOK = c === 0; resolve(nvencOK); });
  });
}

function createProxyManager(dir, opts) {
  const log = (opts && opts.log) || (() => {});
  fs.mkdirSync(dir, { recursive: true });
  const queue = [];
  let running = null;

  // limpa sobras e mantém o cache dentro do limite (apaga os mais antigos)
  try {
    const files = fs.readdirSync(dir).map((n) => {
      const p = path.join(dir, n), s = fs.statSync(p);
      return { p, n, size: s.size, t: s.mtimeMs };
    });
    files.filter((f) => f.n.endsWith('.part.mp4')).forEach((f) => fs.unlinkSync(f.p));
    let list = files.filter((f) => !f.n.endsWith('.part.mp4')).sort((a, b) => a.t - b.t);
    let total = list.reduce((a, f) => a + f.size, 0);
    while (total > MAX_CACHE && list.length) { const f = list.shift(); try { fs.unlinkSync(f.p); } catch {} total -= f.size; }
  } catch {}

  const keyOf = (src, h) => {
    const st = fs.statSync(src);
    return crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${h}`).digest('hex').slice(0, 24);
  };

  function start(id, src, height, onProgress) {
    return new Promise((resolve) => {
      let out;
      try { out = path.join(dir, `${keyOf(src, height)}_${height}.mp4`); }
      catch { return resolve({ ok: false, error: 'Arquivo não encontrado.' }); }
      if (fs.existsSync(out)) {
        try { const n = new Date(); fs.utimesSync(out, n, n); } catch {}
        return resolve({ ok: true, path: out, cached: true });
      }
      queue.push({ id, src, height, out, onProgress, resolve, cancelled: false, proc: null });
      pump();
    });
  }

  function cancel(id) {
    const qi = queue.findIndex((j) => j.id === id);
    if (qi >= 0) { const [j] = queue.splice(qi, 1); j.resolve({ ok: false, cancelled: true }); return true; }
    if (running && running.id === id) { running.cancelled = true; try { running.proc.kill(); } catch {} return true; }
    return false;
  }

  function pump() {
    if (running || !queue.length) return;
    running = queue.shift();
    run(running).finally(() => { running = null; pump(); });
  }

  async function run(job) {
    const nv = await probeNvenc();
    let r = await attempt(job, nv);
    if (!r.ok && nv && !job.cancelled && !r.cancelled) {
      log('proxy: a placa falhou, repetindo na CPU (' + (r.error || '') + ')');
      r = await attempt(job, false);
    }
    log('proxy: ' + job.height + 'p ' + (r.ok ? (r.same ? 'já era menor' : 'ok com ' + (r.encoder || '?')) : 'falhou: ' + (r.error || (r.cancelled ? 'cancelado' : '?'))));
    job.resolve(r);
  }

  function attempt(job, nv) {
    return new Promise((done) => {
      const T = job.height;
      const tmp = job.out.replace(/\.mp4$/, '.part.mp4');
      const vf = `scale=w='if(gt(iw,ih),-2,min(iw,${T}))':h='if(gt(iw,ih),min(ih,${T}),-2)',scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
      const enc = nv ? ['-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', '30', '-b:v', '0']
                     : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'];
      const args = ['-hide_banner', '-y', '-i', job.src, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
        '-vf', vf, ...enc, '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
      let proc;
      try { proc = spawn(ffmpegBin(), args, { windowsHide: true }); }
      catch (e) { return done({ ok: false, error: 'ffmpeg não encontrado.' }); }
      job.proc = proc;
      try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

      let dur = 0, errBuf = '', same = false, buf = '';
      proc.stderr.on('data', (d) => {
        errBuf = (errBuf + d.toString()).slice(-6000);
        if (!dur) { const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(errBuf); if (m) dur = +m[1] * 3600 + +m[2] * 60 + +m[3]; }
        if (!same) {
          const v = /Stream #\d+:\d+[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(errBuf);
          if (v && Math.min(+v[1], +v[2]) <= T * 1.02) { same = true; try { proc.kill(); } catch {} }
        }
      });
      proc.stdout.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
          if (m && dur > 0) { try { job.onProgress && job.onProgress(Math.min(99, Math.round((+m[1] / 1e6 / dur) * 100))); } catch {} }
        }
      });
      proc.on('error', () => done({ ok: false, error: 'Não foi possível iniciar o ffmpeg.' }));
      proc.on('close', (code) => {
        const drop = () => { try { fs.unlinkSync(tmp); } catch {} };
        if (same) { drop(); return done({ ok: true, same: true }); }
        if (job.cancelled) { drop(); return done({ ok: false, cancelled: true }); }
        if (code === 0) {
          try { fs.renameSync(tmp, job.out); done({ ok: true, path: job.out, encoder: nv ? 'NVIDIA' : 'CPU' }); }
          catch (e) { drop(); done({ ok: false, error: 'Falha ao salvar a cópia.' }); }
        } else {
          drop();
          const last = errBuf.trim().split('\n').pop() || '';
          done({ ok: false, error: 'O ffmpeg não conseguiu converter este vídeo. ' + last.slice(0, 120) });
        }
      });
    });
  }

  function cancelAll() {
    while (queue.length) { const j = queue.shift(); j.resolve({ ok: false, cancelled: true }); }
    if (running) { running.cancelled = true; try { running.proc.kill(); } catch {} }
  }

  return { start, cancel, cancelAll };
}

module.exports = { createProxyManager, ffmpegBin };
