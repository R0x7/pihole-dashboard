/// <reference types="vite/client" />
import type { RendererApi } from '@shared/contract'

declare global {
  interface Window {
    pihole: RendererApi
  }
}

export {}
