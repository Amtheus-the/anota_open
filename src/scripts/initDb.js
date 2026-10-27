import { readFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { config } from '../config.js'

const { database, ...conn } = config.db
const schema = await readFile(new URL('../../sql/schema.sql', import.meta.url), 'utf8')

// Bancos criados antes das conversas: adiciona conversation_id e agrupa o histórico antigo
// de cada usuário numa conversa, para nada se perder. Pode rodar várias vezes.
async function migrateWidgets(connection) {
  const [columns] = await connection.query(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'chat_messages' AND column_name = 'widgets'",
    [database],
  )
  if (columns[0].n === 0) {
    await connection.query('ALTER TABLE chat_messages ADD COLUMN widgets MEDIUMTEXT NULL AFTER content, ADD COLUMN steps INT UNSIGNED NOT NULL DEFAULT 0 AFTER widgets')
    console.log('Colunas widgets e steps adicionadas.')
  }
}

async function migrateConversations(connection) {
  const [columns] = await connection.query(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'chat_messages' AND column_name = 'conversation_id'",
    [database],
  )
  if (columns[0].n === 0) {
    await connection.query('ALTER TABLE chat_messages ADD COLUMN conversation_id INT UNSIGNED NULL AFTER user_id')
    await connection.query(
      'ALTER TABLE chat_messages ADD CONSTRAINT fk_chat_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE',
    )
    await connection.query('ALTER TABLE chat_messages ADD INDEX idx_conversation (conversation_id, id)')
    console.log('Coluna conversation_id adicionada.')
  }

  const [orphans] = await connection.query('SELECT DISTINCT user_id FROM chat_messages WHERE conversation_id IS NULL')
  for (const { user_id: userId } of orphans) {
    const [[first]] = await connection.query(
      "SELECT content FROM chat_messages WHERE user_id = ? AND conversation_id IS NULL AND role = 'user' ORDER BY id LIMIT 1",
      [userId],
    )
    const title = (first?.content ?? 'Conversa anterior').slice(0, 60)
    const [created] = await connection.query('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [userId, title])
    await connection.query('UPDATE chat_messages SET conversation_id = ? WHERE user_id = ? AND conversation_id IS NULL', [created.insertId, userId])
    console.log(`Histórico antigo do usuário ${userId} movido para uma conversa.`)
  }
}

// Em hospedagem compartilhada o banco já existe (criado no painel) e o usuário não pode dar CREATE DATABASE:
// por isso tenta conectar direto no banco e só o cria se ele realmente não existir.
async function connect() {
  try {
    return await mysql.createConnection({ ...conn, database, multipleStatements: true })
  } catch (err) {
    if (err.code !== 'ER_BAD_DB_ERROR') throw err
    const admin = await mysql.createConnection({ ...conn, multipleStatements: true })
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`)
    } finally {
      await admin.end()
    }
    return mysql.createConnection({ ...conn, database, multipleStatements: true })
  }
}

// Bancos criados antes dos avisos dos agentes: acrescenta a data da última execução
async function migrateAgentRuns(connection) {
  const [columns] = await connection.query(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'user_agents' AND column_name = 'last_run_date'",
    [database],
  )
  if (columns[0].n === 0) {
    await connection.query('ALTER TABLE user_agents ADD COLUMN last_run_date DATE NULL AFTER active')
    console.log('Coluna last_run_date adicionada.')
  }
}

const connection = await connect()
try {
  await connection.query(schema)
  await migrateConversations(connection)
  await migrateWidgets(connection)
  await migrateAgentRuns(connection)
  console.log(`Banco "${database}" pronto.`)
} catch (err) {
  console.error('Falha ao preparar o banco:', err.message)
  process.exitCode = 1
} finally {
  await connection.end()
}
