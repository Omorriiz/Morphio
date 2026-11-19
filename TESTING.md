# Manual release checklist

## English

The automatic tests (`npm run check`, `npm run e2e`) check the logic and the window on generated files. This list checks what shows only on real files and on a clean Windows. For every item write what you expected and what you saw. Mark: ✔ as expected, ✘ not (describe it).

Version: ______  Windows: ______  Installer / portable: ______  GPU: ______  Date: ______

### 0. Installation

| № | What to do | Expected | Result |
|---|---|---|---|
| 0.1 | Run `Morphio-Setup-<version>.exe` on a clean user account | Installs without administrator rights, folder choice, shortcuts on the desktop and in the Start menu | |
| 0.2 | Start Morphio from the shortcut | The window appears in 1–3 seconds | |
| 0.3 | Open a new console, type `morphio --version` | The version is printed (the program folder is in PATH) | |
| 0.4 | Install over an older version | Settings and modules are kept | |
| 0.5 | Uninstall in "Settings → Apps" | Asks about settings and modules; shortcuts are gone; `morphio` is removed from PATH | |
| 0.6 | Run `Morphio-Portable-<version>.exe` | Works without installing (the first start is slow: unpacking) | |

### 1. Files and paths

| № | File | What to do | Expected | Result |
|---|---|---|---|---|
| 1.1 | iPhone photo (HEIC) | To JPG and WebP | Opens, rotated correctly, date and GPS removed (unless "Keep" is on) | |
| 1.2 | Large photo 20+ MP | To WebP, then before/after | Does not hang, the slider is smooth | |
| 1.3 | File with a Russian name and spaces in the path, e.g. `D:\Мои фото\отпуск 2026.jpg` | Any conversion | The result is next to it, the name is kept | |
| 1.4 | A drive other than `C:` and a network folder | Convert and save | Works; an unavailable path gives a clear message | |
| 1.5 | The original | After any operation | Not changed (same size and date) | |

### 2. Background and GIF

| № | File | What to do | Expected | Result |
|---|---|---|---|---|
| 2.1 | Sprite sheet with a pink or green background | "Remove background", method "Solid colour" | Transparent background, no pink edge | |
| 2.2 | Photo of a person or animal | Method "Neural network" (after downloading the model) | Clean outline, hair not eaten | |
| 2.3 | The result of 2.2 | "Edit with brush" → "Fill" on leftover background → Ctrl+Z → Ctrl+Y → save | The area is removed and restored, the file is saved | |
| 2.4 | Your own GIF | Open in the studio, add text with "Fade in" animation, save GIF and WebP | The text appears smoothly, the file size is reasonable | |
| 2.5 | 5–10 second video | Make a GIF from video (a piece, 12 fps) | Speed as in the video | |

### 3. Video and audio

| № | File | What to do | Expected | Result |
|---|---|---|---|---|
| 3.1 | Phone video (vertical) | Trim, "Fast" and "Accurate" | Correct size, sound in place | |
| 3.2 | The same video | Rotate 90° in "Fast" mode (flag) | Opens in Windows and in a player rotated correctly | |
| 3.3 | Two clips | Join with the "Fade" transition | The transition is visible, the sound does not break | |
| 3.4 | Clip with pauses in speech | "Remove silence" | Pauses are cut, words are not clipped | |
| 3.5 | Clip + `.srt` file | Subtitles "As a track" and "Burned in" | Switchable in a player; burned ones are visible, Cyrillic is readable | |
| 3.6 | MP3 song with cover | To FLAC and M4A | Tags and cover are kept | |
| 3.7 | Quiet clip | Loudness "Standard −16 LUFS" | Clearly louder, no crackle | |

### 4. Documents, PDF, neural networks

| № | File | What to do | Expected | Result |
|---|---|---|---|---|
| 4.1 | DOCX with a table and a picture | To PDF and EPUB | Look is kept; the first time it offers to download Pandoc | |
| 4.2 | Multi-page PDF | To text, to PNG, split, merge | All options work | |
| 4.3 | Page scan (also one lying on its side) | "Recognise text" (after downloading languages) | Text is readable, the page turned by itself | |
| 4.4 | 1–2 minute speech recording | "SRT subtitles" (after downloading the model) | Timing and text are right; "Edit subtitles" opens the editor | |
| 4.5 | Small photo | "Enlarge ×2" | Visibly sharper, no seams | |

