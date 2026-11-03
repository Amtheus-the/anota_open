import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { query } from '../db.js'
import { hasAccess } from '../middleware/auth.js'
import { hashKey } from './apiKeys.js'
import { loadFinancials, summarize } from '../services/financial.js'
import { HttpError } from '../utils/validators.js'

// API pública (somente leitura): outros sistemas leem os dados financeiros da conta dona da chave.
// Uso: Authorization: Bearer ag_...   (chamar de um servidor, nunca de dentro de um navegador)
const router = Router()

async function requireApiKey(req, _res, next) {
  const header = req.headers.authorization ?? ''
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!key.startsWith('ag_')) return next(new HttpError(401, 'Informe sua chave no cabeçalho Authorization: Bearer ag_...'))
  const [row] = await query(
    `SELECT k.id, k.active, u.id AS user_id, u.name, u.cpf, u.plan, u.plan_expires_at
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`,
    [hashKey(key)],
  )
  if (!row) return next(new HttpError(401, 'Chave inválida'))
  if (!row.active) return next(new HttpError(401, 'Chave desativada'))
  if (!hasAccess(row)) return next(new HttpError(402, 'A conta dona da chave não tem um plano ativo'))
  req.userId = row.user_id
  req.apiUserName = row.name
  query('UPDATE api_keys SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]).catch(() => {})
  next()
}

// o limite é por chave (cada sistema conectado tem o seu), não por IP
router.use(rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.headers.authorization ?? 'sem-chave').slice(0, 80) }))
router.use(requireApiKey)

router.get('/me', (req, res) => res.json({ name: req.apiUserName }))

router.get('/accounts', async (req, res) => {
  const { accounts, syncedAt } = await loadFinancials(req.userId)
  res.json({
    syncedAt,
    accounts: accounts.map((a) => ({ id: a.id, institution: a.institution, name: a.name, type: a.type, balance: a.balance, last4: a.last4, credit: a.credit })),
  })
})

// ?days=30 (1 a 90) e ?limit=100 (1 a 500)
router.get('/transactions', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const { transactions } = await loadFinancials(req.userId)
  const list = transactions
    .filter((t) => String(t.at).slice(0, 10) >= since)
    .slice(0, limit)
    .map((t) => ({
      date: String(t.at).slice(0, 10),
      description: t.description,
      amount: t.amount,
      type: t.type,
      category: t.categoryPt ?? t.category,
      institution: t.institution,
      accountId: t.accountId,
      installment: t.installment,
    }))
  res.json({ days, count: list.length, transactions: list })
})

router.get('/summary', async (req, res) => {
  const data = await loadFinancials(req.userId)
  res.json({ syncedAt: data.syncedAt, summary: summarize(data) })
})

export default router
