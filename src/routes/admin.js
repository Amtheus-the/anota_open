import { Router } from 'express'
import { pool, query } from '../db.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { HttpError } from '../utils/validators.js'

const router = Router()
router.use(requireAuth, requireAdmin)

// preços mensais de tabela (mesmos da página de planos)
const PLAN_PRICES = { pro: 14.9, premium: 34.9 }
const METHODS = ['pix', 'cartao', 'dinheiro', 'outro']
const PAGE_SIZE = 20

// plano pago e dentro da validade
const ACTIVE = '(u.plan_expires_at IS NULL OR u.plan_expires_at >= CURDATE())'
const PAYING = `u.plan IN ('pro','premium') AND ${ACTIVE}`
const TRIAL = `u.plan = 'trial' AND ${ACTIVE}`
// teste que acabou sem virar assinatura, ou plano pago vencido/cancelado
const LAPSED = `NOT (${PAYING}) AND NOT (${TRIAL})`

const money = (value) => Math.round(Number(value ?? 0) * 100) / 100
const count = (value) => Number(value ?? 0)

// últimos `n` dias/meses sem buracos, para o gráfico não pular datas sem movimento
function fillSeries(rows, keys) {
  const byKey = new Map(rows.map((r) => [r.k, r.v]))
  return keys.map((k) => ({ key: k, value: Number(byKey.get(k) ?? 0) }))
}
const isoDay = (date) => date.toLocaleDateString('sv-SE')

router.get('/overview', async (_req, res) => {
  const [users] = await query(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(created_at >= CURDATE()), 0) AS today,
      COALESCE(SUM(created_at >= NOW() - INTERVAL 7 DAY), 0) AS week,
      COALESCE(SUM(created_at >= NOW() - INTERVAL 30 DAY), 0) AS month,
      COALESCE(SUM(${PAYING}), 0) AS paying,
      COALESCE(SUM(${TRIAL}), 0) AS trial,
      COALESCE(SUM(${TRIAL} AND u.plan_expires_at <= CURDATE() + INTERVAL 7 DAY), 0) AS trialEnding,
      COALESCE(SUM(${PAYING} AND u.plan_expires_at IS NOT NULL AND u.plan_expires_at <= CURDATE() + INTERVAL 7 DAY), 0) AS expiring
    FROM users u`)
  const payingByPlan = await query(`SELECT u.plan, COUNT(*) AS n FROM users u WHERE ${PAYING} GROUP BY u.plan`)
  const [active] = await query("SELECT COUNT(DISTINCT user_id) AS n FROM chat_messages WHERE role = 'user' AND created_at >= NOW() - INTERVAL 7 DAY")
  const [banks] = await query("SELECT COUNT(DISTINCT user_id) AS n FROM connected_accounts WHERE status = 'connected'")
  const [whatsapp] = await query("SELECT COUNT(DISTINCT user_id) AS n FROM conversations WHERE title = 'WhatsApp'")
  const [agents] = await query('SELECT COUNT(DISTINCT user_id) AS n FROM user_agents WHERE active = 1')
  const [messages] = await query(`
    SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= NOW() - INTERVAL 7 DAY), 0) AS week
    FROM chat_messages WHERE role = 'user'`)

  const [revenue] = await query(`
    SELECT COALESCE(SUM(amount), 0) AS total,
      COALESCE(SUM(CASE WHEN paid_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN amount END), 0) AS month,
      COUNT(*) AS payments
    FROM payments WHERE status = 'paid'`)
  const monthly = await query(`
    SELECT DATE_FORMAT(paid_at, '%Y-%m') AS k, SUM(amount) AS v
    FROM payments WHERE status = 'paid' AND paid_at >= DATE_FORMAT(CURDATE() - INTERVAL 5 MONTH, '%Y-%m-01')
    GROUP BY k`)
  const signups = await query(`
    SELECT DATE(created_at) AS k, COUNT(*) AS v
    FROM users WHERE created_at >= CURDATE() - INTERVAL 29 DAY GROUP BY k`)
  const recentPayments = await query(`
    SELECT p.id, p.plan, p.months, p.amount, p.method, p.status, p.paid_at, u.name, u.email
    FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 10`)

  const now = new Date()
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const days = Array.from({ length: 30 }, (_, i) => isoDay(new Date(now.getTime() - (29 - i) * 86_400_000)))

  const mrr = payingByPlan.reduce((sum, row) => sum + count(row.n) * (PLAN_PRICES[row.plan] ?? 0), 0)
  const total = count(users.total)
  const paying = count(users.paying)

  res.json({
    users: {
      total,
      today: count(users.today),
      week: count(users.week),
      month: count(users.month),
      paying,
      trial: count(users.trial),
      trialEnding: count(users.trialEnding),
      lapsed: total - paying - count(users.trial),
      expiring: count(users.expiring),
      active7d: count(active.n),
      withBank: count(banks.n),
      onWhatsapp: count(whatsapp.n),
      withAgents: count(agents.n),
      // de quem já terminou o teste, quantos assinaram
      conversion: total - count(users.trial) > 0 ? Math.round((paying / (total - count(users.trial))) * 1000) / 10 : 0,
    },
    messages: { total: count(messages.total), week: count(messages.week) },
    revenue: {
      total: money(revenue.total),
      month: money(revenue.month),
      payments: count(revenue.payments),
      mrr: money(mrr),
      arpu: paying > 0 ? money(mrr / paying) : 0,
      byMonth: fillSeries(monthly, months).map((m) => ({ ...m, value: money(m.value) })),
    },
    signupsByDay: fillSeries(signups.map((r) => ({ k: String(r.k).slice(0, 10), v: r.v })), days),
    recentPayments,
  })
})

router.get('/users', async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const search = String(req.query.q ?? '').trim().slice(0, 80)
  const filter = req.query.filter
  const where = []
  const params = []
  if (search) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.cpf LIKE ?)')
    params.push(...Array(4).fill(`%${search}%`))
  }
  if (filter === 'paying') where.push(`(${PAYING})`)
  if (filter === 'trial') where.push(`(${TRIAL})`)
  if (filter === 'lapsed') where.push(`(${LAPSED})`)
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM users u ${clause}`, params)
  const rows = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.created_at, u.plan, u.plan_expires_at,
      (${PAYING}) AS paying,
      (${TRIAL}) AS trial,
      (SELECT COUNT(*) FROM connected_accounts c WHERE c.user_id = u.id AND c.status = 'connected') AS banks,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.user_id = u.id AND m.role = 'user') AS messages,
      (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.user_id = u.id) AS last_activity,
      (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS paid_total
     FROM users u ${clause} ORDER BY u.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
    params,
  )
  res.json({
    page,
    pages: Math.max(1, Math.ceil(count(n) / PAGE_SIZE)),
    total: count(n),
    users: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      createdAt: u.created_at,
      plan: u.plan,
      planExpiresAt: u.plan_expires_at,
      paying: Boolean(Number(u.paying)),
      trial: Boolean(Number(u.trial)),
      banks: count(u.banks),
      messages: count(u.messages),
      lastActivity: u.last_activity,
      paidTotal: money(u.paid_total),
    })),
  })
})

