import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'

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
