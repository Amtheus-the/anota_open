import { Router } from 'express'
import { query } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { askWithWidgets, generateTitle } from '../services/openai.js'
import { safeFinancials, summarize, suggestionsFor } from '../services/financial.js'
import { followupsFor } from '../services/widgets.js'
import { upsertCatalogAgent } from '../services/agents.js'
import { HttpError } from '../utils/validators.js'

const router = Router()
router.use(requireAuth)

const MAX_MESSAGE = 2000
const HISTORY_LIMIT = 20

async function ownConversation(userId, id) {
  const [row] = await query('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?', [id, userId])
  if (!row) throw new HttpError(404, 'Conversa não encontrada')
  return row
}

// Lista "Recentes" do menu
router.get('/conversations', async (req, res) => {
  const conversations = await query(
    'SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50',
    [req.userId],
  )
  res.json({ conversations })
})

router.get('/conversations/:id/messages', async (req, res) => {
  const conversation = await ownConversation(req.userId, req.params.id)
  const messages = await query(
    'SELECT id, role, content, widgets, steps, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id LIMIT 200',
    [conversation.id],
  )
  res.json({
    conversation,
    messages: messages.map((m) => ({ ...m, widgets: m.widgets ? JSON.parse(m.widgets) : [] })),
  })
})

router.delete('/conversations/:id', async (req, res) => {
  const conversation = await ownConversation(req.userId, req.params.id)
  await query('DELETE FROM conversations WHERE id = ?', [conversation.id])
  res.status(204).end()
})

// Atalhos do chat; vazio quando ainda não há dados conectados (o front usa os padrões)
router.get('/suggestions', async (req, res) => {
  res.json({ suggestions: suggestionsFor(await safeFinancials(req.userId)) })
})

// Envia uma mensagem. Sem conversationId, abre uma conversa nova.
router.post('/messages', async (req, res) => {
  const message = String(req.body.message ?? '').trim()
  if (!message) throw new HttpError(400, 'Mensagem vazia')
  if (message.length > MAX_MESSAGE) throw new HttpError(400, `Mensagem longa demais (máx. ${MAX_MESSAGE})`)

  const isNew = !req.body.conversationId
  const existing = isNew ? null : await ownConversation(req.userId, req.body.conversationId)

  const recent = existing
    ? await query('SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', [existing.id, HISTORY_LIMIT])
    : []
  const history = [...recent.reverse(), { role: 'user', content: message }]

  // saldos e transações das contas conectadas entram no contexto do assistente
  const fin = await safeFinancials(req.userId)
  const { reply, widgets, steps, agents: requested } = await askWithWidgets(history, summarize(fin), fin)
  // agentes que a IA criou nesta resposta já ficam salvos no banco
  const agents = []
  for (const request of requested) {
    const saved = await upsertCatalogAgent(req.userId, request)
    if (saved) agents.push(saved)
  }

  // a conversa só é criada depois da resposta, para um erro da IA não deixar conversa vazia na lista
  let conversationId = existing?.id
  let title = existing?.title
  if (isNew) {
    title = message.slice(0, 40)
    const created = await query('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [req.userId, title])
    conversationId = created.insertId
  }
  await query(
    'INSERT INTO chat_messages (user_id, conversation_id, role, content, widgets, steps) VALUES (?, ?, ?, ?, NULL, 0), (?, ?, ?, ?, ?, ?)',
    [req.userId, conversationId, 'user', message, req.userId, conversationId, 'assistant', reply, widgets.length ? JSON.stringify(widgets) : null, steps],
  )
  await query('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conversationId])

  // título melhor, gerado em segundo plano para não atrasar a resposta
  if (isNew) {
    generateTitle(message, reply)
      .then((better) => better && query('UPDATE conversations SET title = ? WHERE id = ?', [better, conversationId]))
      .catch((err) => console.error('[chat] título não gerado:', err.message))
  }

  res.json({ reply, widgets, steps, agents, followups: followupsFor(widgets), conversationId, title })
})

export default router