### 5. Window, tray, system

| № | What to do | Expected | Result |
|---|---|---|---|
| 5.1 | Close and reopen the app | The tab, window size, format and quality are remembered | |
| 5.2 | Turn on the tray and "close to tray" | Tray icon, the window hides, the tray menu works | |
| 5.3 | Turn on the quick window, press `Ctrl+Shift+X` with files selected | The window with options appears, a digit starts one | |
| 5.4 | Turn on the Explorer menu, right-click a file | "Convert in Morphio" is there (under "Show more options" on Windows 11) | |
| 5.5 | Watched folder | New files are converted by themselves | |
| 5.6 | Dark and light theme, Russian and English | Everything is readable, no clipped labels | |
| 5.7 | Settings → "Report a problem" | A new GitHub issue page opens with the version and environment | |
| 5.8 | Settings → "Open the log folder" | The `logs` folder opens; your user name is not in the file | |
| 5.9 | Settings → "Reset settings" | Asks for confirmation; everything is default after the reset | |
| 5.10 | Settings → "Updates" | The switch is off by default; "Check now" works on the installed version | |

### 6. Command line

```powershell
morphio --help
morphio convert photo.png --to webp
morphio media video.mp4 --trim 0:05-0:10 --rotate 90
morphio gif video.mp4 --fps 10 --width 480
morphio convert subs.srt --to vtt --shift 2
morphio doctor
```
Expected: result paths in the output, exit code 0 on success and 1–3 on errors, originals untouched.

### Result
All items ✔? If not: item numbers, version and the log (Settings → About and data) go into a GitHub issue.

## Русский

Автоматические тесты (`npm run check`, `npm run e2e`) проверяют логику и окно на сгенерированных файлах. Этот список проверяет то, что видно только на реальных файлах и на чистой Windows. Для каждого пункта запишите, что ожидалось и что увидели. Отметка: ✔ — как ожидалось, ✘ — нет (опишите).

Версия: ______  Windows: ______  Установщик / портативная: ______  Видеокарта: ______  Дата: ______

### 0. Установка

| № | Что сделать | Ожидается | Результат |
|---|---|---|---|
| 0.1 | Запустить `Morphio-Setup-<версия>.exe` на чистой учётной записи | Установка без прав администратора, выбор папки, ярлыки на рабочем столе и в меню «Пуск» | |
| 0.2 | Запустить Morphio с ярлыка | Окно появляется за 1–3 секунды | |
| 0.3 | Открыть новую консоль, набрать `morphio --version` | Печатается версия (папка программы добавлена в PATH) | |
| 0.4 | Установить поверх старой версии | Настройки и модели на месте | |
| 0.5 | Удалить программу через «Параметры → Приложения» | Спрашивает про настройки и модули; ярлыки исчезли; `morphio` из PATH убран | |
| 0.6 | Запустить `Morphio-Portable-<версия>.exe` | Работает без установки (первый запуск медленный: распаковка) | |

### 1. Файлы и пути

| № | Файл | Что сделать | Ожидается | Результат |
|---|---|---|---|---|
| 1.1 | Фото с iPhone (HEIC) | В JPG и WebP | Открывается, повёрнуто правильно, дата и GPS убраны (если не включено «Оставить») | |
| 1.2 | Большое фото 20+ Мп | В WebP, затем «до и после» | Не зависает, слайдер плавный | |
| 1.3 | Файл с русским именем и пробелами в пути, например `D:\Мои фото\отпуск 2026.jpg` | Любая конвертация | Результат рядом, имя сохранено | |
| 1.4 | Диск не `C:` и сетевая папка | Конвертация и сохранение | Работает; недоступный путь даёт понятное сообщение | |
| 1.5 | Оригинал | После любой операции | Не изменён (размер и дата те же) | |

### 2. Фон и GIF

