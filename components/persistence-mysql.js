import { ConflictError, DshPluginError, IdempotencyConflictError, TenantContextError } from '../lib/errors.js'
import { IdempotencyLedger } from '../lib/idempotency.js'
import { registerService } from '../lib/register.js'

export const id = 'dsh-persistence-mysql'

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dsh_session (
  user_id VARCHAR(191) NOT NULL,
  session_id VARCHAR(191) NOT NULL,
  dsh_session_id VARCHAR(191) NULL,
  device_id VARCHAR(191) NULL,
  workspace_id VARCHAR(191) NULL,
  status VARCHAR(32) NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL,
  deleted_at TIMESTAMP(6) NULL,
  PRIMARY KEY (user_id, session_id),
  KEY idx_dsh_session_updated (user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dsh_message (
  user_id VARCHAR(191) NOT NULL,
  conversation_id VARCHAR(191) NOT NULL,
  seq BIGINT NOT NULL,
  role VARCHAR(32) NOT NULL,
  content_json JSON NOT NULL,
  content_hash CHAR(64) NULL,
  request_id VARCHAR(191) NULL,
  created_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (user_id, conversation_id, seq),
  UNIQUE KEY uq_dsh_message_request (user_id, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dsh_user_setting (
  user_id VARCHAR(191) NOT NULL,
  namespace VARCHAR(191) NOT NULL,
  setting_key VARCHAR(191) NOT NULL,
  value_json JSON NOT NULL,
  schema_version INT NOT NULL DEFAULT 1,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (user_id, namespace, setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dsh_user_model (
  user_id VARCHAR(191) NOT NULL,
  model_id VARCHAR(191) NOT NULL,
  provider VARCHAR(191) NOT NULL,
  endpoint VARCHAR(2048) NOT NULL,
  credential_ref VARCHAR(191) NOT NULL,
  policy_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (user_id, model_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dsh_plugin_config (
  user_id VARCHAR(191) NOT NULL,
  plugin_id VARCHAR(191) NOT NULL,
  config_scope VARCHAR(191) NOT NULL,
  config_json JSON NULL,
  encrypted_blob LONGBLOB NULL,
  schema_version INT NOT NULL DEFAULT 1,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (user_id, plugin_id, config_scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dsh_idempotency (
  user_id VARCHAR(191) NOT NULL,
  operation VARCHAR(191) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  result_json JSON NULL,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL,
  expires_at TIMESTAMP(6) NULL,
  PRIMARY KEY (user_id, operation, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dsh_schema_history (
  version VARCHAR(191) NOT NULL PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  installed_at TIMESTAMP(6) NOT NULL,
  success BOOLEAN NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`

function requiredTenant(context) {
  if (!context?.userId) throw new TenantContextError()
  return context.userId
}

export class MysqlPersistenceProvider {
  constructor({ pool, now = () => new Date(), schema = 'dsh' } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new DshPluginError('MYSQL_POOL_REQUIRED', 'Inject a mysql2-compatible pool; credentials are not read from plugin files')
    this.pool = pool
    this.now = now
    this.schema = schema
    this.idempotency = new IdempotencyLedger()
  }

  async health() {
    await this.pool.query('SELECT 1 AS ok')
    return { ok: true, provider: 'mysql', schema: this.schema }
  }

  async transaction(work) {
    if (typeof this.pool.getConnection !== 'function') return work(this.pool)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const result = await work(connection)
      await connection.commit()
      return result
    } catch (error) {
      try { await connection.rollback() } catch {}
      throw error
    } finally {
      connection.release()
    }
  }

  async getSetting(context, namespace, settingKey) {
    const userId = requiredTenant(context)
    const [rows] = await this.pool.query(`SELECT * FROM ${this.schema}.dsh_user_setting WHERE user_id=? AND namespace=? AND setting_key=?`, [userId, namespace, settingKey])
    return rows[0] || null
  }

  async putSetting(context, { namespace, settingKey, value, expectedVersion = undefined, schemaVersion = 1 }) {
    const userId = requiredTenant(context)
    const current = await this.getSetting(context, namespace, settingKey)
    if (current && expectedVersion !== undefined && Number(current.version) !== Number(expectedVersion)) throw new ConflictError()
    const version = current ? Number(current.version) + 1 : 0
    await this.pool.query(`INSERT INTO ${this.schema}.dsh_user_setting (user_id,namespace,setting_key,value_json,schema_version,version,updated_at) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),schema_version=VALUES(schema_version),version=VALUES(version),updated_at=VALUES(updated_at)`, [userId, namespace, settingKey, JSON.stringify(value), schemaVersion, version, this.now()])
    return { userId, namespace, settingKey, value, version }
  }

  async appendMessage(context, { conversationId, seq, role, content, requestId = undefined, contentHash = undefined }) {
    const userId = requiredTenant(context)
    if (!conversationId || !Number.isInteger(seq) || seq < 0) throw new DshPluginError('INVALID_MESSAGE', 'conversationId and non-negative integer seq are required')
    const key = requestId || `${conversationId}:${seq}`
    return this.idempotency.run({ userId, operation: 'conversation.append', key, requestHash: JSON.stringify({ conversationId, seq, role, content, contentHash }), action: async () => {
      await this.pool.query(`INSERT INTO ${this.schema}.dsh_message (user_id,conversation_id,seq,role,content_json,content_hash,request_id,created_at) VALUES (?,?,?,?,?,?,?,?)`, [userId, conversationId, seq, role, JSON.stringify(content), contentHash, requestId, this.now()])
      return { userId, conversationId, seq }
    }})
  }

  async runIdempotent(context, operation, key, requestHash, action) {
    return this.idempotency.run({ userId: requiredTenant(context), operation, key, requestHash, action })
  }
}

export function apply(ctx, config = {}) {
  if (!config.pool) return registerService(ctx, id, { status: 'disabled', reason: 'pool-injection-required', schemaSql: SCHEMA_SQL })
  return registerService(ctx, id, new MysqlPersistenceProvider(config))
}

