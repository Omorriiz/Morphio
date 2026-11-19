#!/usr/bin/env node
/**
 * Манифесты для winget и scoop из готового установщика.
 *
 *   node scripts/make-manifests.cjs <установщик.exe> [--version 1.0.0] [--url <прямая ссылка>] [--out папка]
 *
 * Версия берётся из package.json, ссылка — из релиза GitHub с тегом v<версия>, хеш SHA-256 считается по файлу.
 * Результат: <out>/winget/*.yaml (три файла, как требует winget-pkgs) и <out>/scoop/morphio.json.
 * Манифесты кладутся в winget-pkgs / свой bucket вручную после выпуска релиза: скрипт сам ничего не публикует.
 */
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const REPO = 'Omorriiz/Morphio'
const PUBLISHER = 'Omorriiz'
const ID = `${PUBLISHER}.Morphio`

function parse(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i]
    else o._.push(argv[i])
  }
  return o
}

function sha256(file) {
  const h = createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}

/** Строка для YAML: в кавычках, если есть спецсимволы. */
const y = (s) => (/^[\w./:-]+$/.test(String(s)) ? String(s) : JSON.stringify(String(s)))

function build({ version, url, hash, size, license, date }) {
  const upper = hash.toUpperCase()
  const winget = {
    [`${ID}.yaml`]: [
      '# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json',
      `PackageIdentifier: ${ID}`,
      `PackageVersion: ${version}`,
      'DefaultLocale: en-US',
      'ManifestType: version',
      'ManifestVersion: 1.6.0',
      ''
    ].join('\n'),
    [`${ID}.locale.en-US.yaml`]: [
      '# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json',
      `PackageIdentifier: ${ID}`,
      `PackageVersion: ${version}`,
      'PackageLocale: en-US',
      `Publisher: ${PUBLISHER}`,
      `PublisherUrl: https://github.com/${PUBLISHER}`,
      'PackageName: Morphio',
      `PackageUrl: https://github.com/${REPO}`,
      `License: ${y(license)}`,
      `LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE`,
      'ShortDescription: Free offline file converter, background remover and GIF studio',
      'Description: Morphio converts images, video, audio, documents, tables and archives, removes backgrounds, makes GIFs and works fully offline.',
      'Moniker: morphio',
      'Tags:',
      '  - converter',
      '  - image',
      '  - video',
      '  - gif',
      '  - offline',
      'ManifestType: defaultLocale',
      'ManifestVersion: 1.6.0',
      ''
    ].join('\n'),
    [`${ID}.installer.yaml`]: [
      '# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json',
      `PackageIdentifier: ${ID}`,
      `PackageVersion: ${version}`,
      'InstallerType: nullsoft',
      'Scope: user',
      'InstallModes:',
      '  - interactive',
      '  - silent',
      'InstallerSwitches:',
      '  Silent: /S',
      '  SilentWithProgress: /S',
      'UpgradeBehavior: install',
      `ReleaseDate: ${date}`,
      'Installers:',
      '  - Architecture: x64',
      `    InstallerUrl: ${y(url)}`,
      `    InstallerSha256: ${upper}`,
      'ManifestType: installer',
      'ManifestVersion: 1.6.0',
      ''
    ].join('\n')
  }
  const scoop = {
    version,
    description: 'Free offline file converter, background remover and GIF studio',
    homepage: `https://github.com/${REPO}`,
    license,
    architecture: { '64bit': { url, hash } },
    innosetup: false,
    installer: { script: ['Start-Process -FilePath "$dir\\$fname" -ArgumentList "/S", "/D=$dir" -Wait'] },
    uninstaller: { script: ['Start-Process -FilePath "$dir\\Uninstall Morphio.exe" -ArgumentList "/S" -Wait'] },
    bin: 'morphio.cmd',
    checkver: { github: `https://github.com/${REPO}` },
    autoupdate: { architecture: { '64bit': { url: `https://github.com/${REPO}/releases/download/v$version/Morphio-Setup-$version.exe` } } },
    notes: `Installed size ${(size / 1048576).toFixed(0)} MB`
  }
  return { winget, scoop }
}

function main() {
  const a = parse(process.argv.slice(2))
  const file = a._[0]
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node scripts/make-manifests.cjs <installer.exe> [--version 1.0.0] [--url <direct link>] [--out dir]')
    process.exit(2)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const version = a.version || pkg.version
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`Bad version: ${version}`)
    process.exit(2)
  }
  const url = a.url || `https://github.com/${REPO}/releases/download/v${version}/${path.basename(file)}`
  const license = a.license || pkg.license || 'UNLICENSED'
  const out = path.resolve(a.out || path.join(__dirname, '..', 'release', 'manifests'))
  const { winget, scoop } = build({
    version,
    url,
    hash: sha256(file),
    size: fs.statSync(file).size,
    license,
    date: new Date().toISOString().slice(0, 10)
  })
  const wdir = path.join(out, 'winget', 'manifests', PUBLISHER[0].toLowerCase(), PUBLISHER, 'Morphio', version)
  fs.mkdirSync(wdir, { recursive: true })
  for (const [name, text] of Object.entries(winget)) fs.writeFileSync(path.join(wdir, name), text)
  fs.mkdirSync(path.join(out, 'scoop'), { recursive: true })
  fs.writeFileSync(path.join(out, 'scoop', 'morphio.json'), JSON.stringify(scoop, null, 2) + '\n')
  console.log(wdir)
  console.log(path.join(out, 'scoop', 'morphio.json'))
  if (license === 'UNLICENSED') console.error('Note: licence is not set yet (decided at the very end); set it with --license or in package.json before publishing.')
}

if (require.main === module) main()
module.exports = { build, sha256 }
