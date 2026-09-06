const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

let controlWindow = null;
let projectionWindow = null;
let previewWindow = null;
let rcWindow = null;
let songDb = null;

// Trimite date catre fereastra de proiectie DOAR daca exista si nu a fost distrusa
// (elimina eroarea clasica Electron: "Object has been destroyed")
function sendToProjection(channel, data) {
  const targets = [];
  if (projectionWindow && !projectionWindow.isDestroyed()) targets.push(projectionWindow);
  if (previewWindow && !previewWindow.isDestroyed()) targets.push(previewWindow);
  for (const w of targets) {
    try { w.webContents.send(channel, data); } catch (e) { console.error('send', e); }
  }
  return targets.length > 0;
}

// =========================================================
// Date utilizator (cantece adaugate manual, imagini proprii)
// =========================================================
function userDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function ensureUserDir() {
  const dir = userDataPath();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --- cantece custom persistente (adăugate prin Smart Paste) ---
function loadCustomSongs() {
  try {
    const f = userDataPath('custom_songs.json');
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(data.entries) ? data.entries : [];
    }
  } catch (e) { console.error('custom_songs.json:', e); }
  return [];
}

function saveCustomSongs(list) {
  ensureUserDir();
  fs.writeFileSync(userDataPath('custom_songs.json'), JSON.stringify({ entries: list }, null, 1), 'utf8');
}

// --- media proprii (hărți / imagini adăugate de utilizator) ---
function listUserMedia() {
  const dir = userDataPath('media');
  const out = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(f)) out.push(f);
    }
  }
  return out;
}

// =========================================================
// Baza de date cantece (cantari.db)
// =========================================================
function getDatabasePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'database', 'cantari.db')
    : path.join(__dirname, 'database', 'cantari.db');
}

function openSongDb() {
  if (songDb) return songDb;
  const dbPath = getDatabasePath();
  if (!fs.existsSync(dbPath)) return null;
  try {
    songDb = new Database(dbPath, { readonly: true });
    return songDb;
  } catch (err) {
    console.error('Nu am putut deschide cantari.db:', err);
    return null;
  }
}

