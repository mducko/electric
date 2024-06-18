import { TestFn, ExecutionContext } from 'ava'

import {
  MOCK_BEHIND_WINDOW_LSN,
  MOCK_INTERNAL_ERROR,
} from '../../src/satellite/mock'
import { QualifiedTablename } from '../../src/util/tablename'
import { sleepAsync } from '../../src/util/timer'

import {
  OPTYPES,
  localOperationsToTableChanges,
  fromTransaction,
  OplogEntry,
  toTransactions,
  generateTag,
  encodeTags,
  opLogEntryToChange,
} from '../../src/satellite/oplog'
import { SatelliteProcess } from '../../src/satellite/process'

import {
  loadSatelliteMetaTable,
  generateLocalOplogEntry,
  generateRemoteOplogEntry,
  genEncodedTags,
  getMatchingShadowEntries as getSqliteMatchingShadowEntries,
  getPgMatchingShadowEntries,
} from '../support/satellite-helpers'
import Long from 'long'
import {
  DataChangeType,
  DataTransaction,
  SatelliteError,
  SatelliteErrorCode,
} from '../../src/util/types'
import {
  relations,
  ContextType as CommonContextType,
  cleanAndStopDb,
} from './common'

import { numberToBytes, base64, blobToHexString } from '../../src/util/encoders'

import { DEFAULT_LOG_POS } from '../../src/util/common'

import { Shape, SubscriptionData } from '../../src/satellite/shapes/types'
import { mergeEntries } from '../../src/satellite/merge'
import { AuthState, insecureAuthToken } from '../../src/auth'
import {
  ChangeCallback,
  ConnectivityStateChangeNotification,
} from '../../src/notifiers'
import { QueryBuilder } from '../../src/migrators/query-builder'
import { SatelliteOpts } from '../../src/satellite/config'
import { ForeignKeyChecks } from '../../src/config'

export type ContextType = CommonContextType & {
  builder: QueryBuilder
  getMatchingShadowEntries:
    | typeof getSqliteMatchingShadowEntries
    | typeof getPgMatchingShadowEntries
  opts: SatelliteOpts
  namespace: string
  qualifiedParentTableName: string
}

const parentRecord = {
  id: 1,
  value: 'incoming',
  other: 1,
}

const childRecord = {
  id: 1,
  parent: 1,
}

const startSatellite = async (
  satellite: SatelliteProcess,
  authState: AuthState,
  token: string
) => {
  await satellite.start(authState)
  satellite.setToken(token)
  const connectionPromise = satellite.connectWithBackoff().catch((e) => {
    if (e.message === 'terminating connection due to administrator command') {
      // This is to be expected as we stop Postgres at the end of the test
      return
    }
    throw e
  })
  return { connectionPromise }
}

const dialectValue = (
  sqliteValue: any,
  pgValue: any,
  t: ExecutionContext<ContextType>
) => {
  if (t.context.builder.dialect === 'SQLite') {
    return sqliteValue
  }
  return pgValue
}

