# BisericaProiectie — Sistem de Proiecție pentru Biserică (Windows)

Aplicație desktop (Electron) pentru proiecția versetelor, cântărilor și a
mediilor video pe un ecran secundar (proiector/TV), controlată de pe un panou
operator. Rulează pe Windows, generată ca `.exe` portabil.

## Funcționalități

- **Biblie** — textul complet **Cornilescu** (66 cărți, 31.102 versete) inclus în aplicație; căutare după referință (ex. `Ioan 3:16`) sau cuvânt, proiecție cu un click
- **Cântări** — bibliotecă completă (17.271 cântece din colecția Resurse Creștine / EasyWorship 7), căutare după titlu, autor sau vers, selectare pe strofe/refren
- **Căutare inteligentă** — ignoră diacriticele (cauți „Mărețul Har" și găsești și „Maretul Har"), rezultate limitate la 60 cu sugestie de rafinare
- **Media** — redare video YouTube (embed fără controale) pe ecranul de proiecție
- **Descărcare negativ offline** — descărcare nativă MP3/MP4 cu `yt-dlp` + `ffmpeg`,
  cu bară de progres, salvare automată în folderul `Downloads/Negative Biserica`
- **Control proiecție** — titlu + text, ecran negru, doar fundal, alertă derulantă
- **Ceas digital** permanent pe ecranul de proiecție
- **Multi-monitor** — fereastra de proiecție se deschide automat pe ecranul extern

## Structura fișierelor

```text
church-project/
├── .github/
│   └── workflows/
│       └── build.yml      # descarcă yt-dlp + ffmpeg, generează cantari.db, compilează .exe
├── bin/
│   └── .gitkeep           # yt-dlp.exe + ffmpeg.exe (în CI automat; local, manual)
├── database/
│   └── cantari.db         # baza SQLite+FTS5 generată de scripts/build_full_database.js
├── data/
│   ├── bible.json         # Biblia Cornilescu COMPLETĂ (66 cărți, 31.102 versete)
│   ├── songs.json         # cântece (sursă JSON, folosită doar ca fallback în dev)
│   ├── songs_TEMPLATE.txt # șablon text pentru adăugarea manuală de cântece
│   └── bible_sample.json / songs_sample.json
├── scripts/
│   └── build_full_database.js  # arhiva ZIP (24.603 cântece) / JSON -> cantari.db
├── tools/
│   ├── convert-ew7.ps1    # export EasyWorship 7 (SQLite+RTF) -> songs.json
│   ├── convert-songs.ps1  # șablon text -> songs.json
│   └── sqlite/            # sqlite3.exe (folosit de convertorul EW7)
├── main.js                # ferestre + IPC + căutare în cantari.db + descărcare yt-dlp
├── control.html           # panoul operatorului
├── projection.html        # ecranul de proiecție
└── package.json
```

---

## Cum obții fișierul `.exe` (fără să compilezi local)

