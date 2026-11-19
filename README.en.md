# Morphio

A free file converter for Windows that works **fully offline**: images, video, audio, tables, archives, PDF, documents and books, background removal,
GIF studio, video montage, subtitles. It sends nothing to the network. [Русская версия](README.md)

![Converter](docs/screenshots/convert.png)

## Download and install

1. Open [Releases](https://github.com/Omorriiz/Morphio/releases/latest) and download:
   - **`Morphio-Setup-<version>.exe`** — the installer (recommended): no administrator rights needed, shortcuts, fast start,
     the `morphio` command in the console, optional auto-update (turn it on in Settings);
   - or **`Morphio-Portable-<version>.exe`** — no installation, but every start is slower.
2. Windows may show "Windows protected your PC" (the files are not signed yet). Click *More info → Run anyway*.
   You can check the file against `SHA256SUMS.txt` on the same page.
3. Start Morphio, drop files into the window, choose what to convert them to and press "Convert". Originals are never changed.

**Extra modules** (neural networks, Pandoc) are not bundled: when a feature needs one, a "Download" button appears next to it. A module is downloaded once and then
works offline. Without them conversion, video, audio, archives, GIF and solid-colour background removal work.

**Something is wrong?** Settings → "About and data" → "Report a problem" (opens an issue page with the version and a log without your user name).

Requirements: Windows 10 or 11, 64-bit, about 750 MB of disk space (without modules). Licence: GPL-3.0-or-later.

<details><summary>Screenshots</summary>

![Background](docs/screenshots/background.png)
![GIF](docs/screenshots/gif.png)
![Montage](docs/screenshots/montage.png)

</details>

## Command line

```powershell
morphio convert photo.png --to webp
morphio media video.mp4 --trim 0:05-0:10 --rotate 90
morphio gif video.mp4 --fps 10 --width 480
morphio convert subs.srt --to vtt --shift 2
morphio --help
```

## For developers

See [CONTRIBUTING.md](CONTRIBUTING.md). Third-party components: [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Release process: [docs/RELEASE.md](docs/RELEASE.md).
