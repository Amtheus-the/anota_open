import { connectionFor, executeTool } from './composio.js'

// Apps do catálogo. "ready" = o chat já sabe usar; os outros ainda não têm ferramentas e aparecem como "Em breve".
export const APPS = [
  { slug: 'gmail', name: 'Gmail', text: 'Encontrar boletos e assinaturas', ready: true },
  { slug: 'googlecalendar', name: 'Google Calendar', text: 'Criar lembretes de vencimento', ready: false },
  { slug: 'notion', name: 'Notion', text: 'Acompanhar metas financeiras', ready: false },
  { slug: 'googlesheets', name: 'Google Sheets', text: 'Organizar gastos e orçamento', ready: false },
  { slug: 'googledrive', name: 'Google Drive', text: 'Salvar relatórios e comprovantes', ready: false },
  { slug: 'trello', name: 'Trello', text: 'Organizar tarefas e metas em quadros kanban', ready: false },
  { slug: 'googlemeet', name: 'Google Meet', text: 'Agendar reuniões e videochamadas', ready: false },
]

const clamp = (n, min, max, fallback) => Math.min(max, Math.max(min, Number.isFinite(Number(n)) ? Number(n) : fallback))

const stripHtml = (html) => String(html ?? '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const header = (message, name) => message.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value

// A Composio devolve campos com nomes um pouco diferentes conforme a versão da ferramenta: lê os que existirem
function normalize(message, limit) {
  const text = stripHtml(message.messageText ?? message.preview?.body ?? message.body ?? message.snippet ?? message.preview?.snippet ?? '')
  return {
    id: message.messageId ?? message.id,
    from: message.sender ?? message.from ?? header(message, 'from') ?? '',
    subject: message.subject ?? header(message, 'subject') ?? '',
    date: message.messageTimestamp ?? message.date ?? header(message, 'date') ?? '',
    text: text.slice(0, limit),
    attachments: (message.attachmentList ?? message.attachments ?? []).map((a) => a.filename ?? a.name).filter(Boolean),
  }
}

const MAX_QUERIES = 6
const MAX_EMAILS = 40

// Busca na caixa de entrada (sintaxe de busca do Gmail). Aceita várias buscas de uma vez ("queries"): elas rodam juntas e os
// resultados são somados sem repetir e-mail, para a IA não depender de uma única palavra. Devolve { needsConnection } se o Gmail não estiver conectado.
export async function searchGmail(userId, { query, queries, maxResults, pageToken } = {}) {
  const connection = await connectionFor(userId, 'gmail')
  if (!connection) return { needsConnection: true }

  const searches = [...new Set([...(Array.isArray(queries) ? queries : []), query].map((q) => String(q ?? '').trim().slice(0, 300)).filter(Boolean))].slice(0, MAX_QUERIES)
  if (searches.length === 0) searches.push('')
  const perSearch = clamp(maxResults, 1, 25, searches.length > 1 ? 10 : 15)

  const settled = await Promise.allSettled(
    searches.map((q) => executeTool(
      userId,
      'GMAIL_FETCH_EMAILS',
      { query: q, max_results: perSearch, ...(pageToken && searches.length === 1 ? { page_token: pageToken } : {}), include_payload: true, verbose: true, user_id: 'me' },
      connection.id,
    )),
  )
  const answered = settled.filter((r) => r.status === 'fulfilled')
  if (answered.length === 0) throw settled[0].reason

  const seen = new Set()
  const emails = []
  for (const { value } of answered) {
    for (const message of value?.messages ?? []) {
      const email = normalize(message, searches.length > 1 ? 500 : 700)
      if (email.id && seen.has(email.id)) continue
      if (email.id) seen.add(email.id)
      emails.push(email)
    }
  }
  return {
    emails: emails.slice(0, MAX_EMAILS),
    nextPageToken: searches.length === 1 ? answered[0].value?.nextPageToken ?? null : null,
    total: searches.length === 1 ? answered[0].value?.resultSizeEstimate ?? null : null,
    searches: searches.length,
  }
}

export async function readGmailMessage(userId, messageId) {
  const connection = await connectionFor(userId, 'gmail')
  if (!connection) return { needsConnection: true }
  const data = await executeTool(userId, 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: String(messageId), format: 'full', user_id: 'me' }, connection.id)
  return { email: normalize(data?.message ?? data ?? {}, 4000) }
}
