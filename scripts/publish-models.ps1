# Выкладывает модели и программы в релиз `models-v1` репозитория Omorriiz/Morphio.
#
# Что нужно один раз: установить GitHub CLI (winget install GitHub.cli) и войти: gh auth login
# Запуск из папки проекта:  powershell -ExecutionPolicy Bypass -File scripts\publish-models.ps1
#
# Скрипт ничего не публикует, пока не проверит контрольные суммы всех файлов и не спросит подтверждение.
# Повторный запуск безопасен: уже загруженные файлы пропускаются.

$ErrorActionPreference = 'Stop'
$repo = 'Omorriiz/Morphio'
$tag = 'models-v1'
$dir = Join-Path $PSScriptRoot '..\models-release' | Resolve-Path

# Ожидаемые суммы (те же, что в src/main/modules.ts)
$expected = [ordered]@{
  'isnet-general-use.onnx'  = '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a'
  'realesrgan-x4v3.onnx'    = '2d1810f8b75c6a899487decf933697241eafbe6327d7b723674ba6df73a08fda'
  'realesrgan-x4v3.data'    = '512d0ec9940c2e9d85d27f2952f12a0b77b7841dc22df4ce9f3ea458bc98f37f'
  'rus.traineddata'         = 'e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225'
  'eng.traineddata'         = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
  'whisper-bin-x64.zip'     = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
  'ggml-tiny.bin'           = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
  'ggml-base.bin'           = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  'ggml-small.bin'          = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Не найдена программа gh. Установите: winget install GitHub.cli' }
gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Вы не вошли в GitHub. Выполните: gh auth login' }

Write-Host 'Проверяю контрольные суммы...'
foreach ($name in $expected.Keys) {
  $file = Join-Path $dir $name
  if (-not (Test-Path $file)) { throw "Нет файла $name в папке models-release" }
  $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $expected[$name]) { throw "Сумма не совпала: $name" }
  Write-Host ("  ok  {0}  {1:N1} МБ" -f $name, ((Get-Item $file).Length / 1MB))
}

# Файл с суммами для релиза
$sums = ($expected.GetEnumerator() | ForEach-Object { "$($_.Value)  $($_.Key)" }) -join "`n"
Set-Content -Path (Join-Path $dir 'SHA256SUMS.txt') -Value $sums -Encoding ascii

$total = ($expected.Keys | ForEach-Object { (Get-Item (Join-Path $dir $_)).Length } | Measure-Object -Sum).Sum / 1MB
Write-Host ""
Write-Host ("Будет создан релиз {0} в {1} и загружено {2:N0} МБ (файлы доступны всем в интернете)." -f $tag, $repo, $total)
$answer = Read-Host 'Опубликовать? Введите yes'
if ($answer -ne 'yes') { Write-Host 'Отменено.'; exit 1 }

# Windows PowerShell 5.1 считает любой текст из stderr программы ошибкой: на время вызовов gh отключаем остановку,
# а результат проверяем по коду возврата.
$ErrorActionPreference = 'Continue'
$exists = $true
gh release view $tag --repo $repo 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { $exists = $false }
if (-not $exists) {
  Write-Host "Создаю релиз $tag..."
  gh release create $tag --repo $repo --title 'Модели и программы для модулей Morphio' --notes-file (Join-Path $dir 'NOTICE.md')
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать релиз' }
}

$files = @($expected.Keys | ForEach-Object { Join-Path $dir $_ }) + (Join-Path $dir 'SHA256SUMS.txt') + (Join-Path $dir 'NOTICE.md')
foreach ($f in $files) {
  Write-Host "Загружаю $(Split-Path $f -Leaf)..."
  gh release upload $tag $f --repo $repo --clobber
  if ($LASTEXITCODE -ne 0) { throw "Не удалось загрузить $(Split-Path $f -Leaf). Запустите скрипт ещё раз (файлы перезальются)." }
}
Write-Host 'Готово. Адрес: https://github.com/Omorriiz/Morphio/releases/tag/models-v1'
