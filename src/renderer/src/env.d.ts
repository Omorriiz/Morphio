/// <reference types="vite/client" />
import type { MorphioApi } from '@shared/types'

declare global {
  interface Window {
    api: MorphioApi
  }
}

export {}