async function findUser(id) {
  const [user] = await query('SELECT id FROM users WHERE id = ?', [Number(id) || 0])
  if (!user) throw new HttpError(404, 'Usuário não encontrado')
  return user.id
}

// Registra um pagamento (ex.: Pix de um amigo) e libera/renova o plano pelos meses pagos
router.post('/users/:id/payments', async (req, res) => {
  const userId = await findUser(req.params.id)
  const plan = String(req.body.plan ?? 'pro')
  if (!PLAN_PRICES[plan]) throw new HttpError(400, 'Plano inválido')
  const months = Number.parseInt(req.body.months ?? 1, 10)
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new HttpError(400, 'Meses inválidos (1 a 24)')
  const amount = req.body.amount === undefined || req.body.amount === '' ? PLAN_PRICES[plan] * months : Number(req.body.amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new HttpError(400, 'Valor inválido')
  const method = METHODS.includes(req.body.method) ? req.body.method : 'pix'
  const note = String(req.body.note ?? '').trim().slice(0, 255) || null

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute('INSERT INTO payments (user_id, plan, months, amount, method, note) VALUES (?, ?, ?, ?, ?, ?)', [
      userId, plan, months, money(amount), method, note,
    ])
    // renova a partir do fim do plano atual (se ainda vale) ou de hoje
    await connection.execute(
      `UPDATE users SET plan = ?,
         plan_expires_at = DATE_ADD(GREATEST(CURDATE(), COALESCE(plan_expires_at, CURDATE())), INTERVAL ? MONTH)
       WHERE id = ?`,
      [plan, months, userId],
    )
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
  res.status(201).json({ ok: true })
})

// Ajuste manual do plano (cortesia ou cancelamento): free zera a validade
router.patch('/users/:id/plan', async (req, res) => {
  const userId = await findUser(req.params.id)
  const plan = String(req.body.plan ?? '')
  if (plan !== 'free' && !PLAN_PRICES[plan]) throw new HttpError(400, 'Plano inválido')
  let expiresAt = null
  if (plan !== 'free' && req.body.expiresAt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresAt) || Number.isNaN(Date.parse(req.body.expiresAt))) throw new HttpError(400, 'Data inválida')
    expiresAt = req.body.expiresAt
  }
  await query('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?', [plan, expiresAt, userId])
  res.json({ ok: true })
})

router.post('/payments/:id/refund', async (req, res) => {
  const result = await query("UPDATE payments SET status = 'refunded' WHERE id = ? AND status = 'paid'", [Number(req.params.id) || 0])
  if (result.affectedRows === 0) throw new HttpError(404, 'Pagamento não encontrado ou já estornado')
  res.json({ ok: true })
})

export default router
