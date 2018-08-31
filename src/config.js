import transenv from 'transenv'

export default transenv()(({str, bool, num}) => {
  const env = str('NODE_ENV', 'development')
  const isDevelopment = env === 'development'

  return {
    env,
    logLevel: str('log_level', isDevelopment ? 'debug' : 'error'),
    port: str('PORT'),
    slack: {
      botId: str('slack_bot_id'),
      botToken: str('slack_bot_token'),
      signingSecret: str('slack_signing_secret'),
    },
    notificationChannel: str('notification_channel'),
  }
})