function foldDiacritics(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function sqlFold(col) {
  let expr = 'lower(' + col + ')';
  const pairs = [['ă', 'a'], ['â', 'a'], ['î', 'i'], ['ș', 's'], ['ş', 's'], ['ț', 't'], ['ţ', 't']];
  for (const [from, to] of pairs) expr = "replace(" + expr + ", '" + from + "', '" + to + "')";
  return expr;
}

function matchesCustom(song, q) {
  if (!q) return true;
  const f = foldDiacritics(q);
  if (foldDiacritics(song.title).includes(f)) return true;
  if (foldDiacritics(song.author || '').includes(f)) return true;
  return (song.stanzas || []).some((st) => foldDiacritics(st.text).includes(f));
}

function registerSongDbHandlers() {
  ipcMain.handle('songs-count', () => {
    const db = openSongDb();
    const dbCount = db ? db.prepare('SELECT COUNT(*) AS c FROM songs').get().c : 0;
    const custom = loadCustomSongs().length;
    return { db: !!db, count: dbCount + custom };
  });

  ipcMain.handle('songs-search', (event, rawQuery) => {
    const db = openSongDb();
    const q = foldDiacritics(rawQuery).trim();
    const songs = [];
    const seen = new Set();

    if (db) {
      if (!q) return { db: true, songs: [], total: db.prepare('SELECT COUNT(*) AS c FROM songs').get().c };
      const like = '%' + q + '%';
      try {
        const byTitle = db.prepare('SELECT id, title, author FROM songs WHERE ' + sqlFold('title') + ' LIKE ? OR ' + sqlFold('author') + ' LIKE ? ORDER BY title LIMIT 60').all(like, like);
        for (const s of byTitle) { if (!seen.has(s.id)) { seen.add(s.id); songs.push(s); } }
      } catch (e) { console.error(e); }
      if (songs.length < 60) {
        try {
          const terms = q.split(/\s+/).filter((w) => /^[a-z0-9]+$/.test(w) && w.length >= 2);
          if (terms.length) {
            const match = terms.map((t) => t + '*').join(' ');
            const byText = db.prepare('SELECT s.id, s.title, s.author FROM songs s JOIN songs_fts f ON f.rowid = s.id WHERE songs_fts MATCH ? ORDER BY rank LIMIT ?').all(match, 60 - songs.length);
            for (const s of byText) if (!seen.has(s.id)) { seen.add(s.id); songs.push(s); }
          }
        } catch (e) { console.error(e); }
      }
    }

    // cantece custom (adaugate de utilizator)
    for (const c of loadCustomSongs()) {
      if (seen.has(c.id)) continue;
      if (matchesCustom(c, q)) {
        seen.add(c.id);
        songs.push({ id: c.id, title: c.title, author: c.author || '' });
      }
      if (songs.length >= 60) break;
    }
    return { db: !!db, songs };
  });

  ipcMain.handle('songs-get', (event, id) => {
    if (id < 0) {
      const c = loadCustomSongs().find((x) => x.id === id);
      return c ? { title: c.title, author: c.author || '', stanzas: c.stanzas || [] } : null;
    }
    const db = openSongDb();
    if (!db) return null;
    const row = db.prepare('SELECT title, author, stanzas FROM songs WHERE id = ?').get(id);
    if (!row) return null;
    let stanzas = [];
    try { stanzas = JSON.parse(row.stanzas); } catch (e) { console.error(e); }
    return { title: row.title, author: row.author, stanzas };
  });

  // Smart Paste: adauga un cantec nou (persistent in userData)
  ipcMain.handle('songs-add', (event, song) => {
    const list = loadCustomSongs();
    const nextId = list.length ? Math.min(...list.map((x) => x.id)) - 1 : -1;
    const entry = {
      id: nextId,
      title: String(song.title || 'Cântec adăugat').trim(),
      author: String(song.author || '').trim(),
      stanzas: Array.isArray(song.stanzas) ? song.stanzas.filter((s) => s && s.text) : [],
    };
    list.push(entry);
    saveCustomSongs(list);
    return entry;
  });
}

// =========================================================
// Media (hărți biblice / ilustrații): cele incluse + cele proprii
// =========================================================
function mediaSources() {
  const out = [];
  // imagini incluse in aplicatie (data/media/maps)
  const builtInDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'data', 'media', 'maps')
    : path.join(__dirname, 'data', 'media', 'maps');
  try {
    if (fs.existsSync(builtInDir)) {
      for (const f of fs.readdirSync(builtInDir)) {
        if (/\.(png|jpe?g|webp|gif)$/i.test(f)) {
          out.push({ name: f, path: path.join(builtInDir, f), source: 'aplicatie' });
        }
      }
    }
  } catch (e) { /* folderul poate lipsi */ }
  // imagini proprii (din folderul de date utilizator)
  const userDir = userDataPath('media');
  try {
    if (fs.existsSync(userDir)) {
      for (const f of fs.readdirSync(userDir)) {
        if (/\.(png|jpe?g|webp|gif)$/i.test(f)) {
          out.push({ name: f, path: path.join(userDir, f), source: 'ale tale' });
        }
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

function registerMediaHandlers() {
  ipcMain.handle('media-list', () => mediaSources());
  ipcMain.handle('media-get', (event, filePath) => {
    try {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return { data: 'data:image/' + mime + ';base64,' + buf.toString('base64'), name: path.basename(filePath) };
    } catch (e) {
      console.error('media-get:', e);
      return null;
    }
  });
  ipcMain.handle('media-userdir', () => userDataPath('media'));

  // Lista videoclipurilor/audio descarcate (local), pentru redare integrata
  ipcMain.handle('videos-list', () => {
    const out = [];
    const vre = /\.(mp4|m4a|webm|mov|mkv|mp3|wav|ogg|flac|aac)$/i;
    const are = /\.(mp3|wav|ogg|flac|aac|m4a)$/i;
    const dirs = [path.join(app.getPath('downloads'), 'Negative Biserica'), userDataPath('media')];
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (vre.test(f)) out.push({ name: f, path: path.join(dir, f), kind: are.test(f) ? 'audio' : 'video' });
        }
      } catch (e) { /* folder ilizibil */ }
    }
    return out;
  });
}

// =========================================================
// Binare yt-dlp / ffmpeg
// =========================================================
function getBinPath(binName) {
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, 'bin');
  return path.join(basePath, binName);
}

