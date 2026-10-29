import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { query } from '../db.js'
import { signToken, verifyToken, requireAuth, isAdminCpf, planActive } from '../middleware/auth.js'
import { config } from '../config.js'
import { deleteItem } from '../services/openFinance.js'
import { ensureUserName } from '../services/identity.js'
import { sendCode, checkCode } from '../services/verification.js'
import {
  HttpError, onlyDigits, validCpf, normalizePhone, validPhone, validEmail, parseBirthDate,
} from '../utils/validators.js'

const router = Router()

const publicUser = (u) => ({ id: u.id, name: u.name, cpf: u.cpf, phone: u.phone, email: u.email, isAdmin: isAdminCpf(u.cpf),
  plan: u.plan, planExpiresAt: u.plan_expires_at ?? null, planActive: isAdminCpf(u.cpf) || planActive(u),
})

const isAdult = (birth) => {
  const limit = new Date()
  limit.setFullYear(limit.getFullYear() - 18)
  return new Date(`${birth}T00:00:00`) <= limit
}

// Etapa 1 do cadastro: celular + CPF -> envia o código
router.post('/register/start', async (req, res) => {
  const cpf = onlyDigits(req.body.cpf)
  const phone = normalizePhone(req.body.phone)
  if (!validPhone(phone)) throw new HttpError(400, 'Celular inválido')
  if (!validCpf(cpf)) throw new HttpError(400, 'CPF inválido')

  const [taken] = await query('SELECT id FROM users WHERE cpf = ? OR phone = ? LIMIT 1', [cpf, phone])
  if (taken) throw new HttpError(409, 'Já existe uma conta com esse CPF ou celular')

  await sendCode(phone)
  res.json({ ok: true })
})

// Etapa 2: confere o código -> devolve um token curto que só vale para concluir o cadastro
router.post('/register/verify', async (req, res) => {
  const cpf = onlyDigits(req.body.cpf)
  const phone = normalizePhone(req.body.phone)
  if (!validPhone(phone) || !validCpf(cpf)) throw new HttpError(400, 'Dados inválidos')

  await checkCode(phone, req.body.code)
  const registrationToken = signToken({ type: 'registration', cpf, phone }, '30m')
  res.json({ registrationToken })
})

// Etapas 3 e 4: senha, e-mail e nascimento -> cria a conta e já entra
router.post('/register/complete', async (req, res) => {
  const { registrationToken, password, email, birthDate, acceptTerms } = req.body
  const claims = verifyToken(registrationToken)
  if (claims.type !== 'registration') throw new HttpError(401, 'Token inválido')

  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'A senha precisa ter ao menos 8 caracteres')
  if (!validEmail(email)) throw new HttpError(400, 'E-mail inválido')
  const birth = parseBirthDate(birthDate)
  if (!birth) throw new HttpError(400, 'Data de nascimento inválida')
  if (!isAdult(birth)) throw new HttpError(400, 'O Anota Grana é para maiores de 18 anos')
  if (acceptTerms !== true) throw new HttpError(400, 'Aceite os Termos de Uso e a Política de Privacidade para criar a conta')

  const [taken] = await query('SELECT id FROM users WHERE cpf = ? OR phone = ? OR email = ? LIMIT 1', [
    claims.cpf, claims.phone, email.toLowerCase(),
  ])
  if (taken) throw new HttpError(409, 'Já existe uma conta com esses dados')

  const passwordHash = await bcrypt.hash(password, 12)
  const result = await query(
    "INSERT INTO users (cpf, phone, email, birth_date, password_hash, plan, plan_expires_at, terms_accepted_at, terms_version) VALUES (?, ?, ?, ?, ?, 'trial', DATE_ADD(CURDATE(), INTERVAL ? DAY), NOW(), ?)",
    [claims.cpf, claims.phone, email.toLowerCase(), birth, passwordHash, config.trialDays, config.termsVersion],
  )
  const [user] = await query('SELECT * FROM users WHERE id = ?', [result.insertId])
  res.status(201).json({ token: signToken({ type: 'session', sub: user.id }), user: publicUser(user) })
})

