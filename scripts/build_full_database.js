#!/usr/bin/env node
/**
 * build_full_database.js
 * ======================
 * Genereaza database/cantari.db (SQLite + FTS5) din arhiva completa Resurse Crestine
 * (cantari_resurse_crestine.zip — ~24.603 cantari) SAU din data/songs.json (fallback).
 *
 * Folosire:
 *   node scripts/build_full_database.js                       # detecteaza automat sursa
 *   node scripts/build_full_database.js --zip path/to/archive.zip
 *   node scripts/build_full_database.js --json path/to/songs.json
 *   node scripts/build_full_database.js --out path/to/cantari.db
 *
 * Sursele sunt incercate in ordine: --zip > --json > cantari_resurse_crestine.zip
 * (in radacina proiectului) > data/songs.json.
 *
 * Baza rezultata este folosita de aplicatie (main.js) pentru cautare rapida
 * si este inclusa in .exe prin extraResources (database/cantari.db).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------
// 1. Detectare intrare
// ---------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--zip')  out.zip = argv[++i];
    if (argv[i] === '--json') out.json = argv[++i];
    if (argv[i] === '--out')  out.out = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const zipCandidates = [
  args.zip,
  path.join(ROOT, 'cantari_resurse_crestine.zip'),
].filter(Boolean);
const jsonCandidates = [
  args.json,
  path.join(ROOT, 'data', 'songs.json'),
].filter(Boolean);

const zipPath = zipCandidates.find((p) => fs.existsSync(p));
const jsonPath = !zipPath ? jsonCandidates.find((p) => fs.existsSync(p)) : null;
const outPath = args.out || path.join(ROOT, 'database', 'cantari.db');

if (!zipPath && !jsonPath) {
  console.error('[eroare] Nici arhiva ZIP (cantari_resurse_crestine.zip) si nici data/songs.json nu exista.');
  console.error('  Pune arhiva completa in radacina proiectului sau ruleaza cu --zip / --json.');
  process.exit(1);
}
if (zipPath) console.log('[input] arhiva ZIP: ' + zipPath);
if (jsonPath) console.log('[input] JSON:      ' + jsonPath);

// ---------------------------------------------------------------
// 2. Parser-e pentru continut
// ---------------------------------------------------------------
function foldDiacritics(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const STANZA_LABEL_RE = /^(vers[ei]*|v\d+|chorus|cor|refren|bridge|punte|intro|interludiu|final|outro|strof[aă]*)\b/i;

function stanzaType(label) {
  const l = label.trim();
  if (/^vers/iu.test(l)) return 'Strofa ' + l.replace(/^vers[ei]*\s*/iu, '').trim();
  if (/^(chorus|cor|refren)/iu.test(l)) return 'Refren';
  if (/^(bridge|punte)/iu.test(l)) return 'Punte';
  if (/^(intro|introducere)/iu.test(l)) return 'Intro';
  if (/^(final|outro|sfarsit|sfârșit)/iu.test(l)) return 'Final';
  return l;
}

function splitStanzas(plainText) {
  const stanzas = [];
  const lines = String(plainText || '').split(/\r?\n/);
  let block = [];
  let blockNo = 0;

  const flush = () => {
    const clean = block
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.replace(/[^\p{L}\p{N}]/gu, '').length > 0);
    block = [];
    if (clean.length === 0) return;
    blockNo++;
    let label = null;
    let textLines = clean;
    if (STANZA_LABEL_RE.test(clean[0])) {
      label = clean[0];
      textLines = clean.slice(1);
    }
    if (textLines.length === 0 && label) return; // doar eticheta, fara text
    stanzas.push({
      type: label ? stanzaType(label) : 'Strofa ' + blockNo,
      text: (label ? textLines : clean).join('\n').trim(),
    });
  };

  for (const line of lines) {
    if (line.trim() === '') { flush(); continue; }
    block.push(line);
  }
  flush();
  return stanzas.filter((s) => s.text.length > 0);
}

// --- cantec dintr-un fisier text tip EasyWorship CLI / RC ---
function songFromTextFile(fileName, content) {
  const lines = String(content)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return null;
  // linia 1 = titlu, linia 2 = autor (daca nu pare vers), restul = versuri
  let title = nonEmpty[0];
  let author = '';
  let restStart = 1;
  if (nonEmpty.length > 1) {
    const second = nonEmpty[1];
    const looksLikeAuthor = second.length < 80 && /^[A-Za-zĂÂÎȘȚăâîșț .'\-–—()]+$/u.test(second);
    if (looksLikeAuthor) {
      author = second;
      restStart = 2;
    }
  }
  const bodyLines = lines.slice(lines.indexOf(title) + restStart).filter((l) => l.length > 0);
  const bodyText = bodyLines.join('\n');
  const stanzas = splitStanzas(bodyText);
  if (stanzas.length === 0 && bodyLines.length > 0) {
    stanzas.push({ type: 'Strofa 1', text: bodyLines.join('\n') });
  }
  if (stanzas.length === 0) return null;
  return { title, author, stanzas };
}

// --- cantec dintr-un XML OpenSong ---
function songFromOpenSongXml(content) {
  const xml = String(content);
  const grab = (re) => {
    const m = xml.match(re);
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  };
  const title = grab(/<title>([\s\S]*?)<\/title>/i);
  if (!title) return null;
  const author = grab(/<author>([\s\S]*?)<\/author>/i) || grab(/<copyright>([\s\S]*?)<\/copyright>/i) || '';
  const lyrics = grab(/<lyrics>([\s\S]*?)<\/lyrics>/i);
  if (!lyrics) return null;
  // <verse name="v1">..</verse> -> strofe
  const verseRe = /<verse[^>]*name="?([^"\s>]*)"?[^>]*>([\s\S]*?)<\/verse>/gi;
  const stanzas = [];
  let m;
  let i = 0;
  while ((m = verseRe.exec(lyrics)) !== null) {
    i++;
    const label = m[1] || 'Strofa ' + i;
    const text = m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    if (text) stanzas.push({ type: label, text });
  }
  if (stanzas.length === 0) {
    const clean = lyrics.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (clean) stanzas.push({ type: 'Strofa 1', text: clean });
  }
  if (stanzas.length === 0) return null;
  return { title, author, stanzas };
}

