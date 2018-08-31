import {WebClient, RTMClient} from '@slack/client'
import {createMessageAdapter} from '@slack/interactive-messages'

export async function init(apiConfig, botConfig) {
  const state = await prepareState(apiConfig)

  state.botConfig = botConfig

  const {rtm, interactions} = state

  rtm.on('message', handleDM(state))

  return {
    state,
    interactionsMiddleware: () => interactions.expressMiddleware(),
  }
}

async function callApi(apiCall, dataField) {
  const resp = await apiCall()

  if (!resp.ok) {
    throw new Error(`Failed to load data: ${resp.error}`)
  }

  return resp[dataField]
}

async function prepareState({botId, botToken, signingSecret}) {
  const rtm = new RTMClient(botToken)
  const web = new WebClient(botToken)
  const interactions = createMessageAdapter(signingSecret)

  rtm.start()

  const bot = await callApi(() => web.users.info({user: botId}), 'user')

  return {rtm, web, interactions, bot}
}

function handleDM(state) {
  const {rtm, botConfig} = state

  return async ({channel, user, text, edited}) => {
    if (edited || !channel.startsWith('D')) {
      return
    }

    await rtm.sendMessage(`<@${user}> &gt; ${text}`, botConfig.notificationChannel)

    await rtm.sendMessage('Thanks, office team was notified', channel)
  }
}
