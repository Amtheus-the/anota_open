import crypto from 'node:crypto'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { pool, query } from '../db.js'
import { config } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { HttpError } from '../utils/validators.js'
import * as asaas from '../services/asaas.js'

const router = Router()

const PLAN = 'pro'
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest()
const tokenMatches = (given) => Boolean(config.asaas.webhookToken) && crypto.timingSafeEqual(sha(given), sha(config.asaas.webhookToken))

// Soma um mês de plano (a partir do fim do plano atual, se ainda vale, ou de hoje) e guarda o pagamento.
// external_id é único: se o Asaas avisar duas vezes do mesmo pagamento, só a primeira conta.
async function creditPayment({ userId, amount, externalId }) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [inserted] = await connection.execute(
      "INSERT IGNORE INTO payments (user_id, plan, months, amount, method, note, external_id) VALUES (?, ?, 1, ?, 'pix', 'Pix Automático (Asaas)', ?)",
      [userId, PLAN, amount, externalId],
    )
    if (inserted.affectedRows > 0) {
      await connection.execute(
        `UPDATE users SET plan = ?,
           plan_expires_at = DATE_ADD(GREATEST(CURDATE(), COALESCE(plan_expires_at, CURDATE())), INTERVAL 1 MONTH)
         WHERE id = ?`,
        [PLAN, userId],
      )
    }
    await connection.commit()
    return inserted.affectedRows > 0
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

const AUTHORIZATION_STATUS = {
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED: 'active',
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED: 'refused',
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED: 'cancelled',
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_EXPIRED: 'expired',
}

async function handleEvent(body) {
  const event = body?.event
  if (AUTHORIZATION_STATUS[event] && body.authorization?.id) {
    const status = AUTHORIZATION_STATUS[event]
    await query(
      `UPDATE subscriptions SET status = ?,
         activated_at = IF(? = 'active', NOW(), activated_at),
         cancelled_at = IF(? = 'cancelled', NOW(), cancelled_at)
       WHERE asaas_authorization_id = ?`,
      [status, status, status, body.authorization.id],
    )
    return
  }

  const payment = body?.payment
  if (!payment?.id) return
  if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
    // só cobranças de clientes que criamos (a conta do Asaas pode ter outras cobranças)
    const [subscription] = await query('SELECT user_id FROM subscriptions WHERE asaas_customer_id = ? AND user_id IS NOT NULL ORDER BY id DESC LIMIT 1', [payment.customer])
    if (!subscription) return
    const amount = Number(payment.value)
    if (!Number.isFinite(amount) || amount <= 0) return
    await creditPayment({ userId: subscription.user_id, amount, externalId: String(payment.id) })
  } else if (event === 'PAYMENT_REFUNDED') {
    await query("UPDATE payments SET status = 'refunded' WHERE external_id = ?", [String(payment.id)])
  }
}

// Webhook do Asaas. O token no cabeçalho impede que qualquer pessoa finja ser o Asaas.
// Responde 500 se der erro no banco, para o Asaas tentar de novo (o processamento é idempotente).
router.post('/webhook', async (req, res) => {
  if (!tokenMatches(req.get('asaas-access-token') ?? '')) return res.status(404).end()
  try {
    await handleEvent(req.body)
  } catch (err) {
    console.error('[billing] falha ao processar webhook:', req.body?.event, err.message)
    return res.status(500).end()
  }
  res.json({ ok: true })
})

// daqui para baixo: só quem está logado (inclusive quem está com o teste vencido, que precisa conseguir assinar)
router.use(requireAuth)
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }))

const latestSubscription = async (userId) => {
  const [row] = await query('SELECT id, status, asaas_authorization_id AS authorizationId, created_at FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId])
  return row ?? null
}

router.get('/status', async (req, res) => {
  const subscription = await latestSubscription(req.userId)
  const [user] = await query('SELECT plan, plan_expires_at FROM users WHERE id = ?', [req.userId])
  res.json({
    available: asaas.asaasConfigured(),
    price: config.plans[PLAN],
    subscription: subscription ? { status: subscription.status } : null,
    plan: user?.plan ?? 'free',
    planExpiresAt: user?.plan_expires_at ?? null,
  })
})

// Começa a assinatura: devolve o QR Code do primeiro Pix (que também autoriza os próximos)
router.post('/subscribe', async (req, res) => {
  if (!asaas.asaasConfigured()) throw new HttpError(503, 'A assinatura ainda não está disponível. Tente mais tarde')
  const current = await latestSubscription(req.userId)
  if (current?.status === 'active') throw new HttpError(409, 'Você já tem uma assinatura ativa')

  const [user] = await query('SELECT id, name, cpf, phone, email FROM users WHERE id = ?', [req.userId])
  const [known] = await query('SELECT asaas_customer_id AS id FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.userId])
  const customerId = known?.id ?? (await asaas.createCustomer({
    name: user.name ?? 'Cliente Anota Grana',
    cpf: user.cpf,
    email: user.email,
    phone: user.phone,
    userId: user.id,
  })).id

  const value = config.plans[PLAN]
  const authorization = await asaas.createAuthorization({
    customerId,
    contractId: `ag-${user.id}-${Date.now().toString(36)}`.slice(0, 35),
    value,
    startDate: new Date().toLocaleDateString('sv-SE'),
    description: 'Anota Grana Pro',
  })
  await query(
    'INSERT INTO subscriptions (user_id, plan, value, asaas_customer_id, asaas_authorization_id) VALUES (?, ?, ?, ?, ?)',
    [user.id, PLAN, value, customerId, authorization.id],
  )
  res.status(201).json({
    price: value,
    payload: authorization.payload,
    qrCode: authorization.encodedImage,
    expiresAt: authorization.immediateQrCode?.expirationDate ?? null,
  })
})

// Cancela a autorização: nada mais é cobrado, e o plano segue até o fim do período já pago
router.delete('/subscription', async (req, res) => {
  const current = await latestSubscription(req.userId)
  if (!current || current.status !== 'active') throw new HttpError(404, 'Você não tem uma assinatura ativa')
  await asaas.cancelAuthorization(current.authorizationId)
  await query("UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?", [current.id])
  res.status(204).end()
})

export default router
