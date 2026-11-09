import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type RendererApi } from '@shared/contract'

const api: RendererApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (input) => ipcRenderer.invoke(IPC.saveSettings, input),
  testConnection: (input) => ipcRenderer.invoke(IPC.testConnection, input),
  getDashboard: () => ipcRenderer.invoke(IPC.getDashboard)
}

contextBridge.exposeInMainWorld('pihole', api)