| № | Файл | Что сделать | Ожидается | Результат |
|---|---|---|---|---|
| 2.1 | Спрайт-лист с розовым или зелёным фоном | «Удалить фон», метод «Однотонный» | Фон прозрачный, розовой каймы нет | |
| 2.2 | Фото человека или животного | Метод «Нейросеть» (после скачивания модели) | Контур чистый, волосы не «съедены» | |
| 2.3 | Результат из 2.2 | «Править кистью» → «Заливка» по остаткам фона → Ctrl+Z → Ctrl+Y → сохранить | Область убирается и возвращается, файл сохранён | |
| 2.4 | Свой GIF | Открыть в студии, добавить текст с анимацией «Появление», сохранить GIF и WebP | Текст появляется плавно, размер файла разумный | |
| 2.5 | Видео 5–10 секунд | Создать GIF из видео (отрезок, 12 кадр/с) | Скорость как в видео | |

### 3. Видео и звук

| № | Файл | Что сделать | Ожидается | Результат |
|---|---|---|---|---|
| 3.1 | Видео с телефона (вертикальное) | Обрезка, «Быстро» и «Точно» | Размер верный, звук на месте | |
| 3.2 | То же видео | Поворот на 90° в режиме «Быстро» (метка) | Открывается в Windows и в плеере повёрнутым правильно | |
| 3.3 | Два ролика | Склейка с переходом «Плавное затухание» | Переход виден, звук не рвётся | |
| 3.4 | Ролик с паузами в речи | «Убрать тишину» | Паузы вырезаны, слова не обрезаны | |
| 3.5 | Ролик + файл `.srt` | Субтитры «Дорожкой» и «В картинку» | В плеере включаются; вшитые видны, кириллица читается | |
| 3.6 | Песня MP3 с обложкой | В FLAC и в M4A | Теги и обложка сохранены | |
| 3.7 | Тихий ролик | Громкость «По стандарту −16 LUFS» | Заметно громче, без треска | |

### 4. Документы, PDF, нейросети

| № | Файл | Что сделать | Ожидается | Результат |
|---|---|---|---|---|
| 4.1 | DOCX с таблицей и картинкой | В PDF и в EPUB | Вид сохранён; при первом разе предлагается скачать Pandoc | |
| 4.2 | PDF из нескольких страниц | В текст, в PNG, разделить, склеить | Все варианты работают | |
| 4.3 | Скан страницы (в том числе повёрнутый боком) | «Распознать текст» (после скачивания языков) | Текст читается, страница повернулась сама | |
| 4.4 | Запись речи 1–2 минуты | «Субтитры SRT» (после скачивания модели) | Время и текст верные; «Править субтитры» открывает редактор | |
| 4.5 | Маленькое фото | «Увеличить ×2» | Заметно чётче, без швов | |

### 5. Окно, трей, система

| № | Что сделать | Ожидается | Результат |
|---|---|---|---|
| 5.1 | Закрыть и снова открыть приложение | Запомнились вкладка, размер окна, формат и качество | |
| 5.2 | Включить трей, «закрывать в трей» | Значок в трее, окно прячется, меню трея работает | |
| 5.3 | Включить быстрое окно, нажать `Ctrl+Shift+X` с выделенными файлами | Появляется окно с вариантами, цифра запускает | |
| 5.4 | Включить меню Проводника, правый клик по файлу | Есть «Конвертировать в Morphio» (в «Показать дополнительные параметры» на Windows 11) | |
| 5.5 | Следящая папка | Новые файлы конвертируются сами | |
| 5.6 | Тёмная и светлая тема, русский и английский | Всё читается, нет обрезанных надписей | |
| 5.7 | Настройки → «Сообщить о проблеме» | Открывается страница нового обращения на GitHub с версией и окружением | |
| 5.8 | Настройки → «Открыть папку журнала» | Открывается папка `logs`; в файле нет вашего имени пользователя | |
| 5.9 | Настройки → «Сбросить настройки» | Спрашивает подтверждение; после сброса всё по умолчанию | |
| 5.10 | Настройки → «Обновления» | Переключатель по умолчанию выключен; «Проверить сейчас» работает у установленной версии | |

### 6. Командная строка

```powershell
morphio --help
morphio convert photo.png --to webp
morphio media video.mp4 --trim 0:05-0:10 --rotate 90
morphio gif video.mp4 --fps 10 --width 480
morphio convert subs.srt --to vtt --shift 2
morphio doctor
```
Ожидается: пути результатов в выводе, коды завершения 0 (успех) и 1–3 (ошибки), оригиналы не тронуты.

### Итог
Все пункты ✔? Если нет: номера пунктов, версия и журнал (Настройки → О программе и данные) — в обращение на GitHub.
