import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { GeminiEngine } from './engine/gemini.js'

async function main() {
  const config = loadConfig()
  const { app, manager } = await buildApp({
    config,
    engine: new GeminiEngine(config.geminiApiKey, config.geminiModel, {
      debug: (o, msg) => app.log.debug(o, msg),
      info: (o, msg) => app.log.info(o, msg),
      warn: (o, msg) => app.log.warn(o, msg),
    }),
    logger: { level: config.logLevel },
  })

  const stopReaper = manager.startReaper()

  // Stop every Gemini stream before exiting so a redeploy doesn't leave paid sessions running.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    stopReaper()
    manager.endAll()
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info({ model: config.geminiModel }, 'dubbing backend ready')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
