const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

let controlWindow = null;
let projectionWindow = null;
let songDb = null;

// =========================================================
// Baza de date cantece (cantari.db generat de scripts/build_full_database.js)
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

// Elimina diacriticele (pentru cautare toleranta: 'Maretul' == 'Mărețul')
function foldDiacritics(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Expresie SQL care aplica acelasi fold pe o coloana
function sqlFold(col) {
  let expr = 'lower(' + col + ')';
  const pairs = [
    ['ă', 'a'], ['â', 'a'], ['î', 'i'], ['ș', 's'], ['ş', 's'],
    ['ț', 't'], ['ţ', 't'], ['Ă', 'a'], ['Â', 'a'], ['Î', 'i'],
    ['Ș', 's'], ['Ț', 't'],
  ];
  for (const [from, to] of pairs) {
    expr = "replace(" + expr + ", '" + from + "', '" + to + "')";
  }
  return expr;
}

function registerSongDbHandlers() {
  // Numar cantece in baza (folosit si ca "exista baza?" probe)
  ipcMain.handle('songs-count', () => {
    const db = openSongDb();
    if (!db) return { db: false, count: 0 };
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM songs').get();
      return { db: true, count: row.c };
    } catch (e) {
      console.error(e);
      return { db: false, count: 0 };
    }
  });

  // Cautare: titlu/autor prin LIKE (fold) + versuri prin FTS5
  ipcMain.handle('songs-search', (event, rawQuery) => {
    const db = openSongDb();
    if (!db) return { db: false, songs: [] };
    const q = foldDiacritics(rawQuery).trim();
    if (!q) return { db: true, songs: [] };
    const like = '%' + q + '%';
    const seen = new Set();
    const songs = [];

    try {
      const byTitle = db
        .prepare(
          'SELECT id, title, author FROM songs WHERE ' + sqlFold('title') + ' LIKE ? OR ' + sqlFold('author') + ' LIKE ? ORDER BY title LIMIT 60'
        )
        .all(like, like);
      for (const s of byTitle) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        songs.push(s);
        if (songs.length >= 60) break;
      }
    } catch (e) {
      console.error('Cautare titlu esuata:', e);
    }

    if (songs.length < 60) {
      try {
        const terms = q.split(/\s+/).filter((w) => /^[a-z0-9]+$/.test(w) && w.length >= 2);
        if (terms.length) {
          const match = terms.map((t) => t + '*').join(' ');
          const room = 60 - songs.length;
          const byText = db
            .prepare(
              'SELECT s.id, s.title, s.author FROM songs s JOIN songs_fts f ON f.rowid = s.id WHERE songs_fts MATCH ? ORDER BY rank LIMIT ?'
            )
            .all(match, room);
          for (const s of byText) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            songs.push(s);
          }
        }
      } catch (e) {
        console.error('Cautare text esuata:', e);
      }
    }
    return { db: true, songs };
  });

  // Detaliile unui cantec (titlu, autor, strofe)
  ipcMain.handle('songs-get', (event, id) => {
    const db = openSongDb();
    if (!db) return null;
    const row = db.prepare('SELECT title, author, stanzas FROM songs WHERE id = ?').get(id);
    if (!row) return null;
    let stanzas = [];
    try { stanzas = JSON.parse(row.stanzas); } catch (e) { console.error(e); }
    return { title: row.title, author: row.author, stanzas };
  });
}

// =========================================================
// Cale binare yt-dlp / ffmpeg
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

  // 1. Fereastra Operatorului
  controlWindow = new BrowserWindow({
    width: 1250,
    height: 850,
    title: 'Consola Tehnica de Control',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  controlWindow.loadFile('control.html');

  // 2. Fereastra de Proiectie (Fullscreen pe display-ul extern)
  projectionWindow = new BrowserWindow({
    x: externalDisplay.bounds.x,
    y: externalDisplay.bounds.y,
    width: externalDisplay.bounds.width,
    height: externalDisplay.bounds.height,
    fullscreen: displays.length > 1,
    frame: displays.length <= 1,
    alwaysOnTop: displays.length > 1,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  projectionWindow.loadFile('projection.html');

  // Sincronizare proiectie
  ipcMain.on('send-to-screen', (event, data) => {
    if (projectionWindow) {
      projectionWindow.webContents.send('render-slide', data);
    }
  });

  // Deschidere director descarcari
  ipcMain.on('open-downloads-folder', () => {
    const downloadDir = path.join(app.getPath('downloads'), 'Negative Biserica');
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    shell.openPath(downloadDir);
  });

  // Modul Descarcare YouTube (yt-dlp + ffmpeg)
  ipcMain.on('start-download-media', (event, { url, formatType }) => {
    const ytdlpPath = getBinPath('yt-dlp.exe');
    const ffmpegPath = getBinPath('ffmpeg.exe');
    const downloadDir = path.join(app.getPath('downloads'), 'Negative Biserica');

    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    if (!fs.existsSync(ytdlpPath)) {
      event.sender.send('download-status', {
        status: 'error',
        message: 'Binarul yt-dlp.exe nu a fost gasit in ' + ytdlpPath
      });
      return;
    }

    event.sender.send('download-status', {
      status: 'started',
      message: 'Initializare descarcare...'
    });

    const outputTemplate = path.join(downloadDir, '%(title)s.%(ext)s');
    let args = [];

    if (formatType === 'audio') {
      args = [
        url,
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--output', outputTemplate,
        '--newline'
      ];
    } else {
      args = [
        url,
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--output', outputTemplate,
        '--newline'
      ];
    }

    if (fs.existsSync(ffmpegPath)) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    const dlProcess = spawn(ytdlpPath, args);

    dlProcess.stdout.on('data', (data) => {
      const text = data.toString();
      const progressMatch = text.match(/\[download\]\s+([\d.]+)%/);
      if (progressMatch) {
        event.sender.send('download-status', {
          status: 'progress',
          progress: parseFloat(progressMatch[1]),
          message: 'Descarcare: ' + progressMatch[1] + '%'
        });
      } else if (text.includes('[ExtractAudio]')) {
        event.sender.send('download-status', {
          status: 'progress',
          progress: 95,
          message: 'Conversie in format MP3...'
        });
      }
    });

    dlProcess.stderr.on('data', (data) => {
      console.error('yt-dlp stderr: ' + data);
    });

    dlProcess.on('close', (code) => {
      if (code === 0) {
        event.sender.send('download-status', {
          status: 'completed',
          message: 'Descarcare finalizata cu succes!'
        });
      } else {
        event.sender.send('download-status', {
          status: 'error',
          message: 'Eroare la descarcare (cod iesire: ' + code + ')'
        });
      }
    });
  });
}

app.whenReady().then(() => {
  registerSongDbHandlers();
  createWindows();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
