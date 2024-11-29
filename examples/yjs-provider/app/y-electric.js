/**
 * @module provider/electric
 */

import * as time from "lib0/time"
import { toBase64 } from "lib0/buffer"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import * as syncProtocol from "y-protocols/sync"
import * as awarenessProtocol from "y-protocols/awareness"
import { Observable } from "lib0/observable"
import * as env from "lib0/environment"
import * as Y from "yjs"

export const messageSync = 0
export const messageAwareness = 1

import { isChangeMessage, ShapeStream } from "@electric-sql/client"
import { parseToDecoder as parser } from "./utils"

/**
 * @param {ElectricProvider} provider
 */
const setupShapeStream = (provider) => {
  if (provider.shouldConnect && provider.operationsStream === null) {
    provider.connecting = true
    provider.connected = false
    provider.synced = false

    provider.operationsStream = new ShapeStream({
      url: provider.operationsUrl,
      table: `ydoc_operations`,
      where: `room = '${provider.roomname}'`,
      parser,
      ...provider.resume.operations,
    })

    provider.awarenessStream = new ShapeStream({
      url: provider.awarenessUrl,
      where: `room = '${provider.roomname}'`,
      table: `ydoc_awareness`,
      parser,
      ...provider.resume.awareness,
    })

    const handleSyncMessage = (messages) => {
      console.log(messages)
      provider.lastMessageReceived = time.getUnixTime()
      messages.forEach((message) => {
        if (isChangeMessage(message) && message.value.op) {
          const decoder = message.value.op
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageSync)
          const syncMessageType = syncProtocol.readSyncMessage(
            decoder,
            encoder,
            provider.doc,
            provider
          )
          if (
            syncMessageType === syncProtocol.messageYjsSyncStep2 &&
            !provider.synced
          ) {
            provider.synced = true
          }
        }
      })
    }

    const handleAwarenessMessage = (messages) => {
      provider.lastMessageReceived = time.getUnixTime()
      messages.forEach((message) => {
        // sometimes buffer is empty
        if (isChangeMessage(message) && message.value.op) {
          const decoder = message.value.op
          awarenessProtocol.applyAwarenessUpdate(
            provider.awareness,
            decoding.readVarUint8Array(decoder),
            provider
          )
        }
      })
    }

    const unsubscribeSyncHandler =
      provider.operationsStream.subscribe(handleSyncMessage)

    const unsubscribeAwarenessHandler = provider.awarenessStream.subscribe(
      handleAwarenessMessage
    )

    provider.disconnectHandler = (event) => {
      provider.operationsStream = null
      provider.awarenessStream = null
      provider.connecting = false
      if (provider.connected) {
        provider.connected = false

        provider.synced = false

        awarenessProtocol.removeAwarenessStates(
          provider.awareness,
          Array.from(provider.awareness.getStates().keys()).filter(
            (client) => client !== provider.doc.clientID
          ),
          provider
        )
        provider.lastSyncedStateVector = Y.encodeStateVector(provider.doc)
        provider.emit(`status`, [{ status: `disconnected` }])
      }

      unsubscribeSyncHandler()
      unsubscribeAwarenessHandler()
      provider.disconnectHandler = null
      provider.emit(`connection-close`, [event, provider])
    }

    const handleOperationsFirstSync = () => {
      provider.lastMessageReceived = time.getUnixTime()
      provider.connecting = false
      provider.connected = true

      if (provider.modifiedWhileOffline) {
        const pendingUpdates = Y.encodeStateAsUpdate(
          provider.doc,
          provider.lastSyncedStateVector
        )
        const encoderState = encoding.createEncoder()
        syncProtocol.writeUpdate(encoderState, pendingUpdates)

        sendOperation(provider, pendingUpdates)
          .then(() => clearLastSyncedStateVector(provider))
          .then(() => {
            provider.emit(`status`, [{ status: `connected` }])
          })
      }
    }

    provider.operationsStream.subscribeOnceToUpToDate(
      handleOperationsFirstSync.bind(this)
    )

    const handleAwarenessFirstSync = () => {
      if (provider.awareness.getLocalState() !== null) {
        sendAwareness(provider, [provider.doc.clientID])
      }
    }

    provider.awarenessStream.subscribeOnceToUpToDate(
      handleAwarenessFirstSync.bind(this)
    )

    provider.emit(`status`, [{ status: `connecting` }])
  }
}

