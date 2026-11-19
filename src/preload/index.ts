import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MorphioApi, GifProgress, JobProgress, ModelDownloadProgress, ModuleProgress, MontageProgress, UpdateState } from '@shared/types'

const api: MorphioApi = {
  watchStatus: () => ipcRenderer.invoke('watch:status'),
  targetsForKind: (kind) => ipcRenderer.invoke('any:targets-for-kind', kind),
  onOpenFiles: (callback) => {
    const listener = (_: unknown, paths: string[]): void => callback(paths)
    ipcRenderer.on('app:open-files', listener)
    return () => ipcRenderer.removeListener('app:open-files', listener)
  },
  onQuickFiles: (callback) => {
    const listener = (_: unknown, paths: string[]): void => callback(paths)
    ipcRenderer.on('quick:files', listener)
    return () => ipcRenderer.removeListener('quick:files', listener)
  },
  quickClose: () => ipcRenderer.invoke('quick:close'),
  quickOpenMain: (paths) => ipcRenderer.invoke('quick:open-main', paths),
  quickReady: () => ipcRenderer.invoke('quick:ready'),
  quickRemember: (target) => ipcRenderer.invoke('quick:remember', target),
  takeOpenFiles: () => ipcRenderer.invoke('app:take-open-files'),
  pickAny: () => ipcRenderer.invoke('any:pick'),
  pickAnyFolder: () => ipcRenderer.invoke('any:pick-folder'),
  inspectAny: (paths) => ipcRenderer.invoke('any:inspect', paths),
  universalTargets: (items) => ipcRenderer.invoke('any:targets', items),
  universalConvert: (items, options) => ipcRenderer.invoke('any:convert', items, options),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
  openLogsFolder: () => ipcRenderer.invoke('log:open-folder'),
  logRendererError: (message, stack) => ipcRenderer.invoke('log:renderer-error', message, stack),
  updatesState: () => ipcRenderer.invoke('updates:state'),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesDownload: () => ipcRenderer.invoke('updates:download'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  updatesDismiss: () => ipcRenderer.invoke('updates:dismiss'),
  onUpdateState: (cb) => {
    const h = (_: unknown, s: UpdateState): void => cb(s)
    ipcRenderer.on('updates:state-changed', h)
    return () => ipcRenderer.removeListener('updates:state-changed', h)
  },
  reportProblem: (note) => ipcRenderer.invoke('log:report', note),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  inspectFiles: (paths) => ipcRenderer.invoke('files:inspect', paths),
  removeBackground: (items, options) => ipcRenderer.invoke('bg:start', items, options),
  mediaCapabilities: () => ipcRenderer.invoke('media:caps'),
  pickVideo: () => ipcRenderer.invoke('video:pick'),
  videoInfo: (path) => ipcRenderer.invoke('video:info', path),
  videoPoster: (path, time, maxSide) => ipcRenderer.invoke('video:poster', path, time, maxSide),
  extractVideoFrames: (options) => ipcRenderer.invoke('video:extract', options),
  inspectFrames: (paths) => ipcRenderer.invoke('gif:inspect', paths),
  buildGif: (frames, options) => ipcRenderer.invoke('gif:build', frames, options),
  stickerImage: (path, maxSide) => ipcRenderer.invoke('gif:sticker', path, maxSide),
  exportFrames: (frames, outputDir, extra) => ipcRenderer.invoke('gif:export', frames, outputDir, extra),
  onGifProgress: (callback) => {
    const listener = (_: unknown, p: GifProgress): void => callback(p)
    ipcRenderer.on('gif:progress', listener)
    return () => ipcRenderer.removeListener('gif:progress', listener)
  },
  runChain: (items, config) => ipcRenderer.invoke('chain:start', items, config),
  previewImage: (path, maxSide) => ipcRenderer.invoke('files:preview', path, maxSide),
  montagePickVideos: () => ipcRenderer.invoke('montage:pick-videos'),
  montagePickSubtitles: () => ipcRenderer.invoke('montage:pick-subs'),
  montageInspect: (paths) => ipcRenderer.invoke('montage:inspect', paths),
  montageSilence: (path, noiseDb, minSilence) => ipcRenderer.invoke('montage:silence', path, noiseDb, minSilence),
  montageStrip: (path, count, height) => ipcRenderer.invoke('montage:strip', path, count, height),
  montageRun: (plan) => ipcRenderer.invoke('montage:run', plan),
  onMontageProgress: (callback) => {
    const listener = (_: unknown, p: MontageProgress): void => callback(p)
    ipcRenderer.on('montage:progress', listener)
    return () => ipcRenderer.removeListener('montage:progress', listener)
  },
  subtitlesLoad: (path) => ipcRenderer.invoke('subs:load', path),
  subtitlesSave: (path, cues) => ipcRenderer.invoke('subs:save', path, cues),
  compare: (inputPath, outputPath, time) => ipcRenderer.invoke('compare:pair', inputPath, outputPath, time),
  openMaskEditor: (item, options) => ipcRenderer.invoke('bg:edit-open', item, options),
  saveMaskEdit: (item, options, strokes, outputPath) =>
    ipcRenderer.invoke('bg:edit-save', item, options, strokes, outputPath),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  downloadModel: () => ipcRenderer.invoke('model:download'),
  modulesList: () => ipcRenderer.invoke('modules:list'),
  modulesInstall: (id) => ipcRenderer.invoke('modules:install', id),
  modulesRemove: (id) => ipcRenderer.invoke('modules:remove', id),
  calibreFound: () => ipcRenderer.invoke('modules:calibre'),
  onModuleProgress: (callback) => {
    const listener = (_: unknown, p: ModuleProgress): void => callback(p)
    ipcRenderer.on('modules:progress', listener)
    return () => ipcRenderer.removeListener('modules:progress', listener)
  },
  onModelDownload: (callback) => {
    const listener = (_: unknown, p: ModelDownloadProgress): void => callback(p)
    ipcRenderer.on('model:progress', listener)
    return () => ipcRenderer.removeListener('model:progress', listener)
  },
  cancel: () => ipcRenderer.invoke('convert:cancel'),
  onProgress: (callback) => {
    const listener = (_: unknown, progress: JobProgress): void => callback(progress)
    ipcRenderer.on('convert:progress', listener)
    return () => ipcRenderer.removeListener('convert:progress', listener)
  },
  revealInFolder: (path) => ipcRenderer.invoke('shell:reveal', path)
}

contextBridge.exposeInMainWorld('api', api)
