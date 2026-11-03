import { Router } from 'express'
import crypto from 'node:crypto'
import rateLimit from 'express-rate-limit'
import { query } from '../db.js'
import { requireAuth, requireAccess } from '../middleware/auth.js'
import { HttpError } from '../utils/validators.js'

// Chaves de API: servem para outros sistemas lerem os dados da própria conta (ver routes/publicApi.js).
// Só o hash fica no banco; a chave inteira é devolvida uma única vez, na criação.
const router = Router()
router.use(requireAuth)
router.use(requireAccess)
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }))

const MAX_KEYS = 10
export const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex')

const COLUMNS = 'id, name, key_hint, active, last_used_at, created_at'

const present = (row) => ({
  id: row.id,
  name: row.name,
  hint: row.key_hint,
  active: Boolean(row.active),
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
})

router.get('/', async (req, res) => {
  const rows = await query(`SELECT ${COLUMNS} FROM api_keys WHERE user_id = ? ORDER BY id DESC`, [req.userId])
  res.json({ keys: rows.map(present) })
})

router.post('/', async (req, res) => {
  const name = String(req.body?.name ?? '').replace(/\s+/g, ' ').trim()
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Dê um nome à chave (2 a 60 caracteres)')
  const [{ total }] = await query('SELECT COUNT(*) AS total FROM api_keys WHERE user_id = ?', [req.userId])
  if (total >= MAX_KEYS) throw new HttpError(400, `Você já tem ${MAX_KEYS} chaves. Exclua alguma para criar outra`)

  const key = `ag_${crypto.randomBytes(24).toString('base64url')}`
  const hint = `ag_...${key.slice(-4)}`
  const result = await query('INSERT INTO api_keys (user_id, name, key_hash, key_hint) VALUES (?, ?, ?, ?)', [req.userId, name, hashKey(key), hint])
  const [row] = await query(`SELECT ${COLUMNS} FROM api_keys WHERE id = ?`, [result.insertId])
  res.status(201).json({ key, apiKey: present(row) })
})

router.patch('/:id', async (req, res) => {
  if (typeof req.body?.active !== 'boolean') throw new HttpError(400, 'Informe active: true ou false')
  const result = await query('UPDATE api_keys SET active = ? WHERE id = ? AND user_id = ?', [req.body.active ? 1 : 0, req.params.id, req.userId])
  if (!result.affectedRows) throw new HttpError(404, 'Chave não encontrada')
  res.json({ ok: true })
})

router.delete('/:id', async (req, res) => {
  const result = await query('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.userId])
  if (!result.affectedRows) throw new HttpError(404, 'Chave não encontrada')
  res.json({ ok: true })
})

export default router
