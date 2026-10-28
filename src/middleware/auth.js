import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'
import { query } from '../db.js'

export const signToken = (payload, expiresIn = config.jwt.expiresIn) =>
  jwt.sign(payload, config.jwt.secret, { expiresIn })

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret)
  } catch {
    throw new HttpError(401, 'Sessão inválida ou expirada')
  }
}

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return next(new HttpError(401, 'Não autenticado'))
  const payload = verifyToken(token)
  if (payload.type !== 'session') return next(new HttpError(401, 'Sessão inválida'))
  req.userId = payload.sub
  next()
}

export const isAdminCpf = (cpf) => config.adminCpfs.includes(cpf)

// Acesso ao produto: teste grátis ou plano pago dentro da validade (admins sempre entram).
// plan: 'trial' | 'pro' | 'premium' | 'free' (free = sem plano, p.ex. cancelado)
export const planActive = (user) =>
  user.plan !== 'free' && (!user.plan_expires_at || String(user.plan_expires_at).slice(0, 10) >= new Date().toLocaleDateString('sv-SE'))

export const hasAccess = (user) => isAdminCpf(user.cpf) || planActive(user)

export async function requireAccess(req, _res, next) {
  const [user] = await query('SELECT cpf, plan, plan_expires_at FROM users WHERE id = ?', [req.userId])
  if (!user) return next(new HttpError(401, 'Conta não encontrada'))
  if (hasAccess(user)) return next()
  const trial = user.plan === 'trial'
  next(new HttpError(402, trial ? 'Seu teste grátis acabou. Assine o plano Pro para continuar usando o Anota Grana.' : 'Você não tem um plano ativo. Assine o plano Pro para continuar usando o Anota Grana.'))
}

// Painel de administração: confere no banco (não no token) se o CPF da conta está em ADMIN_CPFS
export async function requireAdmin(req, _res, next) {
  const [user] = await query('SELECT cpf FROM users WHERE id = ?', [req.userId])
  if (!user || !isAdminCpf(user.cpf)) return next(new HttpError(403, 'Acesso restrito'))
  next()
}