// Login: CPF + senha
// OBS: a tela de login do front hoje só pede o CPF; precisa ganhar o campo de senha.
router.post('/login', async (req, res) => {
  const cpf = onlyDigits(req.body.cpf)
  if (!validCpf(cpf) || typeof req.body.password !== 'string') throw new HttpError(400, 'CPF ou senha inválidos')

  const [user] = await query('SELECT * FROM users WHERE cpf = ? LIMIT 1', [cpf])
  // mesma resposta para "não existe" e "senha errada", para não revelar quais CPFs têm conta
  const ok = user && (await bcrypt.compare(req.body.password, user.password_hash))
  if (!ok) throw new HttpError(401, 'CPF ou senha incorretos')

  res.json({ token: signToken({ type: 'session', sub: user.id }), user: publicUser(user) })
})

router.get('/me', requireAuth, async (req, res) => {
  const [user] = await query('SELECT * FROM users WHERE id = ?', [req.userId])
  if (!user) throw new HttpError(401, 'Conta não encontrada')
  if (!user.name) user.name = await ensureUserName(user.id)
  res.json({ user: publicUser(user) })
})

// LGPD, art. 18: cópia dos dados que o Anota Grana guarda sobre a pessoa (extratos e transações ficam no banco e na
// Pluggy, não aqui: são lidos na hora e só ficam em memória por pouco tempo)
router.get('/me/export', requireAuth, async (req, res) => {
  const [user] = await query(
    'SELECT id, name, cpf, phone, email, birth_date, plan, plan_expires_at, terms_accepted_at, terms_version, created_at FROM users WHERE id = ?',
    [req.userId],
  )
  if (!user) throw new HttpError(401, 'Conta não encontrada')
  const [accounts, conversations, messages, agents, payments] = await Promise.all([
    query('SELECT institution, status, created_at FROM connected_accounts WHERE user_id = ?', [req.userId]),
    query('SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY id', [req.userId]),
    query('SELECT conversation_id, role, content, widgets, created_at FROM chat_messages WHERE user_id = ? ORDER BY id', [req.userId]),
    query('SELECT name, text, frequency, spend_limit, active, created_at FROM user_agents WHERE user_id = ?', [req.userId]),
    query('SELECT plan, months, amount, method, status, paid_at FROM payments WHERE user_id = ? ORDER BY id', [req.userId]),
  ])
  res.setHeader('Content-Disposition', 'attachment; filename="meus-dados-anota-grana.json"')
  res.json({ exportedAt: new Date().toISOString(), user, connectedAccounts: accounts, conversations, messages, agents, payments })
})

// LGPD, art. 18: exclusão da conta. Pede a senha, revoga os bancos na Pluggy e apaga tudo (o histórico de
// pagamentos fica sem identificação pessoal, por obrigação fiscal).
router.delete('/me', requireAuth, async (req, res) => {
  const [user] = await query('SELECT id, phone, password_hash FROM users WHERE id = ?', [req.userId])
  if (!user) throw new HttpError(401, 'Conta não encontrada')
  if (typeof req.body?.password !== 'string' || !(await bcrypt.compare(req.body.password, user.password_hash))) {
    throw new HttpError(403, 'Senha incorreta')
  }
  const items = await query('SELECT provider_item_id AS id FROM connected_accounts WHERE user_id = ? AND provider_item_id IS NOT NULL', [req.userId])
  await Promise.all(items.map((item) => deleteItem(item.id).catch((err) => console.error('[pluggy] não revogou o item na exclusão da conta:', err.message))))
  await query('DELETE FROM verification_codes WHERE phone = ?', [user.phone])
  await query('DELETE FROM users WHERE id = ?', [req.userId])
  console.log(`[conta] usuário ${req.userId} excluiu a conta`)
  res.status(204).end()
})

export default router
