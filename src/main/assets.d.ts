// electron-vite: файл с суффиксом ?asset копируется в сборку, импорт возвращает путь к нему.
declare module '*?asset' {
  const path: string
  export default path
}
