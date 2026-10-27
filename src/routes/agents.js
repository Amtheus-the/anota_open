import { Router } from 'express'
import { query } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { listAgents } from '../services/agents.js'
import { HttpError } from '../utils/validators.js'

const router = Router()
router.use(requireAuth)

// Plano BASIC: 1 agente criado à mão (os do catálogo, criados pelo chat, não contam)
const CUSTOM_LIMIT = 1

router.get('/', async (req, res) => {
  res.json({ agents: await listAgents(req.userId) })
})

router.post('/', async (req, res) => {
  const text = String(req.body.text ?? '').trim().slice(0, 255)
  if (!text) throw new HttpError(400, 'Descreva o que o agente deve fazer')
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM user_agents WHERE user_id = ? AND agent_key IS NULL', [req.userId])
  if (n >= CUSTOM_LIMIT) throw new HttpError(403, `O plano BASIC permite ${CUSTOM_LIMIT} agente criado por você. Remova um para adicionar outro.`)
  const name = text.length > 28 ? `${text.slice(0, 28).trim()}…` : text
  try {
    await query('INSERT INTO user_agents (user_id, name, text, frequency) VALUES (?, ?, ?, ?)', [req.userId, name, text, 'Sob demanda'])
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Você já tem um agente com esse nome')
    throw err
  }
  res.status(201).json({ agents: await listAgents(req.userId) })
})

router.patch('/:id', async (req, res) => {
  const result = await query('UPDATE user_agents SET active = ? WHERE id = ? AND user_id = ?', [req.body.active ? 1 : 0, req.params.id, req.userId])
  if (result.affectedRows === 0) throw new HttpError(404, 'Agente não encontrado')
  res.json({ agents: await listAgents(req.userId) })
})

router.delete('/:id', async (req, res) => {
  await query('DELETE FROM user_agents WHERE id = ? AND user_id = ?', [req.params.id, req.userId])
  res.status(204).end()
})

export default router