const saveLastSyncedStateVector = (provider) => {
  provider.modifiedWhileOffline = true
}

const clearLastSyncedStateVector = async (provider) => {
  provider.lastSyncedStateVector = null
  provider.modifiedWhileOffline = false
}

const sendOperation = async (provider, update) => {
  // ignore requests that have no changes
  // there is probably a better way of checking this
  if (update.length <= 2) {
    return
  }

  if (!provider.connected) {
    if (!provider.modifiedWhileOffline) {
      return saveLastSyncedStateVector(provider, update)
    }
    return
  }

  const encoder = encoding.createEncoder()
  syncProtocol.writeUpdate(encoder, update)
  const op = toBase64(encoding.toUint8Array(encoder))
  const room = provider.roomname

  return fetch(`/api/operation`, {
    method: `POST`,
    body: JSON.stringify({ room, op }),
  })
}

const sendAwareness = (provider, changedClients) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(provider.awareness, changedClients)
  )
  const op = toBase64(encoding.toUint8Array(encoder))

  if (provider.connected) {
    const room = provider.roomname
    const clientId = `${provider.doc.clientID}`

    fetch(`/api/operation`, {
      method: `POST`,
      body: JSON.stringify({ clientId, room, op }),
    })
  }
}

export class ElectricProvider extends Observable {
  /**
   * @param {string} serverUrl
   * @param {string} roomname
   * @param {Y.Doc} doc
   * @param {object} opts
   * @param {boolean} [opts.connect]
   * @param {awarenessProtocol.Awareness} [opts.awareness]
   * @param {Object<string, {offset: string, shapeHandle: string} >} [opts.resume]
   */
  constructor(
    serverUrl,
    roomname,
    doc,
    { connect = false, awareness = null, resume = {} } = {}
  ) {
    super()

    this.serverUrl = serverUrl
    this.roomname = roomname
    this.doc = doc
    this.awareness = awareness
    this.connected = false
    this.connecting = false
    this._synced = false

    this.lastMessageReceived = 0
    this.shouldConnect = connect

    this.operationsStream = null
    this.awarenessStream = null

    this.lastSyncedStateVector = null
    this.modifiedWhileOffline = false
    this.resume = resume ?? {}

    this.disconnectHandler = null

    this._updateHandler = (update, origin) => {
      if (origin !== this) {
        sendOperation(this, update)
      }
    }
    this.doc.on(`update`, this._updateHandler)

    /**
     * @param {any} changed
     * @param {any} origin
     */
    this._awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      if (origin === `local`) {
        const changedClients = added.concat(updated).concat(removed)
        sendAwareness(this, changedClients)
      }
    }

    this._exitHandler = () => {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [doc.clientID],
        `app closed`
      )
    }
    if (env.isNode && typeof process !== `undefined`) {
      process.on(`exit`, this._exitHandler)
    }
    awareness?.on(`update`, this._awarenessUpdateHandler)

    if (connect) {
      this.connect()
    }
  }

  get operationsUrl() {
    return this.serverUrl + `/v1/shape`
  }

  get awarenessUrl() {
    return this.serverUrl + `/v1/shape/`
  }

  /**
   * @type {boolean}
   */
  get synced() {
    return this._synced
  }

  set synced(state) {
    if (this._synced !== state) {
      this._synced = state
      this.emit(`synced`, [state])
      this.emit(`sync`, [state])
    }
  }

  destroy() {
    this.disconnect()
    if (env.isNode && typeof process !== `undefined`) {
      process.off(`exit`, this._exitHandler)
    }
    this.awareness?.off(`update`, this._awarenessUpdateHandler)
    this.doc.off(`update`, this._updateHandler)
    super.destroy()
  }

  disconnect() {
    this.shouldConnect = false
    this.disconnectHandler()
  }

  connect() {
    this.shouldConnect = true
    if (!this.connected && this.operationsStream === null) {
      setupShapeStream(this)
    }
  }
}