// ---------------------------------------------------------------
// 3. Colectare cantece
// ---------------------------------------------------------------
function collectSongs() {
  const songs = [];

  if (zipPath) {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    console.log('[zip] intrari: ' + entries.length);

    // a) JSON cu toate cantecele intr-un singur fisier
    const jsonEntry = entries.find((e) => !e.isDirectory && /\.json$/i.test(e.entryName));
    if (jsonEntry) {
      const data = JSON.parse(zip.readAsText(jsonEntry));
      if (Array.isArray(data)) {
        for (const it of data) {
          if (it && it.title) {
            songs.push({
              title: String(it.title).trim(),
              author: String(it.author || '').trim(),
              stanzas: Array.isArray(it.stanzas) ? it.stanzas : [],
            });
          }
        }
        if (songs.length) {
          console.log('[json] cantece citite din fisierul JSON din arhiva: ' + songs.length);
          return songs;
        }
      }
    }

    // b) fisiere XML OpenSong
    let xmlCount = 0;
    for (const e of entries) {
      if (e.isDirectory || !/\.xml$/i.test(e.entryName)) continue;
      const song = songFromOpenSongXml(zip.readAsText(e));
      if (song) { songs.push(song); xmlCount++; }
    }
    if (songs.length) {
      console.log('[xml] cantece OpenSong: ' + songs.length);
      return songs;
    }

    // c) fisiere text (EasyWorship CLI / RC)
    let txtCount = 0;
    for (const e of entries) {
      if (e.isDirectory || !/\.txt$/i.test(e.entryName)) continue;
      const song = songFromTextFile(e.entryName, zip.readAsText(e));
      if (song) { songs.push(song); txtCount++; }
    }
    console.log('[txt] cantece din fisiere text: ' + songs.length + ' (fisiere: ' + txtCount + ')');
    return songs;
  }

  // JSON fallback (data/songs.json)
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  for (const it of data) {
    if (it && it.title) {
      songs.push({
        title: String(it.title).trim(),
        author: String(it.author || '').trim(),
        stanzas: Array.isArray(it.stanzas) ? it.stanzas : [],
      });
    }
  }
  console.log('[json] cantece din ' + jsonPath + ': ' + songs.length);
  return songs;
}

const songs = collectSongs();
if (songs.length === 0) {
  console.error('[eroare] Nu am gasit niciun cantec in sursa selectata. Verifica formatul arhivei.');
  process.exit(1);
}
console.log('[total] cantece de scris: ' + songs.length);

// ---------------------------------------------------------------
// 4. Creare baza de date SQLite (tabel + FTS5)
// ---------------------------------------------------------------
fs.mkdirSync(path.dirname(outPath), { recursive: true });
if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

const db = new Database(outPath);
db.pragma('journal_mode = OFF');
db.exec(`
  CREATE TABLE songs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    title   TEXT NOT NULL,
    author  TEXT NOT NULL DEFAULT '',
    stanzas TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE songs_fts USING fts5(title, author, body, content='');
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`);

const insertSong = db.prepare(
  'INSERT INTO songs (title, author, stanzas) VALUES (?, ?, ?)'
);
const insertFts = db.prepare(
  "INSERT INTO songs_fts (rowid, title, author, body) VALUES (?, ?, ?, ?)"
);

const insertAll = db.transaction((list) => {
  let id = 0;
  for (const s of list) {
    id++;
    const title = s.title;
    const author = s.author || '';
    const stanzasJson = JSON.stringify(s.stanzas || []);
    const body = (s.stanzas || []).map((st) => st.text).join('\n');
    insertSong.run(title, author, stanzasJson);
    insertFts.run(id, foldDiacritics(title), foldDiacritics(author), foldDiacritics(body));
  }
});

const BATCH = 2500;
for (let i = 0; i < songs.length; i += BATCH) {
  insertAll(songs.slice(i, i + BATCH));
  process.stdout.write('\r[db] ' + Math.min(i + BATCH, songs.length) + '/' + songs.length + ' ...');
}
process.stdout.write('\n');

db.prepare("INSERT INTO meta (key, value) VALUES ('source_archive', ?)").run(zipPath ? path.basename(zipPath) : path.basename(jsonPath));
db.prepare("INSERT INTO meta (key, value) VALUES ('created_at', ?)").run(new Date().toISOString());
db.prepare("INSERT INTO meta (key, value) VALUES ('song_count', ?)").run(String(songs.length));

const check = db.prepare('SELECT COUNT(*) AS c FROM songs').get();
console.log('[db] scris: ' + check.c + ' cantece -> ' + outPath);
db.close();
console.log('[gata] Baza de date generata cu succes.');
