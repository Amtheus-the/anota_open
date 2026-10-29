import { Router } from 'express'
import { query } from '../db.js'
import { config } from '../config.js'
import { requireAuth, requireAccess } from '../middleware/auth.js'
import * as pluggy from '../services/openFinance.js'
import { HttpError } from '../utils/validators.js'
import { ensureUserName } from '../services/identity.js'
import { clearFinancialsCache, safeFinancials } from '../services/financial.js'

const router = Router()
router.use(requireAuth)

const DATE = /^\d{4}-\d{2}-\d{2}$/

async function ownConnection(userId, id) {
  const [row] = await query('SELECT * FROM connected_accounts WHERE id = ? AND user_id = ?', [id, userId])
  if (!row) throw new HttpError(404, 'Conexão não encontrada')
  return row
}

async function syncStatus(connection, item) {
  const status = pluggy.mapItemStatus(item)
  if (status !== connection.status) {
    await query('UPDATE connected_accounts SET status = ? WHERE id = ?', [status, connection.id])
  }
  return status
}

// Bancos e corretoras disponíveis para conectar
router.get('/institutions', async (_req, res) => {
  res.json({ institutions: await pluggy.listInstitutions() })
})

// 1) O usuário escolheu o banco e confirmou: cria o Item no fluxo OAuth
router.post('/connections/start', requireAccess, async (req, res) => {
  const connectorId = Number(req.body.connectorId)
  const institutions = await pluggy.listInstitutions()
  const institution = institutions.find((i) => i.id === connectorId)
  if (!institution) throw new HttpError(400, 'Instituição inválida')

  const [user] = await query('SELECT cpf FROM users WHERE id = ?', [req.userId])
  const item = await pluggy.createItem({
    institution,
    cpf: institution.sandbox ? pluggy.SANDBOX_CPF : user.cpf,
    userId: req.userId,
    redirectUri: config.frontendUrl.startsWith('https://') ? `${config.frontendUrl}/connections/callback` : undefined,
  })

  await query(
    `INSERT INTO connected_accounts (user_id, institution, provider_item_id, status)
     VALUES (?, ?, ?, 'pending')
     ON DUPLICATE KEY UPDATE institution = VALUES(institution), status = 'pending'`,
    [req.userId, institution.name, item.id],
  )
  const [row] = await query(
    'SELECT id, institution, status, created_at FROM connected_accounts WHERE user_id = ? AND provider_item_id = ?',
    [req.userId, item.id],
  )
  res.status(201).json({ connection: row })
})

// 2) O front consulta até a URL de autorização do banco (QR Code) ficar pronta
router.get('/connections/:id/authorization', async (req, res) => {
  const connection = await ownConnection(req.userId, req.params.id)
  const item = await pluggy.getItem(connection.provider_item_id)
  const status = await syncStatus(connection, item)

  if (status === 'connected') return res.json({ state: 'connected' })
  if (status === 'error') return res.json({ state: 'error', message: 'O banco não concluiu a conexão. Tente de novo.' })

  const authorization = pluggy.oauthAuthorization(item)
  if (authorization) return res.json({ state: 'ready', authorizationUrl: authorization.url, expiresAt: authorization.expiresAt })
  res.json({ state: 'waiting' })
})

router.get('/connections', async (req, res) => {
  const listSql = 'SELECT id, institution, status, created_at FROM connected_accounts WHERE user_id = ? ORDER BY id DESC'
  let rows = await query(listSql, [req.userId])

  // conexões ainda "pendentes" (ex.: a página foi recarregada no meio) são conferidas na Pluggy,
  // para que uma conexão que já terminou não fique para sempre como pendente
  const pending = rows.filter((row) => row.status === 'pending')
  if (pending.length > 0) {
    await Promise.allSettled(
      pending.map(async (row) => {
        const connection = await ownConnection(req.userId, row.id)
        await syncStatus(connection, await pluggy.getItem(connection.provider_item_id))
      }),
    )
    rows = await query(listSql, [req.userId])
  }

  // o logo vem da lista de instituições (em cache); se ela falhar, a conexão aparece sem logo
  const institutions = await pluggy.listInstitutions().catch(() => [])
  res.json({
    connections: rows.map((row) => ({
      ...row,
      imageUrl: institutions.find((i) => i.name === row.institution)?.imageUrl ?? null,
    })),
  })
})

// Andamento da sincronização depois de autorizar: syncing -> validating -> transactions -> done
router.get('/connections/:id/sync', async (req, res) => {
  const connection = await ownConnection(req.userId, req.params.id)
  const item = await pluggy.getItem(connection.provider_item_id)
  const status = await syncStatus(connection, item)

  if (status === 'error') return res.json({ phase: 'error', message: 'Não foi possível sincronizar essa conta.' })
  if (status !== 'connected') return res.json({ phase: 'syncing' })

  clearFinancialsCache(req.userId)
  await ensureUserName(req.userId)
  const { accounts, transactions } = await safeFinancials(req.userId)
  const mine = accounts.filter((a) => a.institution === connection.institution)
  if (mine.length === 0) return res.json({ phase: 'validating' })
  if (transactions.length === 0) return res.json({ phase: 'transactions', accounts: mine.length })
  res.json({ phase: 'done', accounts: mine.length, transactions: transactions.length })
})

// Andamento da conexão (usado na volta do banco, até virar "connected")
router.get('/connections/:id', async (req, res) => {
  const connection = await ownConnection(req.userId, req.params.id)
  const item = await pluggy.getItem(connection.provider_item_id)
  const status = await syncStatus(connection, item)
  res.json({ id: connection.id, institution: connection.institution, status, pluggyStatus: item.status })
})

router.get('/connections/:id/accounts', async (req, res) => {
  const connection = await ownConnection(req.userId, req.params.id)
  const accounts = await pluggy.getAccounts(connection.provider_item_id)
  res.json({
    accounts: accounts.map((a) => ({
      id: a.id, type: a.type, subtype: a.subtype, name: a.name, balance: a.balance, currencyCode: a.currencyCode,
    })),
  })
})

router.delete('/connections/:id', async (req, res) => {
  const connection = await ownConnection(req.userId, req.params.id)
  // revoga o consentimento na Pluggy; se ela falhar, a conexão sai daqui mesmo assim
  if (connection.provider_item_id) await pluggy.deleteItem(connection.provider_item_id).catch((err) => console.error('[pluggy] não revogou o item:', err.message))
  await query('DELETE FROM connected_accounts WHERE id = ?', [connection.id])
  clearFinancialsCache(req.userId)
  res.status(204).end()
})

router.get('/accounts/:accountId/transactions', async (req, res) => {
  const { dateFrom, dateTo } = req.query
  if ((dateFrom && !DATE.test(dateFrom)) || (dateTo && !DATE.test(dateTo))) {
    throw new HttpError(400, 'Use datas no formato aaaa-mm-dd')
  }

  // a conta precisa pertencer a uma conexão deste usuário
  const account = await pluggy.getAccount(req.params.accountId)
  const [owned] = await query('SELECT id FROM connected_accounts WHERE user_id = ? AND provider_item_id = ?', [req.userId, account.itemId])
  if (!owned) throw new HttpError(404, 'Conta não encontrada')

  const transactions = await pluggy.getTransactions(req.params.accountId, { dateFrom, dateTo })
  res.json({
    transactions: transactions.map((t) => ({
      id: t.id, date: t.date, description: t.description, amount: t.amount, type: t.type, category: t.category, status: t.status,
    })),
  })
})

export default router
