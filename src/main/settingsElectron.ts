import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { SettingsStore, type Cipher } from './settings'

const safeStorageCipher: Cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data)
}

/** Call after app 'ready' (safeStorage is not usable before that). */
export function createElectronSettingsStore(): SettingsStore {
  return new SettingsStore(join(app.getPath('userData'), 'settings.json'), safeStorageCipher)
}
