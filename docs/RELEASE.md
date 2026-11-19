# How to release

## English

Project licence: **GPL-3.0-or-later** (`LICENSE`). A release is always created as a **draft**: nobody sees it until you press "Publish release" on GitHub.

### 1. Preparation
1. `npm run check` and `npm run e2e` are green; [TESTING.md](../TESTING.md) is done for the installer and the portable build.
2. Set the version in `package.json` (for example `1.0.0`); in `CHANGELOG.md` move "Unreleased" into a version section.
3. `node scripts/notices.cjs` refreshes `THIRD_PARTY_NOTICES.txt`.
4. Models are published (`scripts/publish-models.ps1`, release `models-v1`); otherwise the "Download" buttons in the app do not work.
5. Commit, then tag: `git tag v1.0.0` and `git push origin main v1.0.0`.

### 2. What GitHub Actions does (`release.yml`)
It builds the installer and the portable exe, writes SHA-256 sums (`SHA256SUMS.txt`), makes winget and scoop manifests, adds a build attestation, and puts the files and `latest.yml` (auto-update reads the version from it) into a **draft** release. Check the files, write the description, press "Publish release".

### 3. Auto-update
Works for the installed version: the app reads `latest.yml` of the latest GitHub release. Checking is off by default (turn it on in Settings); downloading and installing need a button press. The portable build does not update itself. A draft release is not offered as an update until it is published.

### 4. Signing the exe (SmartScreen)
Without a signature Windows shows "Windows protected your PC": *More info → Run anyway*. The warning fades as downloads accumulate. Options:
1. **SignPath Foundation**: free signing for open-source projects (the GPL licence fits). Apply on the SignPath site as the repository owner; after approval add the `signpath/github-action-submit-signing-request` step to `release.yml` (token and project ids in repository secrets).
2. **Your own certificate**: put the file (base64) into the secret `CSC_LINK` and the password into `CSC_KEY_PASSWORD`; electron-builder signs automatically (the steps are ready).
3. **Microsoft Store**: a one-time fee, Microsoft signs the app; MSIX is required.

Until there is a signature: put the SHA-256 and a VirusTotal link in the release notes; the build attestation is visible on the repository's Attestations tab.

### 5. After publishing
- winget: copy `release/manifests/winget` into a fork of `microsoft/winget-pkgs` and open a pull request.
- scoop: put `release/manifests/scoop/morphio.json` into your own bucket.
- Check the update from an older installed version to the new one.

## Русский

Лицензия проекта: **GPL-3.0-or-later** (файл `LICENSE`). Релиз всегда создаётся **черновиком**: пока вы не нажали «Publish release» на GitHub, никто его не видит.

### 1. Подготовка
1. `npm run check` и `npm run e2e` зелёные; пройден [TESTING.md](../TESTING.md) на установщике и на портативной версии.
2. В `package.json` поставить версию (например `1.0.0`), в `CHANGELOG.md` перенести «Unreleased» в раздел версии.
3. `node scripts/notices.cjs`: обновить `THIRD_PARTY_NOTICES.txt`.
4. Модели опубликованы (`scripts/publish-models.ps1`, релиз `models-v1`): иначе кнопки «Скачать» в приложении не работают.
5. Коммит, затем тег: `git tag v1.0.0` и `git push origin main v1.0.0`.

### 2. Что делает GitHub Actions (`release.yml`)
Собирает установщик и портативную версию, считает SHA-256 (`SHA256SUMS.txt`), делает манифесты winget и scoop, добавляет подтверждение сборки (attestation), кладёт файлы и `latest.yml` (из него автообновление берёт версию) в **черновик** релиза. Проверьте файлы, напишите описание, нажмите «Publish release».

### 3. Автообновление
Работает у установленной версии: приложение читает `latest.yml` последнего релиза на GitHub. Проверка по умолчанию выключена (включается в Настройках), скачивание и установка только по кнопке. Портативная версия не обновляется сама. Релиз-черновик обновления не раздаёт, пока не опубликован.

### 4. Подпись exe (SmartScreen)
Без подписи Windows показывает «Windows защитила ваш компьютер»: *Подробнее → Выполнить в любом случае*. Предупреждение уходит по мере скачиваний. Варианты:
1. **SignPath Foundation**: бесплатная подпись для открытых проектов (лицензия GPL подходит). Заявка подаётся на сайте SignPath от имени владельца репозитория; после одобрения в `release.yml` добавляется шаг `signpath/github-action-submit-signing-request` (токен и идентификаторы проекта в секретах репозитория).
2. **Свой сертификат**: положить файл в секрет `CSC_LINK` (base64) и пароль в `CSC_KEY_PASSWORD`; electron-builder подпишет сам (шаги уже подготовлены).
3. **Microsoft Store**: разовый взнос, подпись ставит Microsoft; потребуется MSIX.

Пока подписи нет: в описании релиза указать SHA-256 и ссылку на проверку в VirusTotal; подтверждение сборки видно во вкладке Attestations репозитория.

### 5. После публикации
- winget: скопировать `release/manifests/winget` в форк `microsoft/winget-pkgs` и открыть pull request.
- scoop: положить `release/manifests/scoop/morphio.json` в свой bucket.
- Проверить обновление со старой установленной версии на новую.
