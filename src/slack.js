import {WebClient, RTMClient} from '@slack/client'
import {createMessageAdapter} from '@slack/interactive-messages'
import request from 'request-promise'
import logger from 'winston'

const state = {}
const dmQueue = {}

const DM_CALLBACK_ID = 'dm_finish'
const DM_ACTION = 'action'
const DM_ACTION_SUBMIT = 'submit'
const DM_ACTION_CANCEL = 'cancel'
const DM_REQUEST_MESSAGE_LIMIT = 10

export async function init(apiConfig, botConfig) {
  state.botConfig = botConfig

  await prepareState(apiConfig)

  const {rtm, interactions} = state

  rtm
    .on('message', handleDMAdd)
    .on('message::message_changed', handleDMEdit)
    .on('message::message_deleted', handleDMRemove)

  interactions.action(DM_CALLBACK_ID, handleDMCallback)

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
  state.rtm = new RTMClient(botToken)
  state.web = new WebClient(botToken)
  state.interactions = createMessageAdapter(signingSecret)
  state.req = request.defaults({
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
  })

  state.rtm.start()

  state.bot = await callApi(() => state.web.users.info({user: botId}), 'user')
}

async function handleDMAdd(event) {
  const {bot} = state
  const {subtype, channel, user, thread_ts: thread} = event

  if (subtype || thread || !channel.startsWith('D') || user === bot.id) {
    return
  }

  if (!dmQueue[user]) {
    dmQueue[user] = {channel, items: [], responseTS: null}
  }

  const queue = dmQueue[user]

  queue.items.push(event)

  await updateDMResponse(queue)
    .catch((err) => handleDMError('Failed to add DM queue item', user, err))
}

async function handleDMEdit(event) {
  const {bot} = state
  const {message, channel} = event
  const {user, ts} = message

  if (!channel.startsWith('D') || user === bot.id) {
    return
  }

  const queue = dmQueue[user]

  if (!queue || !queue.items.find((item) => item.ts === ts)) {
    return
  }

  queue.items = queue.items.map((item) => item.ts === ts ? message : item)

  await updateDMResponse(queue)
    .catch((err) => handleDMError('Failed to edit DM queue item', user, err))
}

async function handleDMRemove(event) {
  const {channel, previous_message: message} = event
  const {user, ts} = message

  if (!channel.startsWith('D')) {
    return
  }

  const queue = dmQueue[user]

  if (!queue) {
    return
  }

  if (queue.responseTS === ts) { // user removed bot's message, probably wants to cancel request
    dmQueue[user] = null
    return
  }

  if (!queue.items.find((item) => item.ts === ts)) {
    return
  }

  queue.items = queue.items.filter((item) => item.ts !== ts)

  await updateDMResponse(queue)
    .catch((err) => handleDMError('Failed to remove DM queue item', user, err))
}

async function updateDMResponse(queue) {
  await deleteDMResponse(queue)

  if (queue.items.length === 0) {
    return
  }

  if (queue.items.length > DM_REQUEST_MESSAGE_LIMIT) {
    await sendDMResponse(queue, {text: `:no_entry_sign: Too many request messages. One request can contain up to ${DM_REQUEST_MESSAGE_LIMIT} messages.`})
  } else {
    await sendDMResponse(queue, {
      text: getRequestText(queue.items),
      attachments: [
        {
          text: 'Do you want to send this request to office team?\n(you can add more messages or update/remove existing messages in the request)',
          color: '#439FE0',
          callback_id: DM_CALLBACK_ID,
          actions: [
            {
              name: DM_ACTION,
              text: 'Send request',
              type: 'button',
              value: DM_ACTION_SUBMIT,
              style: 'primary',
            },
            {
              name: DM_ACTION,
              text: 'Cancel',
              type: 'button',
              value: DM_ACTION_CANCEL,
            },
          ],
        },
      ],
    })
  }
}

