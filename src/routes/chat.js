import { Router } from 'express'
import { query } from '../db.js'
import { requireAuth, requireAccess } from '../middleware/auth.js'
import { safeFinancials, suggestionsFor } from '../services/financial.js'
import { ownConversation, sendChatMessage } from '../services/chatService.js'
import { HttpError } from '../utils/validators.js'

const router = Router()
router.use(requireAuth)

const MAX_MESSAGE = 2000

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
router.post('/messages', requireAccess, async (req, res) => {
  const message = String(req.body.message ?? '').trim()
  if (!message) throw new HttpError(400, 'Mensagem vazia')
  if (message.length > MAX_MESSAGE) throw new HttpError(400, `Mensagem longa demais (máx. ${MAX_MESSAGE})`)

  res.json(await sendChatMessage(req.userId, message, { conversationId: req.body.conversationId }))
})

export default router
