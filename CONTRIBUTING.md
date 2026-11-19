# Contributing / Участие в проекте

## Run from source
```powershell
npm ci
npm run dev        # development window
npm run check      # types + translations + unit tests
npm run e2e        # end-to-end tests in a real Electron window
npm run dist       # installer + portable exe in release/
```
Node.js 22 and Windows are required. If npm 11 skips install scripts, allow them for `electron`, `ffmpeg-static`, `onnxruntime-node`.

## Rules
- **Russian text is the key.** Every visible string goes through `t('Русский текст')` and needs an English entry in `src/shared/en.ts`; `npm run i18n` fails otherwise.
- Offline by default: no telemetry, no network calls without a user action. Downloads must be verified (SHA-256).
- Originals are never modified; results get a free name (`name (1).ext`) unless `--overwrite` is used.
- Add tests with the change (`tests/unit` for logic, `tests/e2e` for the window).
- Do not add models, `node_modules` or built exe files to the repository.

## Pull requests
Small, focused changes. Describe what changed and how you checked it. Be kind.
