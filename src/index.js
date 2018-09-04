import c from './config'
import express from 'express'
import logger from 'winston'
import {init as initSlack} from './slack'

  ;(async function() {
  logger.cli()
  logger.level = c.logLevel
  logger.setLevels(logger.config.npm.levels)

  const app = express()

  const slackClient = await initSlack(c.slack, {
    notificationChannel: c.notificationChannel,
  })

  app.use('/actions', slackClient.interactionsMiddleware())

  app.listen(c.port, () => {
    logger.log('info', `App started on localhost:${c.port}.`)
    // eslint-disable-next-line no-console
    console.log('App ready')
  })
})().catch((e) => {
  logger.log('error', e)
  process.exit(1)
})
