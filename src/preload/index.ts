import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MorphioApi, GifProgress, JobProgress, ModelDownloadProgress } from '@shared/types'

const api: MorphioApi = {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  inspectFiles: (paths) => ipcRenderer.invoke('files:inspect', paths),
  convert: (items, options) => ipcRenderer.invoke('convert:start', items, options),
  removeBackground: (items, options) => ipcRenderer.invoke('bg:start', items, options),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  inspectMedia: (paths) => ipcRenderer.invoke('media:inspect', paths),
  mediaCapabilities: () => ipcRenderer.invoke('media:caps'),
  convertMedia: (items, options) => ipcRenderer.invoke('media:convert', items, options),
  pickVideo: () => ipcRenderer.invoke('video:pick'),
  videoInfo: (path) => ipcRenderer.invoke('video:info', path),
  videoPoster: (path, time, maxSide) => ipcRenderer.invoke('video:poster', path, time, maxSide),
  extractVideoFrames: (options) => ipcRenderer.invoke('video:extract', options),
  inspectFrames: (paths) => ipcRenderer.invoke('gif:inspect', paths),
  buildGif: (frames, options) => ipcRenderer.invoke('gif:build', frames, options),
  exportFrames: (frames, outputDir) => ipcRenderer.invoke('gif:export', frames, outputDir),
  onGifProgress: (callback) => {
    const listener = (_: unknown, p: GifProgress): void => callback(p)
    ipcRenderer.on('gif:progress', listener)
    return () => ipcRenderer.removeListener('gif:progress', listener)
  },
  runPipeline: (items, config) => ipcRenderer.invoke('pipeline:start', items, config),
  previewImage: (path, maxSide) => ipcRenderer.invoke('files:preview', path, maxSide),
  openMaskEditor: (item, options) => ipcRenderer.invoke('bg:edit-open', item, options),
  saveMaskEdit: (item, options, strokes, outputPath) =>
    ipcRenderer.invoke('bg:edit-save', item, options, strokes, outputPath),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  downloadModel: () => ipcRenderer.invoke('model:download'),
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
