import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { query } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { HttpError } from '../utils/validators.js'

// Avaliação do Anota Grana (de 1 a 5 estrelas, com comentário opcional). Cada pessoa tem uma avaliação, que ela pode atualizar.
const router = Router()
router.use(requireAuth)
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }))

router.get('/me', async (req, res) => {
  const [row] = await query('SELECT rating, comment, updated_at FROM feedback WHERE user_id = ?', [req.userId])
  res.json({ feedback: row ? { rating: row.rating, comment: row.comment ?? '', updatedAt: row.updated_at } : null })
})

router.post('/', async (req, res) => {
  const rating = Number(req.body?.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Escolha de 1 a 5 estrelas')
  const comment = String(req.body?.comment ?? '').trim().slice(0, 500) || null
  await query(
    `INSERT INTO feedback (user_id, rating, comment) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
    [req.userId, rating, comment],
  )
  res.status(201).json({ ok: true })
})

export default router
