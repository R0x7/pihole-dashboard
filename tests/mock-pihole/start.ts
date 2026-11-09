// Standalone mock Pi-hole for UI demos: `npm run mock`.
import { startMockPihole } from './server.ts'

const PORT = 8089
const PASSWORD = 'test-password'

const mock = await startMockPihole({ port: PORT, password: PASSWORD })
console.log(`Mock Pi-hole v6 API listening at ${mock.url}`)
console.log(`Password: ${PASSWORD}`)
console.log('Press Ctrl+C to stop.')

process.on('SIGINT', () => {
  void mock.close().then(() => process.exit(0))
})
