# May's Studio ♥

A choreography notebook for May, made as an iPhone home-screen app (it runs in Safari, no App Store needed).

- **Add a song** from Files (MP3 / M4A / WAV). Songs and notes are saved on her phone.
- **Find the beat**: press play and tap along. The BPM is detected and every 8-count is numbered.
  Use **Set “1” here** to choose where counting starts and ◀ ▶ to fine-tune it.
- **Live counter**: big 1–8 tiles light up with the music.
- **Practice**: slow down to 0.5× / 0.75× / 0.9× without changing the pitch, jump by 8-counts, swipe the waveform to scrub.
- **Loop & notes**: tap an 8-count, add **＋ next** to make it longer, hit **Loop**, and write notes for it.
- **Contemporary / Hip Hop** button switches the whole look (and says “phrases” or “8-counts”).
- **Secret**: tap the ♥ at the bottom of the home screen 3 times.

## Before you give it to her
1. Edit `soundtrack.js`: your songs, dates, notes and sign-off. Photos go in `photos/`.
2. In `sw.js`, bump `VERSION` every time you change something, so her phone picks up the update.

## Preview on your Mac
```bash
python3 -m http.server 8790
```
Then open http://localhost:8790

## Put it on her iPhone
It has to be served over **https**, and GitHub Pages does that for free:
1. Create a GitHub repo, push this folder, then go to Settings → Pages → deploy from `main`.
2. On her iPhone, open the Pages link in **Safari** → Share → **Add to Home Screen**.
3. It opens full-screen with its own icon and works offline.

Heads-up: anyone with the link can open the page, but her songs and notes stay on her phone.
The Soundtrack page is in the public files though, so keep the repo name unguessable or make the repo private
(Pages for private repos needs GitHub Pro).
