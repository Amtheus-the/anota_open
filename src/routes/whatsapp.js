import crypto from 'node:crypto'
import { Router } from 'express'
import { query } from '../db.js'
import { config } from '../config.js'
import { sendWhatsApp } from '../services/whatsapp.js'
import { sendChatMessage } from '../services/chatService.js'
import { hasAccess } from '../middleware/auth.js'
import { normalizePhone, validPhone } from '../utils/validators.js'

const router = Router()

const MAX_MESSAGE = 2000
const MAX_REPLY = 3500 // o WhatsApp aceita até 4096 caracteres por mensagem
const PER_MINUTE = 6 // mensagens por minuto por usuário (cada resposta custa uma chamada à OpenAI)
const CONVERSATION_TITLE = 'WhatsApp' // uma conversa contínua, que também aparece na lista "Recentes" do site
const SIGNUP_URL = process.env.FRONTEND_URL ? config.frontendUrl : 'https://anotagrana.com.br'

// Avisos automáticos (convite, erro, "só texto") no máximo uma vez por período: não vira eco para quem insiste
const cooldowns = new Map()
function allowed(key, ms) {
  const now = Date.now()
  if ((cooldowns.get(key) ?? 0) > now) return false
  if (cooldowns.size > 1000) cooldowns.clear()
  cooldowns.set(key, now + ms)
  return true
}

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest()
const secretMatches = (given) => Boolean(config.whatsapp.webhookSecret) && crypto.timingSafeEqual(sha(given), sha(config.whatsapp.webhookSecret))

// Comandos que o cliente manda para parar ou voltar a receber avisos (lembretes e alertas dos agentes).
// Só vale a mensagem inteira (sem acento nem pontuação), para não confundir com uma pergunta normal.
const STOP_WORDS = new Set(['parar', 'pare', 'stop', 'parar avisos', 'parar lembretes'])
const RESUME_WORDS = new Set(['reativar', 'reativar avisos'])
const commandOf = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim()

const textOf = (content) => content?.conversation ?? content?.extendedTextMessage?.text ?? null

async function handleIncoming(payload) {
  if (payload?.event !== 'webhookReceived' || payload.fromMe || payload.isGroup || String(payload.chat?.id ?? '').includes('@g.us')) return
  if (payload.instanceId && payload.instanceId !== config.whatsapp.instanceId) return

  const messageId = String(payload.messageId ?? '')
  const phone = normalizePhone(payload.sender?.id ?? payload.chat?.id)
  if (!messageId || !validPhone(phone)) return

  // a W-API pode entregar o mesmo aviso mais de uma vez (e a hospedagem pode ter mais de um processo)
  const claimed = await query('INSERT IGNORE INTO whatsapp_inbound (message_id) VALUES (?)', [messageId])
  if (claimed.affectedRows === 0) return

  const [user] = await query('SELECT id, cpf, plan, plan_expires_at FROM users WHERE phone = ? LIMIT 1', [phone])
  if (!user) {
    if (allowed(`invite:${phone}`, 3_600_000)) {
      await sendWhatsApp(phone, `Oi! Eu sou o Anota Grana 🦊 Não encontrei uma conta com este número. Crie a sua em ${SIGNUP_URL} e depois é só voltar aqui para conversar comigo.`)
    }
    return
  }

  const text = String(textOf(payload.msgContent) ?? '').trim()
  const command = commandOf(text)
  if (STOP_WORDS.has(command) || RESUME_WORDS.has(command)) {
    const stop = STOP_WORDS.has(command)
    await query(`UPDATE users SET whatsapp_optout_at = ${stop ? 'NOW()' : 'NULL'} WHERE id = ?`, [user.id])
    await sendWhatsApp(phone, stop
      ? 'Pronto, não vou mais te mandar lembretes nem avisos dos agentes 🦊 Você ainda pode conversar comigo por aqui. Para voltar a receber, responda REATIVAR.'
      : 'Combinado, os avisos estão ligados de novo 🦊')
    return
  }

  if (!hasAccess(user)) {
    if (allowed(`plan:${phone}`, 3_600_000)) {
      await sendWhatsApp(phone, `Seu teste grátis acabou 🦊 Assine o plano Pro em ${SIGNUP_URL} para continuar conversando comigo.`)
    }
    return
  }

  if (!text) {
    if (allowed(`media:${phone}`, 60_000)) await sendWhatsApp(phone, 'Por enquanto eu só entendo mensagens de texto 🦊 Me escreva a sua pergunta.')
    return
  }
  if (text.length > MAX_MESSAGE) {
    await sendWhatsApp(phone, `Essa mensagem ficou grande demais (máximo de ${MAX_MESSAGE} caracteres). Pode resumir?`)
    return
  }

  const [{ n }] = await query(
    "SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND role = 'user' AND created_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE)",
    [user.id],
  )
  if (n >= PER_MINUTE) {
    if (allowed(`slow:${phone}`, 60_000)) await sendWhatsApp(phone, 'Calma, tô acompanhando! 🦊 Me dá um minutinho e manda de novo.')
    return
  }

  const [conversation] = await query('SELECT id FROM conversations WHERE user_id = ? AND title = ? ORDER BY id DESC LIMIT 1', [user.id, CONVERSATION_TITLE])
  const result = await sendChatMessage(user.id, text, {
    conversationId: conversation?.id ?? null,
    channel: 'whatsapp',
    title: CONVERSATION_TITLE,
  })
  await sendWhatsApp(phone, result.reply.length > MAX_REPLY ? `${result.reply.slice(0, MAX_REPLY - 1)}…` : result.reply)
}

// Webhook "mensagem recebida" da W-API. O segredo na URL impede que qualquer pessoa finja ser a W-API.
router.post('/webhook/:secret', (req, res) => {
  if (!secretMatches(req.params.secret)) return res.status(404).end()
  res.json({ ok: true }) // responde na hora; a IA leva alguns segundos e a W-API não deve esperar
  handleIncoming(req.body).catch(async (err) => {
    console.error('[whatsapp] falha ao processar mensagem:', err.message)
    const phone = normalizePhone(req.body?.sender?.id ?? req.body?.chat?.id)
    if (validPhone(phone) && !req.body?.fromMe && allowed(`error:${phone}`, 60_000)) {
      await sendWhatsApp(phone, 'Tive um problema para responder agora. Tenta de novo em instantes? 🦊').catch(() => {})
    }
  })
})

export default router