1. Creează un repository pe [GitHub](https://github.com) (ex. `biserica-display`).
2. Încarcă toate fișierele din acest folder, păstrând exact structura de mai sus
   (inclusiv `.github/workflows/` și `bin/.gitkeep` — fișierele ascunse trebuie
   încărcate explicit dacă folosești interfața web).
3. La fiecare push pe `main` (sau manual din tab-ul **Actions**), GitHub:
   - descarcă automat `yt-dlp.exe` și `ffmpeg.exe` în `bin/`,
   - le împachetează în aplicație (`extraResources`),
   - compilează `.exe`-ul portabil (~3–6 minute).
4. Descarcă rezultatul: **Actions** → rularea finalizată → **Artifacts** →
   **`BisericaProiectie-Exe`** → dezarhivează și rulează pe PC-ul bisericii.

---

## Test local (înainte de a urca pe GitHub)

Ai nevoie de [Node.js LTS](https://nodejs.org) și de cele două binare în `bin/`:

```bash
# descarcă o singură dată, manual, pentru testul local:
#   https://github.com/yt-dlp/yt-dlp/releases/latest  → yt-dlp.exe  în bin/
#   https://github.com/GyanD/codexffmpeg/releases     → ffmpeg.exe  în bin/

npm install
npm start
```

Se deschide panoul operatorului; cu un al doilea ecran conectat, proiecția apare
automat pe el (fullscreen). Fără al doilea ecran, proiecția apare ca fereastră
normală lângă panou (util pentru test).

> Notă: fără `yt-dlp.exe` în `bin/`, butonul de descărcare afișează o eroare clară;
> restul aplicației (Biblie, cântări, proiecție, redare YouTube) funcționează normal.

---

## Datele incluse

- **Biblia (bible.json)** este deja completă: traducerea **Cornilescu** (textul clasic,
  domeniu public), 66 de cărți, 31.102 versete. Nu trebuie să faci nimic.
- **Cântările** — două căi, în ordine:
  1. **Bază SQLite (`database/cantari.db`)** — sursa principală folosită de aplicație
     la runtime (căutare rapidă prin FTS5, fără încărcarea a zeci de MB în memorie).
     Se generează automat la compilare din **`cantari_resurse_crestine.zip`**
     (arhiva completă RC, ~24.603 cântece) așezat în rădăcina proiectului.
  2. **JSON (`data/songs.json`)** — fallback de dezvoltare (17.271 cântece extrase
     din exportul EasyWorship 7). Dacă nu există zip-ul complet, `db:build` folosește
     acest fișier, iar baza rezultată conține 17.271 de cântece.

### Generarea bazei de date (local sau în GitHub Actions)

```bash
# cu arhiva completă în rădăcină:
node scripts/build_full_database.js                 # detectează cantari_resurse_crestine.zip
# sau explicit:
node scripts/build_full_database.js --zip calea/catre/arhiva.zip
node scripts/build_full_database.js --json data/songs.json   # forțat din JSON
```

Rezultatul: `database/cantari.db` (inclus automat în `.exe` prin `extraResources`).
În GitHub Actions, pasul **„Generare baza de date cantece"** rulează automat
`npm run db:build` înainte de compilare.

### Formatul arhivei acceptat de `build_full_database.js`

- fișiere `.txt` (un cântec per fișier — titlu, autor, strofe separate de linii goale)
- fișiere `.xml` OpenSong (`<song><title>…<lyrics><verse name="v1">…`)
- un singur `.json` cu lista de cântece (`{title, author, stanzas:[{type,text}]}`)

### Adăugare manuală de cântece

Completezi `data/songs_TEMPLATE.txt` (linie `### Titlu | Autor`, strofele încep cu
`@Strofa 1` / `@Refren`) și rulezi:
```bash
powershell -ExecutionPolicy Bypass -File tools/convert-songs.ps1
```
apoi reconstruiești baza cu `npm run db:build`.

---

## Avertismente importante (citește!)

1. **„Fără reclame" la redarea YouTube nu e garantat** — aplicația folosește embed-ul
   oficial (`youtube-nocookie`); YouTube poate afișa totuși reclame în anumite condiții.
2. **Descărcarea de pe YouTube (yt-dlp)** poate încălca termenii platformei —
   folosește funcția doar pentru conținut pe care ai dreptul să-l descarci
   (ex. negative cu licență de utilizare în biserică).
3. **Imaginea de fundal** e încărcată de pe Unsplash (necesită internet la prima
   afișare). Pentru funcționare 100% offline, înlocuiește URL-ul din
   `projection.html` cu o imagine locală.
4. **Securitate**: aplicația rulează cu acces local complet (necesar pentru citirea
   datelor și rularea yt-dlp) — folosește-o doar pe calculatorul de încredere al bisericii.
5. Cântările din eșantion sunt demonstrative; pentru texte oficiale, respectă
   drepturile de autor ale traducerilor Biblice folosite.

---

## Personalizare rapidă

| Ce vrei să schimbi | Unde |
|---|---|
| Imaginea de fundal | `projection.html` — URL-ul din `background-image` |
| Folderul de negative | `main.js` — `'Negative Biserica'` |
| Culorile panoului | `control.html` — variabilele `:root` |
| Datele (Biblie/cântări) | fișierele din `data/` |
| Calitatea MP3/MP4 | `main.js` — argumentele yt-dlp (`--audio-quality`, `-f`) |