function getRequestText(items, fileMapper = (file) => file) {
  return items.reduce(
    (lines, item) => lines.concat(
      item.text,
      item.files
        ? item.files.map(fileMapper).filter(Boolean).map((file) => `${file.title}: ${file.permalink}`)
        : []
    ),
    [],
  ).join('\n')
}

async function sendDMResponse(queue, msg) {
  const {web} = state

  const resp = await callApi(() => web.chat.postMessage({
    channel: queue.channel,
    ...msg,
  }), 'message').catch((err) => {
    logger.error('Failed to update DM response', err)
  })

  queue.responseTS = (resp && resp.ts) || null
}

async function handleDMError(msg, user, err) {
  const {web} = state

  logger.error(msg, err)

  const queue = dmQueue[user]

  dmQueue[user] = null

  await deleteDMResponse(queue)

  await web.chat.postMessage({
    channel: queue.channel,
    text: ':dissapointed: Sorry, something went wrong. Please try again or contact support.',
  })
}

async function deleteDMResponse(queue) {
  const {web} = state
  const {channel, responseTS} = queue

  if (!responseTS) {
    return
  }

  queue.responseTS = null

  await web.chat
    .delete({channel, ts: responseTS})
    .catch((err) => logger.error('Failed to delete DM response', err))
}

function handleDMCallback(payload, respond) {
  const {actions, user: {id: user}, original_message: message} = payload

  const queue = dmQueue[user]

  if (!queue) {
    return {
      text: ':confusedparrot: Sorry, I don\'t remember this request. Please try again or contact support.',
    }
  }

  const submit = actions.reduce(
    (res, action) => (action.name === DM_ACTION ? action.value === DM_ACTION_SUBMIT : res),
    false,
  )

  if (!submit) {
    dmQueue[user] = null

    return {
      text: ':aargh: Ok, request was cancelled',
    }
  }

  forwardDM(queue, user, respond).catch((err) => {
    logger.error('Failed to forward DM message', err)

    respond({text: ':disappointed: Sorry, something went wrong. Please try again or contact support.'})

    setTimeout(() => updateDMResponse(queue), 5000)
  })

  message.attachments = [{text: ':hourglass_flowing_sand: Sending request, please wait...'}]

  return message
}

async function forwardDM(queue, user, respond) {
  const {web, botConfig} = state

  const allFiles = [].concat(...queue.items.map((item) => item.files || []))
  const filesMap = await reuploadFiles(allFiles)

  await web.chat.postMessage({
    text: `<@${user}> &gt; ${getRequestText(queue.items, (file) => filesMap[file.id])}`,
    channel: botConfig.notificationChannel,
  })

  respond({text: ':heavy_check_mark: Request was sent to office team, thanks'})

  dmQueue[user] = null
}

async function reuploadFiles(files) {
  const {botConfig} = state
  const filesMap = {}

  if (files.length === 0) {
    return filesMap
  }

  const processFile = async (file) => {
    const newFile = await reuploadSingleFile(file).catch((err) => {
      logger.error('Failed to upload file', err)

      return null
    })

    if (newFile) {
      filesMap[file.id] = newFile
    }

    return newFile
  }

  if (!state.shareThreadTs) {
    const firstFile = files.shift()

    const firstNewFile = await processFile(firstFile)

    if (firstNewFile) {
      state.shareThreadTs = firstNewFile.shares.private[botConfig.notificationChannel][0].ts
    }
  }

  await Promise.all(files.map(processFile))

  return filesMap
}

async function reuploadSingleFile(file) {
  const {req, web, botConfig, shareThreadTs} = state

  const content = await req({
    uri: file.url_private,
    method: 'GET',
    encoding: null,
  })

  const newFile = await callApi(() => web.files.upload({
    channels: botConfig.notificationChannel,
    thread_ts: shareThreadTs,
    filename: file.name,
    file: Buffer.from(content, 'binary'),
    filetype: file.filetype,
    title: file.title,
  }), 'file')

  return newFile
}