export const processTests = (test: TestFn<ContextType>) => {
  test('setup starts a satellite process', async (t) => {
    t.true(t.context.satellite instanceof SatelliteProcess)
  })

  test('start creates system tables', async (t) => {
    const { adapter, satellite, authState, builder } = t.context

    await satellite.start(authState)

    const rows = await adapter.query(builder.getLocalTableNames())
    const names = rows.map((row) => row.name)

    t.true(names.includes('_electric_oplog'))
  })

  test('load metadata', async (t) => {
    const { adapter, runMigrations, namespace } = t.context
    await runMigrations()

    const meta = await loadSatelliteMetaTable(adapter, namespace)
    t.deepEqual(meta, {
      compensations: dialectValue(1, '1', t),
      lsn: '',
      clientId: '',
      subscriptions: '',
      seenAdditionalData: '',
    })
  })

  test('set persistent client id', async (t) => {
    const { satellite, authState, token } = t.context

    const { connectionPromise } = await startSatellite(
      satellite,
      authState,
      token
    )
    const clientId1 = satellite._authState!.clientId
    t.truthy(clientId1)

    await connectionPromise

    await satellite.stop()

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const clientId2 = satellite._authState!.clientId
    t.truthy(clientId2)
    t.assert(clientId1 === clientId2)
  })

  test('can use user_id in JWT', async (t) => {
    const { satellite, authState } = t.context

    await t.notThrowsAsync(async () => {
      const conn = await startSatellite(
        satellite,
        authState,
        insecureAuthToken({ user_id: 'test-userA' })
      )
      await conn.connectionPromise
    })
  })

  test('can use sub in JWT', async (t) => {
    const { satellite, authState } = t.context

    await t.notThrowsAsync(async () => {
      const conn = await startSatellite(
        satellite,
        authState,
        insecureAuthToken({ sub: 'test-userB' })
      )
      await conn.connectionPromise
    })
  })

  test('require user_id or sub in JWT', async (t) => {
    const { satellite, authState } = t.context

    const error = await t.throwsAsync(async () => {
      await startSatellite(
        satellite,
        authState,
        insecureAuthToken({ custom_user_claim: 'test-userC' })
      )
    })
    t.is(error?.message, 'Token does not contain a sub or user_id claim')
  })

  test('cannot update user id', async (t) => {
    const { satellite, authState, token } = t.context

    const conn = await startSatellite(satellite, authState, token)
    const error = t.throws(() => {
      satellite.setToken(insecureAuthToken({ sub: 'test-user2' }))
    })
    t.is(
      error?.message,
      "Can't change user ID when reconnecting. Previously connected with user ID 'test-user' but trying to reconnect with user ID 'test-user2'"
    )
    await conn.connectionPromise
  })

  test('cannot UPDATE primary key', async (t) => {
    const { adapter, runMigrations } = t.context
    await runMigrations()

    await adapter.run({ sql: `INSERT INTO parent(id) VALUES ('1'),('2')` })
    await t.throwsAsync(
      adapter.run({ sql: `UPDATE parent SET id='3' WHERE id = '1'` }),
      {
        code: dialectValue('SQLITE_CONSTRAINT_TRIGGER', 'P0001', t),
      }
    )
  })

  test('snapshot works', async (t) => {
    const { satellite } = t.context
    const { adapter, notifier, runMigrations, authState, namespace } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)

    await adapter.run({ sql: `INSERT INTO parent(id) VALUES ('1'),('2')` })

    const snapshotTimestamp = await satellite._performSnapshot()

    const clientId = satellite._authState!.clientId
    const shadowTags = encodeTags([generateTag(clientId, snapshotTimestamp)])

    const shadowRows = await adapter.query({
      sql: `SELECT tags FROM _electric_shadow`,
    })
    t.is(shadowRows.length, 2)
    for (const row of shadowRows) {
      t.is(row.tags, shadowTags)
    }

    t.is(notifier.notifications.length, 1)

    const { changes } = notifier.notifications[0]
    const expectedChange = {
      qualifiedTablename: new QualifiedTablename(namespace, 'parent'),
      rowids: [1, 2],
      recordChanges: [
        { primaryKey: { id: 1 }, type: 'INSERT' },
        { primaryKey: { id: 2 }, type: 'INSERT' },
      ],
    }

    t.deepEqual(changes, [expectedChange])
  })

  test('(regression) performSnapshot cant be called concurrently', async (t) => {
    const { authState, satellite, runMigrations } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)

    await t.throwsAsync(
      async () => {
        const run = satellite.adapter.run.bind(satellite.adapter)
        satellite.adapter.run = (stmt) =>
          new Promise((res) => setTimeout(() => run(stmt).then(res), 100))

        const p1 = satellite._performSnapshot()
        const p2 = satellite._performSnapshot()
        await Promise.all([p1, p2])
      },
      {
        instanceOf: SatelliteError,
        code: SatelliteErrorCode.INTERNAL,
        message: 'already performing snapshot',
      }
    )
  })

  test('(regression) throttle with mutex prevents race when snapshot is slow', async (t) => {
    const { authState, satellite, runMigrations } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)

    // delay termination of _performSnapshot
    const run = satellite.adapter.run.bind(satellite.adapter)
    satellite.adapter.run = (stmt) =>
      new Promise((res) => setTimeout(() => run(stmt).then(res), 100))

    const p1 = satellite._throttledSnapshot()
    const p2 = new Promise<Date>((res) => {
      // call snapshot after throttle time has expired
      setTimeout(() => satellite._throttledSnapshot()?.then(res), 50)
    })

    await t.notThrowsAsync(async () => {
      await p1
      await p2
    })
  })

  test('starting and stopping the process works', async (t) => {
    const {
      adapter,
      notifier,
      runMigrations,
      satellite,
      authState,
      token,
      opts,
    } = t.context
    await runMigrations()

    await adapter.run({ sql: `INSERT INTO parent(id) VALUES ('1'),('2')` })

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    await sleepAsync(opts.pollingInterval)

    // connect, 1st txn
    t.is(notifier.notifications.length, 2)

    await adapter.run({ sql: `INSERT INTO parent(id) VALUES ('3'),('4')` })
    await sleepAsync(opts.pollingInterval)

    // 2nd txm
    t.is(notifier.notifications.length, 3)

    await satellite.stop()
    await adapter.run({ sql: `INSERT INTO parent(id) VALUES ('5'),('6')` })
    await sleepAsync(opts.pollingInterval)

    // no txn notified
    t.is(notifier.notifications.length, 4)

    const conn1 = await startSatellite(satellite, authState, token)
    await conn1.connectionPromise
    await sleepAsync(opts.pollingInterval)

    // connect, 4th txn
    t.is(notifier.notifications.length, 6)
  })

  test('snapshots on potential data change', async (t) => {
    const { adapter, notifier, runMigrations } = t.context
    await runMigrations()

    await adapter.run({ sql: `INSERT INTO parent(id) VALUES ('1'),('2')` })

    t.is(notifier.notifications.length, 0)

    await notifier.potentiallyChanged()

    t.is(notifier.notifications.length, 1)
  })

  test('snapshot of INSERT with blob/Uint8Array', async (t) => {
    const { adapter, runMigrations, satellite, authState, builder, namespace } =
      t.context

    await runMigrations()

    const blob = new Uint8Array([1, 2, 255, 244, 160, 1])

    await adapter.run({
      sql: `INSERT INTO "${namespace}"."blobTable"(value) VALUES (${builder.makePositionalParam(
        1
      )})`,
      args: [blob],
    })

    await satellite._setAuthState(authState)
    await satellite._performSnapshot()
    const entries = await satellite._getEntries()
    const clientId = satellite._authState!.clientId

    const merged = localOperationsToTableChanges(
      entries,
      (timestamp: Date) => {
        return generateTag(clientId, timestamp)
      },
      relations
    )
    const qualifiedBlobTable = new QualifiedTablename(
      namespace,
      'blobTable'
    ).toString()
    const [_, keyChanges] =
      merged[qualifiedBlobTable][`{"value":"${blobToHexString(blob)}"}`]
    const resultingValue = keyChanges.changes.value.value
    t.deepEqual(resultingValue, blob)
  })

  // INSERT after DELETE shall nullify all non explicitly set columns
  // If last operation is a DELETE, concurrent INSERT shall resurrect deleted
  // values as in 'INSERT wins over DELETE and restored deleted values'
  test('snapshot of INSERT after DELETE', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      authState,
      qualifiedParentTableName,
    } = t.context

    await runMigrations()

    await adapter.run({
      sql: `INSERT INTO parent(id, value) VALUES (1,'val1')`,
    })
    await adapter.run({ sql: `DELETE FROM parent WHERE id=1` })
    await adapter.run({ sql: `INSERT INTO parent(id) VALUES (1)` })

    await satellite._setAuthState(authState)
    await satellite._performSnapshot()
    const entries = await satellite._getEntries()
    const clientId = satellite._authState!.clientId

    const merged = localOperationsToTableChanges(
      entries,
      (timestamp: Date) => {
        return generateTag(clientId, timestamp)
      },
      relations
    )
    const [_, keyChanges] = merged[qualifiedParentTableName]['{"id":1}']
    const resultingValue = keyChanges.changes.value.value
    t.is(resultingValue, null)
  })

  test('snapshot of INSERT with bigint', async (t) => {
    const { adapter, runMigrations, satellite, authState, namespace } =
      t.context

    await runMigrations()

    await adapter.run({
      sql: `INSERT INTO "bigIntTable"(value) VALUES (1)`,
    })

    await satellite._setAuthState(authState)
    await satellite._performSnapshot()
    const entries = await satellite._getEntries()
    const clientId = satellite._authState!.clientId

    const merged = localOperationsToTableChanges(
      entries,
      (timestamp: Date) => {
        return generateTag(clientId, timestamp)
      },
      relations
    )
    const qualifiedTableName = new QualifiedTablename(
      namespace,
      'bigIntTable'
    ).toString()
    const [_, keyChanges] = merged[qualifiedTableName]['{"value":"1"}']
    const resultingValue = keyChanges.changes.value.value
    t.is(resultingValue, 1n)
  })

  test('take snapshot and merge local wins', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      authState,
      namespace,
      qualifiedParentTableName,
    } = t.context
    await runMigrations()

    const incomingTs = new Date().getTime() - 1
    const incomingEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.insert,
      incomingTs,
      encodeTags([generateTag('remote', new Date(incomingTs))]),
      {
        id: 1,
        value: 'incoming',
      }
    )
    await adapter.run({
      sql: `INSERT INTO parent(id, value, other) VALUES (1, 'local', 1)`,
    })

    await satellite._setAuthState(authState)
    const localTime = await satellite._performSnapshot()
    const clientId = satellite._authState!.clientId

    const local = await satellite._getEntries()
    const localTimestamp = new Date(local[0].timestamp).getTime()
    const merged = mergeEntries(
      clientId,
      local,
      'remote',
      [incomingEntry],
      relations
    )
    const item = merged[qualifiedParentTableName]['{"id":1}']

    t.deepEqual(item, {
      namespace,
      tablename: 'parent',
      primaryKeyCols: { id: 1 },
      optype: OPTYPES.upsert,
      changes: {
        id: { value: 1, timestamp: localTimestamp },
        value: { value: 'local', timestamp: localTimestamp },
        other: { value: 1, timestamp: localTimestamp },
      },
      fullRow: {
        id: 1,
        value: 'local',
        other: 1,
      },
      tags: [
        generateTag(clientId, localTime),
        generateTag('remote', new Date(incomingTs)),
      ],
    })
  })

  test('take snapshot and merge incoming wins', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      authState,
      namespace,
      qualifiedParentTableName,
    } = t.context
    await runMigrations()

    await adapter.run({
      sql: `INSERT INTO parent(id, value, other) VALUES (1, 'local', 1)`,
    })

    await satellite._setAuthState(authState)
    const clientId = satellite._authState!.clientId
    await satellite._performSnapshot()

    const local = await satellite._getEntries()
    const localTimestamp = new Date(local[0].timestamp).getTime()

    const incomingTs = localTimestamp + 1
    const incomingEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.insert,
      incomingTs,
      genEncodedTags('remote', [incomingTs]),
      {
        id: 1,
        value: 'incoming',
      }
    )

    const merged = mergeEntries(
      clientId,
      local,
      'remote',
      [incomingEntry],
      relations
    )
    const item = merged[qualifiedParentTableName]['{"id":1}']

    t.deepEqual(item, {
      namespace,
      tablename: 'parent',
      primaryKeyCols: { id: 1 },
      optype: OPTYPES.upsert,
      changes: {
        id: { value: 1, timestamp: incomingTs },
        value: { value: 'incoming', timestamp: incomingTs },
        other: { value: 1, timestamp: localTimestamp },
      },
      fullRow: {
        id: 1,
        value: 'incoming',
        other: 1,
      },
      tags: [
        generateTag(clientId, new Date(localTimestamp)),
        generateTag('remote', new Date(incomingTs)),
      ],
    })
  })

  test('merge incoming wins on persisted ops', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      authState,
      namespace,
    } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)
    satellite.relations = relations

    // This operation is persisted
    await adapter.run({
      sql: `INSERT INTO parent(id, value, other) VALUES (1, 'local', 1)`,
    })
    await satellite._performSnapshot()
    const [originalInsert] = await satellite._getEntries()
    const [tx] = toTransactions([originalInsert], satellite.relations)
    tx.origin = authState.clientId
    await satellite._applyTransaction(tx)

    // Verify that GC worked as intended and the oplog entry was deleted
    t.deepEqual(await satellite._getEntries(), [])

    // This operation is done offline
    await adapter.run({
      sql: `UPDATE parent SET value = 'new local' WHERE id = 1`,
    })
    await satellite._performSnapshot()
    const [offlineInsert] = await satellite._getEntries()
    const offlineTimestamp = new Date(offlineInsert.timestamp).getTime()

    // This operation is done concurrently with offline but at a later point in time. It's sent immediately on connection
    const incomingTs = offlineTimestamp + 1
    const firstIncomingEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.update,
      incomingTs,
      genEncodedTags('remote', [incomingTs]),
      { id: 1, value: 'incoming' },
      { id: 1, value: 'local' }
    )

    const firstIncomingTx = {
      origin: 'remote',
      commit_timestamp: Long.fromNumber(incomingTs),
      changes: [opLogEntryToChange(firstIncomingEntry, satellite.relations)],
      lsn: new Uint8Array(),
    }
    await satellite._applyTransaction(firstIncomingTx)

    const [{ value: value1 }] = await adapter.query({
      sql: 'SELECT value FROM parent WHERE id = 1',
    })
    t.is(
      value1,
      'incoming',
      'LWW conflict merge of the incoming transaction should lead to incoming operation winning'
    )

    // And after the offline transaction was sent, the resolved no-op transaction comes in
    const secondIncomingEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.update,
      offlineTimestamp,
      encodeTags([
        generateTag('remote', incomingTs),
        generateTag(authState.clientId, offlineTimestamp),
      ]),
      { id: 1, value: 'incoming' },
      { id: 1, value: 'incoming' }
    )

    const secondIncomingTx = {
      origin: authState.clientId,
      commit_timestamp: Long.fromNumber(offlineTimestamp),
      changes: [opLogEntryToChange(secondIncomingEntry, satellite.relations)],
      lsn: new Uint8Array(),
    }
    await satellite._applyTransaction(secondIncomingTx)

    const [{ value: value2 }] = await adapter.query({
      sql: 'SELECT value FROM parent WHERE id = 1',
    })
    t.is(
      value2,
      'incoming',
      'Applying the resolved write from the round trip should be a no-op'
    )
  })

  test('apply does not add anything to oplog', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      authState,
      getMatchingShadowEntries,
      namespace,
    } = t.context
    await runMigrations()
    await adapter.run({
      sql: `INSERT INTO parent(id, value, other) VALUES (1, 'local', null)`,
    })

    await satellite._setAuthState(authState)
    const clientId = satellite._authState!.clientId

    const localTimestamp = await satellite._performSnapshot()

    const incomingTs = new Date().getTime()
    const incomingEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.insert,
      incomingTs,
      genEncodedTags('remote', [incomingTs]),
      {
        id: 1,
        value: 'incoming',
        other: 1,
      }
    )

    satellite.relations = relations // satellite must be aware of the relations in order to turn `DataChange`s into `OpLogEntry`s

    const incomingChange = opLogEntryToChange(incomingEntry, relations)
    const incomingTx = {
      origin: 'remote',
      commit_timestamp: Long.fromNumber(incomingTs),
      changes: [incomingChange],
      lsn: new Uint8Array(),
    }
    await satellite._applyTransaction(incomingTx)

    await satellite._performSnapshot()

    const sql = 'SELECT * from parent WHERE id=1'
    const [row] = await adapter.query({ sql })
    t.is(row.value, 'incoming')
    t.is(row.other, 1)

    const localEntries = await satellite._getEntries()
    const shadowEntry = await getMatchingShadowEntries(adapter, localEntries[0])

    t.deepEqual(
      encodeTags([
        generateTag(clientId, new Date(localTimestamp)),
        generateTag('remote', new Date(incomingTs)),
      ]),
      shadowEntry[0].tags
    )

    //t.deepEqual(shadowEntries, shadowEntries2)
    t.is(localEntries.length, 1)
  })

  test('apply incoming with no local', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      authState,
      getMatchingShadowEntries,
      namespace,
    } = t.context
    await runMigrations()

    const incomingTs = new Date()
    const incomingEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.delete,
      incomingTs.getTime(),
      genEncodedTags('remote', []),
      {
        id: 1,
        value: 'incoming',
        otherValue: 1,
      }
    )

    satellite.relations = relations // satellite must be aware of the relations in order to deserialise oplog entries

    await satellite._setAuthState(authState)
    await satellite._apply([incomingEntry], 'remote')

    const sql = 'SELECT * from parent WHERE id=1'
    const rows = await adapter.query({ sql })
    const shadowEntries = await getMatchingShadowEntries(adapter)

    t.is(shadowEntries.length, 0)
    t.is(rows.length, 0)
  })

  test('apply empty incoming', async (t) => {
    const { runMigrations, satellite, authState } = t.context
    await runMigrations()

    await satellite._setAuthState(authState)
    await satellite._apply([], 'external')

    t.true(true)
  })

  test('apply incoming with null on column with default', async (t) => {
    const {
      runMigrations,
      satellite,
      adapter,
      tableInfo,
      authState,
      namespace,
    } = t.context
    await runMigrations()

    const incomingTs = new Date().getTime()
    const incomingEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.insert,
      incomingTs,
      genEncodedTags('remote', [incomingTs]),
      {
        id: 1234,
        value: 'incoming',
        other: null,
      }
    )

    await satellite._setAuthState(authState)

    satellite.relations = relations // satellite must be aware of the relations in order to turn `DataChange`s into `OpLogEntry`s

    const incomingChange = opLogEntryToChange(incomingEntry, relations)
    const incomingTx = {
      origin: 'remote',
      commit_timestamp: Long.fromNumber(incomingTs),
      changes: [incomingChange],
      lsn: new Uint8Array(),
    }
    await satellite._applyTransaction(incomingTx)

    const sql = `SELECT * from parent WHERE value='incoming'`
    const rows = await adapter.query({ sql })

    t.is(rows[0].other, null)
    t.pass()
  })

  test('apply incoming with undefined on column with default', async (t) => {
    const {
      runMigrations,
      satellite,
      adapter,
      tableInfo,
      authState,
      namespace,
    } = t.context
    await runMigrations()

    const incomingTs = new Date().getTime()
    const incomingEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.insert,
      incomingTs,
      genEncodedTags('remote', [incomingTs]),
      {
        id: 1234,
        value: 'incoming',
      }
    )

    await satellite._setAuthState(authState)

    satellite.relations = relations // satellite must be aware of the relations in order to turn `DataChange`s into `OpLogEntry`s

    const incomingChange = opLogEntryToChange(incomingEntry, relations)
    const incomingTx = {
      origin: 'remote',
      commit_timestamp: Long.fromNumber(incomingTs),
      changes: [incomingChange],
      lsn: new Uint8Array(),
    }
    await satellite._applyTransaction(incomingTx)

    const sql = `SELECT * from parent WHERE value='incoming'`
    const rows = await adapter.query({ sql })

    t.is(rows[0].other, 0)
    t.pass()
  })

  test('INSERT wins over DELETE and restored deleted values', async (t) => {
    const {
      runMigrations,
      satellite,
      tableInfo,
      authState,
      namespace,
      qualifiedParentTableName,
    } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)
    const clientId = satellite._authState!.clientId

    const localTs = new Date().getTime()
    const incomingTs = localTs + 1

    const incoming = [
      generateRemoteOplogEntry(
        tableInfo,
        namespace,
        'parent',
        OPTYPES.insert,
        incomingTs,
        genEncodedTags('remote', [incomingTs]),
        {
          id: 1,
          other: 1,
        }
      ),
      generateRemoteOplogEntry(
        tableInfo,
        namespace,
        'parent',
        OPTYPES.delete,
        incomingTs,
        genEncodedTags('remote', []),
        {
          id: 1,
        }
      ),
    ]

    const local = [
      generateLocalOplogEntry(
        tableInfo,
        namespace,
        'parent',
        OPTYPES.insert,
        localTs,
        genEncodedTags(clientId, [localTs]),
        {
          id: 1,
          value: 'local',
          other: null,
        }
      ),
    ]

    const merged = mergeEntries(clientId, local, 'remote', incoming, relations)
    const item = merged[qualifiedParentTableName]['{"id":1}']

    t.deepEqual(item, {
      namespace,
      tablename: 'parent',
      primaryKeyCols: { id: 1 },
      optype: OPTYPES.upsert,
      changes: {
        id: { value: 1, timestamp: incomingTs },
        value: { value: 'local', timestamp: localTs },
        other: { value: 1, timestamp: incomingTs },
      },
      fullRow: {
        id: 1,
        value: 'local',
        other: 1,
      },
      tags: [
        generateTag(clientId, new Date(localTs)),
        generateTag('remote', new Date(incomingTs)),
      ],
    })
  })

  test('concurrent updates take all changed values', async (t) => {
    const {
      runMigrations,
      satellite,
      tableInfo,
      authState,
      namespace,
      qualifiedParentTableName,
    } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)
    const clientId = satellite._authState!.clientId

    const localTs = new Date().getTime()
    const incomingTs = localTs + 1

    const incoming = [
      generateRemoteOplogEntry(
        tableInfo,
        namespace,
        'parent',
        OPTYPES.update,
        incomingTs,
        genEncodedTags('remote', [incomingTs]),
        {
          id: 1,
          value: 'remote', // the only modified column
          other: 0,
        },
        {
          id: 1,
          value: 'local',
          other: 0,
        }
      ),
    ]

    const local = [
      generateLocalOplogEntry(
        tableInfo,
        namespace,
        'parent',
        OPTYPES.update,
        localTs,
        genEncodedTags(clientId, [localTs]),
        {
          id: 1,
          value: 'local',
          other: 1, // the only modified column
        },
        {
          id: 1,
          value: 'local',
          other: 0,
        }
      ),
    ]

    const merged = mergeEntries(clientId, local, 'remote', incoming, relations)
    const item = merged[qualifiedParentTableName]['{"id":1}']

    // The incoming entry modified the value of the `value` column to `'remote'`
    // The local entry concurrently modified the value of the `other` column to 1.
    // The merged entries should have `value = 'remote'` and `other = 1`.
    t.deepEqual(item, {
      namespace,
      tablename: 'parent',
      primaryKeyCols: { id: 1 },
      optype: OPTYPES.upsert,
      changes: {
        value: { value: 'remote', timestamp: incomingTs },
        other: { value: 1, timestamp: localTs },
      },
      fullRow: {
        id: 1,
        value: 'remote',
        other: 1,
      },
      tags: [
        generateTag(clientId, new Date(localTs)),
        generateTag('remote', new Date(incomingTs)),
      ],
    })
  })

  test('merge incoming with empty local', async (t) => {
    const {
      runMigrations,
      satellite,
      tableInfo,
      authState,
      namespace,
      qualifiedParentTableName,
    } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)
    const clientId = satellite._authState!.clientId

    const localTs = new Date().getTime()
    const incomingTs = localTs + 1

    const incoming = [
      generateRemoteOplogEntry(
        tableInfo,
        namespace,
        'parent',
        OPTYPES.insert,
        incomingTs,
        genEncodedTags('remote', [incomingTs]),
        {
          id: 1,
        },
        undefined
      ),
    ]

    const local: OplogEntry[] = []
    const merged = mergeEntries(clientId, local, 'remote', incoming, relations)
    const item = merged[qualifiedParentTableName]['{"id":1}']

    t.deepEqual(item, {
      namespace,
      tablename: 'parent',
      primaryKeyCols: { id: 1 },
      optype: OPTYPES.upsert,
      changes: {
        id: { value: 1, timestamp: incomingTs },
      },
      fullRow: {
        id: 1,
      },
      tags: [generateTag('remote', new Date(incomingTs))],
    })
  })

  test('compensations: referential integrity is enforced', async (t) => {
    const { adapter, runMigrations, satellite, builder } = t.context
    await runMigrations()

    if (builder.dialect === 'SQLite') {
      await adapter.run({ sql: `PRAGMA foreign_keys = ON` })
    }
    await satellite._setMeta('compensations', 0)
    await adapter.run({
      sql: `INSERT INTO parent(id, value) VALUES (1, '1')`,
    })

    await t.throwsAsync(
      adapter.run({ sql: `INSERT INTO child(id, parent) VALUES (1, 2)` }),
      {
        code: dialectValue('SQLITE_CONSTRAINT_FOREIGNKEY', '23503', t),
      }
    )
  })

  test('compensations: incoming operation breaks referential integrity', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      timestamp,
      authState,
      builder,
      namespace,
    } = t.context
    if (builder.dialect === 'Postgres') {
      // Ignore this unit test for Postgres
      // because we don't defer FK checks
      // but completely disable them for incoming transactions
      t.pass()
      return
    }

    await runMigrations()

    if (builder.dialect === 'SQLite') {
      satellite.fkChecks = ForeignKeyChecks.inherit // set FK checks to inherit because by default they are disabled
      await adapter.run({ sql: `PRAGMA foreign_keys = ON` })
    }
    await satellite._setMeta('compensations', 0)
    await satellite._setAuthState(authState)

    const incoming = generateLocalOplogEntry(
      tableInfo,
      namespace,
      'child',
      OPTYPES.insert,
      timestamp,
      genEncodedTags('remote', [timestamp]),
      {
        id: 1,
        parent: 1,
      }
    )

    satellite.relations = relations // satellite must be aware of the relations in order to turn `DataChange`s into `OpLogEntry`s

    const incomingChange = opLogEntryToChange(incoming, relations)
    const incomingTx = {
      origin: 'remote',
      commit_timestamp: Long.fromNumber(timestamp),
      changes: [incomingChange],
      lsn: new Uint8Array(),
    }

    await t.throwsAsync(satellite._applyTransaction(incomingTx), {
      code: dialectValue('SQLITE_CONSTRAINT_FOREIGNKEY', '23503', t),
    })
  })

  test('compensations: incoming operations accepted if restore referential integrity', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      timestamp,
      authState,
      builder,
      namespace,
    } = t.context
    await runMigrations()

    if (builder.dialect === 'SQLite') {
      await adapter.run({ sql: `PRAGMA foreign_keys = ON` })
    }
    await satellite._setMeta('compensations', 0)
    await satellite._setAuthState(authState)
    const clientId = satellite._authState!.clientId

    const childInsertEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'child',
      OPTYPES.insert,
      timestamp,
      genEncodedTags(clientId, [timestamp]),
      {
        id: 1,
        parent: 1,
      }
    )

    const parentInsertEntry = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.insert,
      timestamp,
      genEncodedTags(clientId, [timestamp]),
      {
        id: 1,
      }
    )

    await adapter.run({
      sql: `INSERT INTO parent(id, value) VALUES (1, '1')`,
    })
    await adapter.run({ sql: `DELETE FROM parent WHERE id=1` })

    await satellite._performSnapshot()

    satellite.relations = relations // satellite must be aware of the relations in order to turn `DataChange`s into `OpLogEntry`s

    const childInsertChange = opLogEntryToChange(childInsertEntry, relations)
    const parentInsertChange = opLogEntryToChange(parentInsertEntry, relations)
    const insertChildAndParentTx = {
      origin: 'remote',
      commit_timestamp: Long.fromNumber(new Date().getTime()), // timestamp is not important for this test, it is only used to GC the oplog
      changes: [parentInsertChange, childInsertChange],
      lsn: new Uint8Array(),
    }
    await satellite._applyTransaction(insertChildAndParentTx)

    const rows = await adapter.query({
      sql: `SELECT * from parent WHERE id=1`,
    })

    // Not only does the parent exist.
    t.is(rows.length, 1)

    // But it's also recreated with deleted values.
    t.is(rows[0].value, '1')
  })

  test('compensations: using triggers with flag 0', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      authState,
      builder,
      namespace,
    } = t.context
    // since this test disables compensations
    // by putting the flag on 0
    // it is expecting a FK violation
    if (builder.dialect === 'Postgres') {
      // if we're running Postgres
      // we are not deferring FK checks
      // but completely disabling them for incoming transactions
      // so the FK violation will not occur
      t.pass()
      return
    }

    await runMigrations()

    if (builder.dialect === 'SQLite') {
      satellite.fkChecks = ForeignKeyChecks.inherit // set FK checks to inherit because by default they are disabled
      await adapter.run({ sql: `PRAGMA foreign_keys = ON` })
    }
    await satellite._setMeta('compensations', 0)

    await adapter.run({
      sql: `INSERT INTO parent(id, value) VALUES (1, '1')`,
    })
    await satellite._setAuthState(authState)
    const ts = await satellite._performSnapshot()
    await satellite._garbageCollectOplog(ts)

    await adapter.run({
      sql: `INSERT INTO child(id, parent) VALUES (1, 1)`,
    })
    await satellite._performSnapshot()

    const timestamp = new Date().getTime()
    const incoming = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.delete,
      timestamp,
      genEncodedTags('remote', []),
      {
        id: 1,
      }
    )

    satellite.relations = relations // satellite must be aware of the relations in order to turn `DataChange`s into `OpLogEntry`s

    const incomingChange = opLogEntryToChange(incoming, relations)
    const incomingTx = {
      origin: 'remote',
      commit_timestamp: Long.fromNumber(timestamp),
      changes: [incomingChange],
      lsn: new Uint8Array(),
    }

    await t.throwsAsync(satellite._applyTransaction(incomingTx), {
      code: dialectValue('SQLITE_CONSTRAINT_FOREIGNKEY', '23503', t),
    })
  })

  test('compensations: using triggers with flag 1', async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      tableInfo,
      authState,
      builder,
      namespace,
    } = t.context
    await runMigrations()

    if (builder.dialect === 'SQLite') {
      await adapter.run({ sql: `PRAGMA foreign_keys = ON` })
    }
    await satellite._setMeta('compensations', 1)

    await adapter.run({
      sql: `INSERT INTO parent(id, value) VALUES (1, '1')`,
    })
    await satellite._setAuthState(authState)
    const ts = await satellite._performSnapshot()
    await satellite._garbageCollectOplog(ts)

    await adapter.run({
      sql: `INSERT INTO child(id, parent) VALUES (1, 1)`,
    })
    await satellite._performSnapshot()

    const timestamp = new Date().getTime()
    const incoming = [
      generateRemoteOplogEntry(
        tableInfo,
        namespace,
        'parent',
        OPTYPES.delete,
        timestamp,
        genEncodedTags('remote', []),
        {
          id: 1,
        }
      ),
    ]

    satellite.relations = relations // satellite must be aware of the relations in order to deserialise oplog entries

    await satellite._apply(incoming, 'remote')
    t.pass()
  })

  test('get oplogEntries from transaction', async (t) => {
    const { runMigrations, satellite, namespace } = t.context
    await runMigrations()

    const relations = await satellite['_getLocalRelations']()

    const transaction: DataTransaction = {
      lsn: DEFAULT_LOG_POS,
      commit_timestamp: Long.UZERO,
      changes: [
        {
          relation: relations.parent,
          type: DataChangeType.INSERT,
          record: { id: 0 },
          tags: [], // proper values are not relevent here
        },
      ],
    }

    const expected: OplogEntry = {
      namespace,
      tablename: 'parent',
      optype: 'INSERT',
      newRow: '{"id":0}',
      oldRow: undefined,
      primaryKey: '{"id":0}',
      rowid: -1,
      timestamp: '1970-01-01T00:00:00.000Z',
      clearTags: encodeTags([]),
    }

    const opLog = fromTransaction(transaction, relations, namespace)
    t.deepEqual(opLog[0], expected)
  })

  test('get transactions from opLogEntries', async (t) => {
    const { runMigrations, namespace } = t.context
    await runMigrations()

    const opLogEntries: OplogEntry[] = [
      {
        namespace,
        tablename: 'parent',
        optype: 'INSERT',
        newRow: '{"id":0}',
        oldRow: undefined,
        primaryKey: '{"id":0}',
        rowid: 1,
        timestamp: '1970-01-01T00:00:00.000Z',
        clearTags: encodeTags([]),
      },
      {
        namespace,
        tablename: 'parent',
        optype: 'UPDATE',
        newRow: '{"id":1}',
        oldRow: '{"id":1}',
        primaryKey: '{"id":1}',
        rowid: 2,
        timestamp: '1970-01-01T00:00:00.000Z',
        clearTags: encodeTags([]),
      },
      {
        namespace,
        tablename: 'parent',
        optype: 'INSERT',
        newRow: '{"id":2}',
        oldRow: undefined,
        primaryKey: '{"id":0}',
        rowid: 3,
        timestamp: '1970-01-01T00:00:01.000Z',
        clearTags: encodeTags([]),
      },
    ]

    const expected = [
      {
        lsn: numberToBytes(2),
        commit_timestamp: Long.UZERO,
        changes: [
          {
            relation: relations.parent,
            type: DataChangeType.INSERT,
            record: { id: 0 },
            oldRecord: undefined,
            tags: [],
          },
          {
            relation: relations.parent,
            type: DataChangeType.UPDATE,
            record: { id: 1 },
            oldRecord: { id: 1 },
            tags: [],
          },
        ],
      },
      {
        lsn: numberToBytes(3),
        commit_timestamp: Long.UZERO.add(1000),
        changes: [
          {
            relation: relations.parent,
            type: DataChangeType.INSERT,
            record: { id: 2 },
            oldRecord: undefined,
            tags: [],
          },
        ],
      },
    ]

    const opLog = toTransactions(opLogEntries, relations)
    t.deepEqual(opLog, expected)
  })

  test('disconnect stops queueing operations', async (t) => {
    const { runMigrations, satellite, adapter, authState, token } = t.context
    await runMigrations()
    const { connectionPromise } = await startSatellite(
      satellite,
      authState,
      token
    )
    await connectionPromise

    adapter.run({
      sql: `INSERT INTO parent(id, value, other) VALUES (1, 'local', 1)`,
    })

    await satellite._performSnapshot()

    // We should have sent (or at least enqueued to send) one row
    const sentLsn = satellite.client.getLastSentLsn()
    t.deepEqual(sentLsn, numberToBytes(1))

    satellite.disconnect()

    adapter.run({
      sql: `INSERT INTO parent(id, value, other) VALUES (2, 'local', 1)`,
    })

    await satellite._performSnapshot()

    // Since connectivity is down, that row isn't yet sent
    const lsn1 = satellite.client.getLastSentLsn()
    t.deepEqual(lsn1, sentLsn)

    // Once connectivity is restored, we will immediately run a snapshot to send pending rows
    await satellite.connectWithBackoff()
    await sleepAsync(200) // Wait for snapshot to run
    const lsn2 = satellite.client.getLastSentLsn()
    t.deepEqual(lsn2, numberToBytes(2))
  })

  test('notifies about JWT expiration', async (t) => {
    const {
      satellite,
      authState,
      runMigrations,
      client,
      notifier,
      dbName,
      token,
    } = t.context
    await runMigrations()
    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    // give some time for Satellite to start
    // (needed because connecting and starting replication are async)
    await sleepAsync(100)

    // we're expecting 2 assertions
    t.plan(4)

    const unsubConnectivityChanges =
      notifier.subscribeToConnectivityStateChanges(
        (notification: ConnectivityStateChangeNotification) => {
          t.is(notification.dbName, dbName)
          t.is(notification.connectivityState.status, 'disconnected')
          t.is(
            notification.connectivityState.reason?.code,
            SatelliteErrorCode.AUTH_EXPIRED
          )
        }
      )
    t.teardown(unsubConnectivityChanges)

    // mock JWT expiration
    client.emitSocketClosedError(SatelliteErrorCode.AUTH_EXPIRED)

    // give the notifier some time to fire
    await sleepAsync(100)

    // check that the client is disconnected
    t.false(client.isConnected())
  })

  test('garbage collection is triggered when transaction from the same origin is replicated', async (t) => {
    const { satellite } = t.context
    const { runMigrations, adapter, authState, token } = t.context
    await runMigrations()
    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    adapter.run({
      sql: `INSERT INTO parent(id, value, other) VALUES (1, 'local', 1);`,
    })
    adapter.run({
      sql: `UPDATE parent SET value = 'local', other = 2 WHERE id = 1;`,
    })

    // Before snapshot, we didn't send anything
    const lsn1 = satellite.client.getLastSentLsn()
    t.deepEqual(lsn1, numberToBytes(0))

    // Snapshot sends these oplog entries
    await satellite._performSnapshot()
    const lsn2 = satellite.client.getLastSentLsn()
    t.deepEqual(lsn2, numberToBytes(2))

    const old_oplog = await satellite._getEntries()
    const transactions = toTransactions(old_oplog, relations)
    transactions[0].origin = satellite._authState!.clientId

    // Transaction containing these oplogs is applies, which means we delete them
    await satellite._applyTransaction(transactions[0])
    const new_oplog = await satellite._getEntries()
    t.deepEqual(new_oplog, [])
  })

  // stub client and make satellite throw the error with option off/succeed with option on
  test('clear database on BEHIND_WINDOW', async (t) => {
    const { satellite } = t.context
    const { runMigrations, authState, token } = t.context
    await runMigrations()

    const base64lsn = base64.fromBytes(numberToBytes(MOCK_BEHIND_WINDOW_LSN))
    await satellite._setMeta('lsn', base64lsn)
    try {
      const conn = await startSatellite(satellite, authState, token)
      await conn.connectionPromise
      const lsnAfter = await satellite._getMeta('lsn')
      t.not(lsnAfter, base64lsn)
    } catch (e) {
      t.fail('start should not throw')
    }

    // TODO: test clear subscriptions
  })

  test('throw other replication errors', async (t) => {
    t.plan(2)
    const { satellite, runMigrations, authState, token } = t.context
    await runMigrations()

    const base64lsn = base64.fromBytes(numberToBytes(MOCK_INTERNAL_ERROR))
    await satellite._setMeta('lsn', base64lsn)

    const conn = await startSatellite(satellite, authState, token)
    return Promise.all(
      [satellite['initializing']?.waitOn(), conn.connectionPromise].map((p) =>
        p?.catch((e: SatelliteError) => {
          t.is(e.code, SatelliteErrorCode.INTERNAL)
        })
      )
    )
  })

  test('apply shape data and persist subscription', async (t) => {
    const { client, satellite, adapter, notifier, token, namespace } = t.context
    const { runMigrations, authState } = t.context
    await runMigrations()

    const tablename = 'parent'
    const qualifiedTableName = new QualifiedTablename(namespace, tablename)

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData(tablename, parentRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef: Shape = {
      tablename,
    }

    satellite!.relations = relations
    const { synced } = await satellite.subscribe([shapeDef])
    await synced

    // first notification is 'connected', second and third is establishing shape,
    // final one is initial sync
    t.is(notifier.notifications.length, 4)
    t.is(notifier.notifications[3].changes.length, 1)
    t.deepEqual(notifier.notifications[3].changes[0], {
      qualifiedTablename: qualifiedTableName,
      recordChanges: [
        {
          primaryKey: { id: 1 },
          type: 'INITIAL',
        },
      ],
      rowids: [],
    })

    // wait for process to apply shape data
    try {
      const row = await adapter.query({
        sql: `SELECT id FROM ${qualifiedTableName}`,
      })
      t.is(row.length, 1)

      const shadowRows = await adapter.query({
        sql: `SELECT tags FROM _electric_shadow`,
      })
      t.is(shadowRows.length, 1)

      const subsMeta = await satellite._getMeta('subscriptions')
      const subsObj = JSON.parse(subsMeta)
      t.is(Object.keys(subsObj.active).length, 1)

      // Check that we save the LSN sent by the mock
      t.deepEqual(satellite._lsn, base64.toBytes('MTIz'))
    } catch (e) {
      t.fail(JSON.stringify(e))
    }
  })

  test('multiple subscriptions for the same shape are deduplicated', async (t) => {
    const { client, satellite, runMigrations, authState, token } = t.context
    await runMigrations()

    const tablename = 'parent'

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData(tablename, parentRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef: Shape = {
      tablename,
    }

    satellite!.relations = relations

    // We want none of these cases to throw
    await t.notThrowsAsync(async () => {
      // We should dedupe subscriptions that are done at the same time
      const [sub1, sub2] = await Promise.all([
        satellite.subscribe([shapeDef]),
        satellite.subscribe([shapeDef]),
      ])
      // That are done after first await but before the data
      const sub3 = await satellite.subscribe([shapeDef])
      // And that are done after previous data is resolved
      await Promise.all([sub1.synced, sub2.synced, sub3.synced])
      const sub4 = await satellite.subscribe([shapeDef])

      await sub4.synced
    })

    // And be "merged" into one subscription
    t.is(satellite.subscriptionManager.listContinuedSubscriptions().length, 1)
  })

  test('applied shape data will be acted upon correctly', async (t) => {
    const {
      client,
      satellite,
      adapter,
      runMigrations,
      authState,
      token,
      namespace,
    } = t.context
    await runMigrations()

    const tablename = 'parent'
    const qualified = new QualifiedTablename(namespace, tablename)

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData(tablename, parentRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef: Shape = {
      tablename,
    }

    satellite!.relations = relations
    const { synced } = await satellite.subscribe([shapeDef])
    await synced

    // wait for process to apply shape data
    try {
      const row = await adapter.query({
        sql: `SELECT id FROM ${qualified}`,
      })
      t.is(row.length, 1)

      const shadowRows = await adapter.query({
        sql: `SELECT * FROM _electric_shadow`,
      })
      t.is(shadowRows.length, 1)
      t.like(shadowRows[0], {
        namespace,
        tablename: 'parent',
      })

      await adapter.run({ sql: `DELETE FROM ${qualified} WHERE id = 1` })
      await satellite._performSnapshot()

      const oplogs = await adapter.query({
        sql: `SELECT * FROM _electric_oplog`,
      })
      t.not(oplogs[0].clearTags, '[]')
    } catch (e) {
      t.fail(JSON.stringify(e))
    }
  })

  test('additional data will be stored properly', async (t) => {
    const { client, satellite, adapter } = t.context
    const { runMigrations, authState, token } = t.context
    await runMigrations()
    const tablename = 'parent'

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData(tablename, parentRecord)

    await startSatellite(satellite, authState, token)

    const shapeDef: Shape = {
      tablename,
    }

    satellite!.relations = relations
    const { synced } = await satellite.subscribe([shapeDef])
    await synced
    await satellite._performSnapshot()

    // Send additional data
    await client.additionalDataCb!({
      ref: new Long(10),
      changes: [
        {
          relation: relations.parent,
          tags: ['server@' + Date.now()],
          type: DataChangeType.INSERT,
          record: { id: 100, value: 'new_value' },
        },
      ],
    })

    const [result] = await adapter.query({
      sql: 'SELECT * FROM parent WHERE id = 100',
    })
    t.deepEqual(result, { id: 100, value: 'new_value', other: null })
  })

  test('GONE messages are applied as DELETEs', async (t) => {
    const { client, satellite, adapter } = t.context
    const { runMigrations, authState, token } = t.context
    await runMigrations()
    const tablename = 'parent'

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData(tablename, parentRecord)

    await startSatellite(satellite, authState, token)

    const shapeDef: Shape = {
      tablename,
    }

    satellite!.relations = relations
    const { synced } = await satellite.subscribe([shapeDef])
    await synced
    await satellite._performSnapshot()

    // Send additional data
    await client.transactionsCb!({
      commit_timestamp: Long.fromNumber(new Date().getTime()),
      id: new Long(10),
      lsn: new Uint8Array(),
      changes: [
        {
          relation: relations.parent,
          tags: [],
          type: DataChangeType.GONE,
          record: { id: 1 },
        },
      ],
    })

    const results = await adapter.query({
      sql: 'SELECT * FROM parent',
    })
    t.deepEqual(results, [])
  })

  test('GONE batch is applied as DELETEs', async (t) => {
    const { client, satellite, adapter } = t.context
    const { runMigrations, authState, token } = t.context
    await runMigrations()
    const tablename = 'parent'

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData(tablename, parentRecord)
    client.setRelationData(tablename, { ...parentRecord, id: 2 })

    await startSatellite(satellite, authState, token)

    satellite!.relations = relations
    const { synced, key } = await satellite.subscribe([{ tablename }])
    await synced
    await satellite._performSnapshot()

    const status = satellite.syncStatus(key)
    if (status?.status !== 'active') return void t.fail()

    const promise = new Promise((r: ChangeCallback) => {
      satellite.notifier.subscribeToDataChanges(r)
    })
    client.setGoneBatch(status.serverId, [
      { tablename, record: { id: 1 } },
      { tablename, record: { id: 2 } },
    ])
    // Send additional data
    t.timeout(10, "Unsubscribe call to the server didn't resolve")
    await t.notThrowsAsync(() => satellite.unsubscribe([key]))

    const change = await promise
    t.is(change.changes.length, 1)
    t.deepEqual(change.changes[0].recordChanges, [
      { primaryKey: { id: 1 }, type: 'GONE' },
      { primaryKey: { id: 2 }, type: 'GONE' },
    ])

    const results = await adapter.query({
      sql: 'SELECT * FROM parent',
    })
    t.deepEqual(results, [])
  })

  test('a subscription that failed to apply because of FK constraint triggers GC', async (t) => {
    const {
      client,
      satellite,
      adapter,
      runMigrations,
      authState,
      token,
      namespace,
      builder,
    } = t.context
    if (builder.dialect === 'Postgres') {
      // Ignore this unit test for Postgres
      // because we don't defer FK checks
      // but completely disable them for incoming transactions
      t.pass()
      return
    }

    await runMigrations()

    if (builder.dialect === 'SQLite') {
      satellite.fkChecks = ForeignKeyChecks.inherit // set FK checks to inherit because by default they are disabled
      await adapter.run({ sql: `PRAGMA foreign_keys = ON` })
    }

    const tablename = 'child'

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData(tablename, childRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef1: Shape = {
      tablename,
    }

    satellite!.relations = relations
    const { synced } = await satellite.subscribe([shapeDef1])
    t.timeout(1000, "Synced promise didn't resolve within 100ms as expected")
    await t.throwsAsync(() => synced, {
      instanceOf: SatelliteError,
      message: /Error applying subscription data/,
    })

    const row = await adapter.query({
      sql: `SELECT id FROM "${namespace}"."${tablename}"`,
    })
    t.is(row.length, 0)
  })

  test('a second successful subscription', async (t) => {
    const {
      client,
      satellite,
      adapter,
      runMigrations,
      authState,
      token,
      namespace,
    } = t.context
    await runMigrations()

    const tablename = 'child'

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData('parent', parentRecord)
    client.setRelationData(tablename, childRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef1: Shape = {
      tablename: 'parent',
    }
    const shapeDef2: Shape = {
      tablename,
    }

    satellite!.relations = relations
    await satellite.subscribe([shapeDef1])
    const { synced } = await satellite.subscribe([shapeDef2])
    await synced

    try {
      const row = await adapter.query({
        sql: `SELECT id FROM "${namespace}"."${tablename}"`,
      })
      t.is(row.length, 1)

      const shadowRows = await adapter.query({
        sql: `SELECT tags FROM _electric_shadow`,
      })
      t.is(shadowRows.length, 2)

      const subsMeta = await satellite._getMeta('subscriptions')
      const subsObj = JSON.parse(subsMeta)
      t.is(Object.keys(subsObj.active).length, 2)
    } catch (e) {
      t.fail(JSON.stringify(e))
    }
  })

  test('a subscription that did not receive data before we went offline is retried', async (t) => {
    const {
      client,
      satellite,
      adapter,
      runMigrations,
      authState,
      token,
      namespace,
    } = t.context
    await runMigrations()

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData('parent', parentRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef1: Shape = {
      tablename: 'parent',
    }

    satellite!.relations = relations
    // Make sure the data doesn't arrive but the ID does
    client.skipNextEmit()
    await satellite.subscribe([shapeDef1], 'testKey')

    const state1 = satellite.subscriptionManager.status('testKey')!
    if (state1.status !== 'establishing') return void t.fail()
    t.is(state1.progress, 'receiving_data')

    satellite.disconnect()

    const promise = new Promise((r: ChangeCallback) => {
      satellite.notifier.subscribeToDataChanges(r)
    })

    await satellite.connectWithBackoff()
    await promise

    const state2 = satellite.subscriptionManager.status('testKey')!
    t.is(state2.status, 'active')
    t.not((state1 as any).serverId, (state2 as any).serverId)

    try {
      const row = await adapter.query({
        sql: `SELECT id FROM "${namespace}".parent`,
      })
      t.is(row.length, 1)

      const shadowRows = await adapter.query({
        sql: `SELECT tags FROM _electric_shadow`,
      })
      t.is(shadowRows.length, 1)

      const subsMeta = await satellite._getMeta('subscriptions')
      const subsObj = JSON.parse(subsMeta)
      t.is(Object.keys(subsObj.active).length, 1)
    } catch (e) {
      t.fail(JSON.stringify(e))
    }
  })

  test('a single subscribe with multiple tables with FKs', async (t) => {
    const {
      client,
      satellite,
      adapter,
      runMigrations,
      authState,
      token,
      namespace,
    } = t.context
    await runMigrations()

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData('parent', parentRecord)
    client.setRelationData('child', childRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef1: Shape = {
      tablename: 'child',
    }
    const shapeDef2: Shape = {
      tablename: 'parent',
    }

    satellite!.relations = relations

    const prom = new Promise<void>((res, rej) => {
      client.subscribeToSubscriptionEvents(
        (data: SubscriptionData) => {
          // child is applied first
          t.is(data.data[0].relation.table, 'child')
          t.is(data.data[1].relation.table, 'parent')

          setTimeout(async () => {
            try {
              const row = await adapter.query({
                sql: `SELECT id FROM "${namespace}"."child"`,
              })
              t.is(row.length, 1)

              res()
            } catch (e) {
              rej(e)
            }
          }, 10)
        },
        () => undefined
      )
    })

    await satellite.subscribe([shapeDef1, shapeDef2])

    return prom
  })

  test.serial(
    'a shape delivery that triggers garbage collection',
    async (t) => {
      const {
        client,
        satellite,
        adapter,
        runMigrations,
        authState,
        token,
        namespace,
      } = t.context
      await runMigrations()

      const tablename = 'parent'
      const childTable = 'child'

      // relations must be present at subscription delivery
      client.setRelations(relations)
      client.setRelationData(tablename, parentRecord)
      client.setRelationData(childTable, childRecord)
      client.setRelationData('another', {})

      const conn = await startSatellite(satellite, authState, token)
      await conn.connectionPromise

      const shapeDef1: Shape = {
        tablename: 'parent',
        include: [{ foreignKey: ['parent'], select: { tablename: 'child' } }],
      }
      const shapeDef2: Shape = {
        tablename: 'another',
      }

      satellite!.relations = relations
      const { synced: synced1 } = await satellite.subscribe([shapeDef1])
      await synced1
      const row = await adapter.query({
        sql: `SELECT id FROM "${namespace}".parent`,
      })
      t.is(row.length, 1)
      const row1 = await adapter.query({
        sql: `SELECT id FROM "${namespace}".child`,
      })
      t.is(row1.length, 1)
      const { synced } = await satellite.subscribe([shapeDef2])

      await t.throwsAsync(() => synced, {
        instanceOf: SatelliteError,
        message: /table 'another'/,
      })

      const newRow = await adapter.query({
        sql: `SELECT id FROM "${namespace}"."${tablename}"`,
      })
      t.is(newRow.length, 0)
      const newRow1 = await adapter.query({
        sql: `SELECT id FROM "${namespace}"."${childTable}"`,
      })
      t.is(newRow1.length, 0)

      const shadowRows = await adapter.query({
        sql: `SELECT tags FROM "${namespace}"._electric_shadow`,
      })
      t.is(shadowRows.length, 2)

      const subsMeta = await satellite._getMeta('subscriptions')
      const subsObj = JSON.parse(subsMeta)
      t.deepEqual(subsObj, {
        active: {},
        known: {},
        unfulfilled: {},
        unsubscribes: [],
      })
    }
  )

  test('a subscription request failure does not clear the manager state', async (t) => {
    const {
      client,
      satellite,
      adapter,
      runMigrations,
      authState,
      token,
      namespace,
    } = t.context
    await runMigrations()

    // relations must be present at subscription delivery
    const tablename = 'parent'
    client.setRelations(relations)
    client.setRelationData(tablename, parentRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef1: Shape = {
      tablename: tablename,
    }

    const shapeDef2: Shape = {
      tablename: 'failure',
    }

    satellite!.relations = relations
    const { synced } = await satellite.subscribe([shapeDef1])
    await synced

    try {
      const row = await adapter.query({
        sql: `SELECT id FROM "${namespace}"."${tablename}"`,
      })
      t.is(row.length, 1)
    } catch (e) {
      t.fail(JSON.stringify(e))
    }

    await t.throwsAsync(() => satellite.subscribe([shapeDef2]), {
      instanceOf: SatelliteError,
      code: SatelliteErrorCode.TABLE_NOT_FOUND,
    })
  })

  test("snapshot while not fully connected doesn't throw", async (t) => {
    const { adapter, runMigrations, satellite, client, authState, token } =
      t.context
    client.setStartReplicationDelayMs(100)

    await runMigrations()

    // Add log entry while offline
    await adapter.run({ sql: `INSERT INTO parent(id) VALUES ('1'),('2')` })

    const conn = await startSatellite(satellite, authState, token)

    // Performing a snapshot while the replication connection has not been stablished
    // should not throw
    await satellite._performSnapshot()

    await conn.connectionPromise

    await satellite._performSnapshot()

    t.pass()
  })

  test('unsubscribing all subscriptions does not trigger FK violations', async (t) => {
    const { satellite, runMigrations, builder } = t.context

    await runMigrations() // because the meta tables need to exist for shape GC

    // Create the 'users' and 'posts' tables expected by sqlite
    // populate it with foreign keys and check that the subscription
    // manager does not violate the FKs when unsubscribing from all subscriptions
    await satellite.adapter.runInTransaction(
      { sql: `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)` },
      {
        sql: `CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, author_id TEXT, FOREIGN KEY(author_id) REFERENCES users(id) ${builder.pgOnly(
          'DEFERRABLE INITIALLY IMMEDIATE'
        )})`,
      },
      { sql: `INSERT INTO users (id, name) VALUES ('u1', 'user1')` },
      {
        sql: `INSERT INTO posts (id, title, author_id) VALUES ('p1', 'My first post', 'u1')`,
      }
    )

    await satellite._clearTables([
      builder.makeQT('users'),
      builder.makeQT('posts'),
    ])
    // if we reach here, the FKs were not violated

    // Check that everything was deleted
    const users = await satellite.adapter.query({
      sql: 'SELECT * FROM users',
    })
    t.assert(users.length === 0)

    const posts = await satellite.adapter.query({
      sql: 'SELECT * FROM posts',
    })
    t.assert(posts.length === 0)
  })

  test("Garbage collecting the subscription doesn't generate oplog entries", async (t) => {
    const { adapter, runMigrations, satellite, authState, token, builder } =
      t.context
    await startSatellite(satellite, authState, token)
    await runMigrations()
    await adapter.run({ sql: `INSERT INTO parent(id) VALUES ('1'),('2')` })
    const ts = await satellite._performSnapshot()
    await satellite._garbageCollectOplog(ts)
    t.is((await satellite._getEntries(0)).length, 0)

    satellite._clearTables([builder.makeQT('parent')])

    await satellite._performSnapshot()
    t.deepEqual(await satellite._getEntries(0), [])
  })

  test('snapshots: generated oplog entries have the correct tags', async (t) => {
    const {
      client,
      satellite,
      adapter,
      tableInfo,
      runMigrations,
      authState,
      token,
      namespace,
    } = t.context
    await runMigrations()

    const tablename = 'parent'
    const qualified = new QualifiedTablename(namespace, tablename)

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData(tablename, parentRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    const shapeDef: Shape = {
      tablename,
    }

    satellite!.relations = relations
    const { synced } = await satellite.subscribe([shapeDef])
    await synced

    const expectedTs = new Date().getTime()
    const incoming = generateRemoteOplogEntry(
      tableInfo,
      namespace,
      'parent',
      OPTYPES.insert,
      expectedTs,
      genEncodedTags('remote', [expectedTs]),
      {
        id: 2,
      }
    )
    const incomingChange = opLogEntryToChange(incoming, relations)

    await satellite._applyTransaction({
      origin: 'remote',
      commit_timestamp: Long.fromNumber(expectedTs),
      changes: [incomingChange],
      lsn: new Uint8Array(),
    })

    const row = await adapter.query({
      sql: `SELECT id FROM ${qualified}`,
    })
    t.is(row.length, 2)

    const shadowRows = await adapter.query({
      sql: `SELECT * FROM _electric_shadow`,
    })
    t.is(shadowRows.length, 2)
    t.like(shadowRows[0], {
      namespace,
      tablename: 'parent',
    })

    await adapter.run({ sql: `DELETE FROM ${qualified} WHERE id = 2` })
    const deleteTx = await satellite._performSnapshot()

    const oplogs = await adapter.query({
      sql: `SELECT * FROM _electric_oplog`,
    })
    t.is(
      oplogs[0].clearTags,
      encodeTags([
        generateTag(satellite._authState!.clientId, deleteTx),
        generateTag('remote', expectedTs),
      ])
    )
  })

  test('DELETE after DELETE sends clearTags', async (t) => {
    const { adapter, runMigrations, satellite, authState } = t.context
    await runMigrations()

    await satellite._setAuthState(authState)

    await adapter.run({
      sql: `INSERT INTO parent(id, value) VALUES (1,'val1')`,
    })
    await adapter.run({
      sql: `INSERT INTO parent(id, value) VALUES (2,'val2')`,
    })

    await adapter.run({ sql: `DELETE FROM parent WHERE id=1` })

    await satellite._performSnapshot()

    await adapter.run({ sql: `DELETE FROM parent WHERE id=2` })

    await satellite._performSnapshot()

    const entries = await satellite._getEntries()

    t.is(entries.length, 4)

    const delete1 = entries[2]
    const delete2 = entries[3]

    t.is(delete1.primaryKey, '{"id":1}')
    t.is(delete1.optype, 'DELETE')
    // No tags for first delete
    t.is(delete1.clearTags, '[]')

    t.is(delete2.primaryKey, '{"id":2}')
    t.is(delete2.optype, 'DELETE')
    // The second should have clearTags
    t.not(delete2.clearTags, '[]')
  })

  test.serial('connection backoff success', async (t) => {
    t.plan(3)
    const { client, satellite } = t.context

    await client.shutdown()

    const retry = (_e: any, a: number) => {
      if (a > 0) {
        t.pass()
        return false
      }
      return true
    }

    satellite['_connectRetryHandler'] = retry

    await Promise.all(
      [satellite.connectWithBackoff(), satellite['initializing']?.waitOn()].map(
        (p) => p?.catch(() => t.pass())
      )
    )
  })

  test.serial('connection cancelled on disconnect', async (t) => {
    const { client, satellite, authState, token } = t.context
    await client.shutdown() // such that satellite can't connect to Electric and will keep retrying
    const { connectionPromise } = await startSatellite(
      satellite,
      authState,
      token
    )
    // We expect the connection to be cancelled
    const prom = t.throwsAsync(connectionPromise, {
      code: SatelliteErrorCode.CONNECTION_CANCELLED_BY_DISCONNECT,
    })

    // Disconnect Satellite
    satellite.clientDisconnect()

    // Await until the connection promise is rejected
    await prom
  })

  // check that performing snapshot doesn't throw without resetting the performing snapshot assertions
  test('(regression) performSnapshot handles exceptions gracefully', async (t) => {
    const { adapter, runMigrations, satellite, authState } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)

    const error = 'FAKE TRANSACTION'

    const txnFn = adapter.transaction
    adapter.transaction = () => {
      throw new Error(error)
    }

    try {
      await satellite._performSnapshot()
    } catch (e: any) {
      t.is(e.message, error)
      adapter.transaction = txnFn
    }

    await satellite._performSnapshot()
    t.pass()
  })

  test("don't leave a snapshot running when stopping", async (t) => {
    const { adapter, runMigrations, satellite, authState } = t.context
    await runMigrations()
    await satellite._setAuthState(authState)

    // Make the adapter slower, to interleave stopping the process and closing the db with a snapshot
    const transaction = satellite.adapter.transaction.bind(satellite.adapter)
    satellite.adapter.transaction = (f) =>
      new Promise((res) => {
        setTimeout(() => transaction(f).then(res), 500)
      })

    // Add something to the oplog
    await adapter.run({
      sql: `INSERT INTO parent(id, value) VALUES (1,'val1')`,
    })

    // // Perform snapshot with the mutex, to emulate a real scenario
    const snapshotPromise = satellite._mutexSnapshot()
    // Give some time to start the "slow" snapshot
    await sleepAsync(100)

    // Stop the process while the snapshot is being performed
    await satellite.stop()

    // Remove/close the database connection
    await cleanAndStopDb(t)

    // Wait for the snapshot to finish to consider the test successful
    await snapshotPromise

    t.pass()
  })

  test("don't snapshot after closing satellite process", async (t) => {
    // open and then immediately close
    // check that no snapshot is called after close
    const { satellite, authState, token } = t.context
    const { connectionPromise } = await startSatellite(
      satellite,
      authState,
      token
    )

    await connectionPromise
    await satellite.stop()

    satellite._performSnapshot = () => {
      t.fail('Snapshot was called')
      return Promise.resolve(new Date())
    }

    // wait some time to see that mutexSnapshot is not called
    await sleepAsync(50)

    t.pass()
  })

  test("don't schedule snapshots from polling interval when closing satellite process", async (t) => {
    const {
      adapter,
      runMigrations,
      satellite,
      authState,
      token,
      opts,
      builder,
    } = t.context

    await runMigrations()

    // Replace the snapshot function to simulate a slow snapshot
    // that access the database after closing
    satellite._performSnapshot = async () => {
      try {
        await sleepAsync(500)
        await adapter.query(builder.getLocalTableNames())
        return new Date()
      } catch (e) {
        t.fail()
        throw e
      }
    }

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    // Let the process schedule a snapshot
    await sleepAsync(opts.pollingInterval * 2)

    await satellite.stop()

    // Remove/close the database connection
    await cleanAndStopDb(t)

    // Wait for the snapshot to finish to consider the test successful
    await sleepAsync(1000)

    t.pass()
  })

  test('notifies for shape lifecycle', async (t) => {
    const { client, satellite, notifier, token } = t.context
    const { runMigrations, authState } = t.context
    await runMigrations()

    const shapeSubKey = 'foo'
    const shapeNotifications = () =>
      notifier.notifications.filter((n) => n.key !== undefined)

    // relations must be present at subscription delivery
    client.setRelations(relations)
    client.setRelationData('parent', parentRecord)
    client.setRelationData('child', childRecord)

    const conn = await startSatellite(satellite, authState, token)
    await conn.connectionPromise

    satellite!.relations = relations
    const { synced: syncedFirst } = await satellite.subscribe(
      [{ tablename: 'parent' }],
      shapeSubKey
    )

    await syncedFirst

    // 'establishing' and 'active'
    t.is(shapeNotifications().length, 2)

    // first one is establishing
    const firstNotification = shapeNotifications()[0]
    t.is(firstNotification.key, shapeSubKey)
    t.is(firstNotification.status.status, 'establishing')
    t.is(firstNotification.status.progress, 'receiving_data')
    const firstServerId = firstNotification.status.serverId
    t.true(typeof firstServerId === 'string')

    // second one is active
    const secondNotification = shapeNotifications()[1]
    t.is(secondNotification.key, shapeSubKey)
    t.is(secondNotification.status.status, 'active')
    t.is(secondNotification.status.serverId, firstServerId)

    // change existing sub to different shape
    const { synced: syncedSecond } = await satellite.subscribe(
      [{ tablename: 'child' }],
      shapeSubKey
    )

    // third one is a "mutation" one, receiving new data
    t.is(shapeNotifications().length, 3)
    const thirdNotifictiaon = shapeNotifications()[2]
    t.is(thirdNotifictiaon.key, shapeSubKey)
    t.is(thirdNotifictiaon.status.status, 'establishing')
    t.is(thirdNotifictiaon.status.progress, 'receiving_data')
    t.is(thirdNotifictiaon.status.oldServerId, firstServerId)
    const secondServerId = thirdNotifictiaon.status.serverId
    t.true(typeof secondServerId === 'string')

    await syncedSecond

    t.is(shapeNotifications().length, 5)

    // fourth one is another "mutation" one, removing old data
    const fourthNotifictiaon = shapeNotifications()[3]
    t.is(fourthNotifictiaon.key, shapeSubKey)
    t.is(fourthNotifictiaon.status.status, 'establishing')
    t.is(fourthNotifictiaon.status.progress, 'removing_data')
    t.is(fourthNotifictiaon.status.serverId, secondServerId)

    // fifth one should eventually get back to active
    const fifthNotification = shapeNotifications()[4]
    t.is(fifthNotification.key, shapeSubKey)
    t.is(fifthNotification.status.status, 'active')
    t.is(fifthNotification.status.serverId, secondServerId)

    // cancel subscription
    await satellite.unsubscribe([shapeSubKey])
    await sleepAsync(100)

    // sixth one first notifies of cancellation
    t.is(shapeNotifications().length, 7)
    const sixthNotification = shapeNotifications()[5]
    t.is(sixthNotification.key, shapeSubKey)
    t.is(sixthNotification.status.status, 'cancelling')
    t.is(sixthNotification.status.serverId, secondServerId)

    // last one should indicate that it is gone
    const seventhNotification = shapeNotifications()[6]
    t.is(seventhNotification.key, shapeSubKey)
    t.is(seventhNotification.status, undefined)
  })
}