function createWindows() {
  const displays = screen.getAllDisplays();
  const externalDisplay = displays.length > 1 ? displays[1] : displays[0];
  const multi = displays.length > 1;

  controlWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    title: 'Consola Tehnica de Control — Betania Copșa Mică',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  controlWindow.loadFile('control.html');

  projectionWindow = new BrowserWindow({
    x: externalDisplay.bounds.x,
    y: externalDisplay.bounds.y,
    width: externalDisplay.bounds.width,
    height: externalDisplay.bounds.height,
    fullscreen: multi,
    frame: false,
    alwaysOnTop: multi,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  projectionWindow.loadFile('projection.html');

  // Pe un singur monitor, panoul ramane vizibil deasupra proiectiei (pentru test/operare)
  if (!multi) {
    controlWindow.setAlwaysOnTop(true);
    controlWindow.show();
    controlWindow.focus();
  }

  ipcMain.on('send-to-screen', (event, data) => {
    sendToProjection('render-slide', data);
  });

  // Fereastra "Proiectie online" de pe Resurse Crestine (pe ecranul de proiectie)
  ipcMain.on('rc-online', () => {
    if (rcWindow && !rcWindow.isDestroyed()) { rcWindow.close(); rcWindow = null; return; }
    const disp = screen.getAllDisplays();
    const target = disp.length > 1 ? disp[1] : disp[0];
    rcWindow = new BrowserWindow({
      x: target.bounds.x, y: target.bounds.y,
      width: target.bounds.width, height: target.bounds.height,
      fullscreen: true, frame: false,
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    rcWindow.loadURL('https://www.resursecrestine.ro/proiectie-online/');
    rcWindow.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { rcWindow.close(); }
    });
    rcWindow.on('closed', () => { rcWindow = null; });
  });

  // Fereastra mica de previzualizare (oglinda a ecranului de proiectie)
  ipcMain.on('toggle-preview', () => {
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.close();
      previewWindow = null;
      return;
    }
    previewWindow = new BrowserWindow({
      width: 620,
      height: 350,
      title: 'Previzualizare — ce se proiectează',
      icon: path.join(__dirname, 'build', 'icon.png'),
      alwaysOnTop: true,
      resizable: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    previewWindow.loadFile('projection.html');
    previewWindow.on('closed', () => { previewWindow = null; });
  });

  ipcMain.on('open-downloads-folder', () => {
    const downloadDir = path.join(app.getPath('downloads'), 'Negative Biserica');
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
    shell.openPath(downloadDir);
  });

  ipcMain.on('start-download-media', (event, { url, formatType }) => {
    const ytdlpPath = getBinPath('yt-dlp.exe');
    const ffmpegPath = getBinPath('ffmpeg.exe');
    const downloadDir = path.join(app.getPath('downloads'), 'Negative Biserica');
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    if (!fs.existsSync(ytdlpPath)) {
      event.sender.send('download-status', { status: 'error', message: 'Binarul yt-dlp.exe nu a fost gasit in ' + ytdlpPath });
      return;
    }
    event.sender.send('download-status', { status: 'started', message: 'Initializare descarcare...' });

    const outputTemplate = path.join(downloadDir, '%(title)s.%(ext)s');
    let args = [];
    if (formatType === 'audio') {
      args = [url, '--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--output', outputTemplate, '--newline'];
    } else {
      args = [url, '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '--output', outputTemplate, '--newline'];
    }
    if (fs.existsSync(ffmpegPath)) args.push('--ffmpeg-location', ffmpegPath);

    const dlProcess = spawn(ytdlpPath, args);
    dlProcess.stdout.on('data', (data) => {
      const text = data.toString();
      const pm = text.match(/\[download\]\s+([\d.]+)%/);
      if (pm) {
        event.sender.send('download-status', { status: 'progress', progress: parseFloat(pm[1]), message: 'Descarcare: ' + pm[1] + '%' });
      } else if (text.includes('[ExtractAudio]')) {
        event.sender.send('download-status', { status: 'progress', progress: 95, message: 'Conversie in format MP3...' });
      }
    });
    dlProcess.stderr.on('data', (data) => console.error('yt-dlp stderr: ' + data));
    dlProcess.on('close', (code) => {
      event.sender.send('download-status', code === 0
        ? { status: 'completed', message: 'Descarcare finalizata cu succes!' }
        : { status: 'error', message: 'Eroare la descarcare (cod iesire: ' + code + ')' });
    });
  });
}

function registerYtSearchHandler() {
  ipcMain.handle('yt-search', (event, rawQuery) => new Promise((resolve) => {
    const ytdlp = getBinPath('yt-dlp.exe');
    if (!fs.existsSync(ytdlp)) { resolve({ ok: false, error: 'yt-dlp.exe nu exista in ' + ytdlp }); return; }
    const q = String(rawQuery || '').trim();
    if (!q) { resolve({ ok: false, error: 'Cautare goala' }); return; }
    const proc = spawn(ytdlp, ['ytsearch10:' + q, '--flat-playlist', '--no-playlist', '--no-warnings', '--print', '%(id)s\t%(title)s\t%(duration_string)s']);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', () => {
      const items = [];
      for (const line of out.split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts.length >= 2 && parts[0] && parts[1]) {
          items.push({ id: parts[0], title: parts[1], duration: parts[2] || '' });
        }
      }
      resolve({ ok: true, items });
    });
    proc.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
  }));
}

app.whenReady().then(() => {
  app.setAppUserModelId('ro.biserica.betania.copsamica');
  registerSongDbHandlers();
  registerMediaHandlers();
  registerYtSearchHandler();
  createWindows();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
