import { query } from '../db.js'
import { askWithWidgets, generateTitle } from './openai.js'
import { safeFinancials, summarize, clearFinancialsCache } from './financial.js'
import { saveRules } from './categoryRules.js'
import { followupsFor } from './widgets.js'
import { upsertCatalogAgent } from './agents.js'
import { HttpError } from '../utils/validators.js'

const HISTORY_LIMIT = 20

export async function ownConversation(userId, id) {
  const [row] = await query('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?', [id, userId])
  if (!row) throw new HttpError(404, 'Conversa não encontrada')
  return row
}

// Um turno de conversa: o site e o WhatsApp usam exatamente este caminho, com a mesma IA e os mesmos dados.
// Sem conversationId, abre uma conversa nova (com "title" se informado, senão as primeiras palavras da mensagem).
export async function sendChatMessage(userId, message, { conversationId = null, channel = 'web', title: fixedTitle = null } = {}) {
  const isNew = !conversationId
  const existing = isNew ? null : await ownConversation(userId, conversationId)

  const recent = existing
    ? await query('SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', [existing.id, HISTORY_LIMIT])
    : []
  const history = [...recent.reverse(), { role: 'user', content: message }]

  // saldos e transações das contas conectadas entram no contexto do assistente
  const fin = await safeFinancials(userId)
  const { reply, widgets, steps, agents: requested, corrections } = await askWithWidgets(history, summarize(fin), fin, { channel })
  // agentes que a IA criou nesta resposta já ficam salvos no banco
  const agents = []
  for (const request of requested) {
    const saved = await upsertCatalogAgent(userId, request)
    if (saved) agents.push(saved)
  }

  // correções de categoria (Prisma) pedidas nesta resposta: viram regra e valem daqui para a frente
  for (const correction of corrections) await saveRules(userId, correction.merchants, correction.target)
  if (corrections.length > 0) clearFinancialsCache(userId)

  // a conversa só é criada depois da resposta, para um erro da IA não deixar conversa vazia na lista
  let id = existing?.id
  let title = existing?.title
  if (isNew) {
    title = fixedTitle ?? message.slice(0, 40)
    const created = await query('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [userId, title])
    id = created.insertId
  }
  await query(
    'INSERT INTO chat_messages (user_id, conversation_id, role, content, widgets, steps) VALUES (?, ?, ?, ?, NULL, 0), (?, ?, ?, ?, ?, ?)',
    [userId, id, 'user', message, userId, id, 'assistant', reply, widgets.length ? JSON.stringify(widgets) : null, steps],
  )
  await query('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id])

  // título melhor, gerado em segundo plano para não atrasar a resposta (a conversa do WhatsApp tem título fixo)
  if (isNew && !fixedTitle) {
    generateTitle(message, reply)
      .then((better) => better && query('UPDATE conversations SET title = ? WHERE id = ?', [better, id]))
      .catch((err) => console.error('[chat] título não gerado:', err.message))
  }

  return { reply, widgets, steps, agents, followups: followupsFor(widgets), conversationId: id, title }
}
