import { connectionFor, executeTool } from './composio.js'

// Apps do catálogo. "ready" = o chat já sabe usar; os outros ainda não têm ferramentas e aparecem como "Em breve".
export const APPS = [
  { slug: 'gmail', name: 'Gmail', text: 'Encontrar boletos e assinaturas', ready: true },
  { slug: 'googlecalendar', name: 'Google Calendar', text: 'Criar lembretes de vencimento', ready: true },
  { slug: 'notion', name: 'Notion', text: 'Acompanhar metas financeiras', ready: true },
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

// ---- Google Calendar -------------------------------------------------------------------------------------------------------
const TZ = 'America/Sao_Paulo'
const OFFSET = '-03:00' // o Brasil não tem mais horário de verão

const items = (data) => data?.items ?? data?.calendars ?? data?.events ?? data?.response_data?.items ?? []
const eventStart = (e) => e.start?.dateTime ?? e.start?.date ?? ''
const eventEnd = (e) => e.end?.dateTime ?? e.end?.date ?? ''

function normalizeEvent(e, calendar) {
  return {
    id: e.id,
    calendarId: calendar.id,
    calendar: calendar.summary ?? calendar.id,
    title: e.summary ?? '(sem título)',
    start: eventStart(e),
    end: eventEnd(e),
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    location: e.location ?? '',
  }
}

// Eventos de TODAS as agendas do usuário entre duas datas (YYYY-MM-DD, "to" inclusive), em ordem de início
export async function calendarEvents(userId, { from, to } = {}) {
  const connection = await connectionFor(userId, 'googlecalendar')
  if (!connection) return { needsConnection: true }
  const day = /^\d{4}-\d{2}-\d{2}$/
  if (!day.test(String(from)) || !day.test(String(to))) return { error: 'Informe as datas no formato AAAA-MM-DD' }

  const calendars = items(await executeTool(userId, 'GOOGLECALENDAR_LIST_CALENDARS', { max_results: 50 }, connection.id)).filter((c) => c.id).slice(0, 12)
  if (calendars.length === 0) calendars.push({ id: 'primary', summary: 'Principal' })

  const settled = await Promise.allSettled(
    calendars.map((calendar) => executeTool(
      userId,
      'GOOGLECALENDAR_EVENTS_LIST',
      { calendarId: calendar.id, timeMin: `${from}T00:00:00${OFFSET}`, timeMax: `${to}T23:59:59${OFFSET}`, singleEvents: true, orderBy: 'startTime', maxResults: 50, timeZone: TZ },
      connection.id,
    )),
  )
  const events = []
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') for (const e of items(result.value)) if (e.id && e.status !== 'cancelled') events.push(normalizeEvent(e, calendars[i]))
  })
  events.sort((a, b) => (a.start < b.start ? -1 : 1))
  return { events: events.slice(0, 60), calendars: calendars.map((c) => c.summary ?? c.id), failed: settled.filter((r) => r.status === 'rejected').length }
}

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

// Cria um evento na agenda principal, só do usuário (sem convidados e sem e-mail de convite).
// start: AAAA-MM-DDTHH:MM no horário de Brasília. reminders: minutos antes do início (aviso na tela).
export async function createCalendarEvent(userId, { title, start, durationMinutes, description, reminders } = {}) {
  const connection = await connectionFor(userId, 'googlecalendar')
  if (!connection) return { needsConnection: true }
  const when = String(start ?? '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  if (!when) return { error: 'Informe o início no formato AAAA-MM-DDTHH:MM' }
  const minutes = clamp(durationMinutes, 5, 1440, 15)

  const created = await executeTool(
    userId,
    'GOOGLECALENDAR_CREATE_EVENT',
    {
      summary: clean(title, 200) || 'Lembrete',
      start_datetime: `${when[1]}T${when[2]}:00`,
      event_duration_hour: Math.floor(minutes / 60),
      event_duration_minutes: minutes % 60,
      timezone: TZ,
      description: clean(description, 1000),
      calendar_id: 'primary',
      send_updates: 'none',
    },
    connection.id,
  )
  const event = created?.response_data ?? created?.event ?? created
  const id = event?.id ?? event?.event_id ?? created?.id
  if (!id) return { error: 'A agenda não confirmou a criação do evento' }

  // aviso na tela nos minutos pedidos (o padrão da agenda pode ser só um). Se falhar, o evento já existe e segue valendo.
  const wanted = (Array.isArray(reminders) && reminders.length ? reminders : [60, 0]).map((m) => clamp(m, 0, 40320, 0)).slice(0, 5)
  await executeTool(
    userId,
    'GOOGLECALENDAR_PATCH_EVENT',
    { event_id: id, calendar_id: 'primary', reminders: { useDefault: false, overrides: wanted.map((m) => ({ method: 'popup', minutes: m })) } },
    connection.id,
  ).catch((err) => console.error('[agenda] não ajustou os avisos:', err.message))

  const end = new Date(new Date(`${when[1]}T${when[2]}:00${OFFSET}`).getTime() + minutes * 60_000)
  return {
    event: {
      id,
      calendarId: 'primary',
      title: clean(title, 200) || 'Lembrete',
      start: `${when[1]}T${when[2]}:00${OFFSET}`,
      end: end.toISOString(),
      link: event?.htmlLink ?? null,
      reminders: wanted,
    },
  }
}

export async function deleteCalendarEvent(userId, eventId, calendarId = 'primary') {
  const connection = await connectionFor(userId, 'googlecalendar')
  if (!connection) return { needsConnection: true }
  await executeTool(userId, 'GOOGLECALENDAR_DELETE_EVENT', { event_id: String(eventId), calendar_id: String(calendarId || 'primary'), send_updates: 'none' }, connection.id)
  return { ok: true }
}

// ---- Notion ----------------------------------------------------------------------------------------------------------------
const plain = (rich) => (Array.isArray(rich) ? rich.map((t) => t.plain_text ?? t.text?.content ?? '').join('') : '')

function notionTitle(o) {
  if (typeof o.title === 'string') return o.title
  if (Array.isArray(o.title)) return plain(o.title)
  for (const p of Object.values(o.properties ?? {})) if (p?.type === 'title') return plain(p.title)
  return o.child_page?.title ?? o.page_title ?? ''
}

const notionUrl = (id, url) => url ?? `https://www.notion.so/${String(id).replace(/-/g, '')}`
const pick = (data, key) => data?.[key] ?? data?.data?.[key] ?? data?.response_data?.[key] ?? data?.page?.[key]

// Busca páginas e bancos de dados que o usuário liberou na hora de conectar. kind: 'page' | 'database' | 'all'
export async function searchNotion(userId, { query, kind } = {}) {
  const connection = await connectionFor(userId, 'notion')
  if (!connection) return { needsConnection: true }
  const text = String(query ?? '').trim().slice(0, 200)
  const filter = kind === 'page' || kind === 'database' ? { filter_value: kind } : {}
  const run = (q) => executeTool(userId, 'NOTION_SEARCH_NOTION_PAGE', { query: q, page_size: 25, ...filter }, connection.id)
  const results = (data) => (Array.isArray(data) ? data : data?.results ?? data?.pages ?? data?.items ?? [])

  const first = await run(text)
  let found = results(first)
  const more = Boolean(first?.has_more ?? first?.next_cursor)
  // o índice de busca do Notion pode atrasar: sem resultado, traz tudo e filtra aqui pelo título
  if (found.length === 0 && text) {
    const all = results(await run(''))
    found = all.filter((o) => notionTitle(o).toLowerCase().includes(text.toLowerCase()))
  }
  return {
    more,
    pages: found.slice(0, 25).map((o) => ({ id: o.id, type: o.object ?? 'page', title: notionTitle(o) || '(sem título)', url: notionUrl(o.id, o.url), edited: o.last_edited_time ?? '' })),
  }
}

const NOTION_ID = /^[0-9a-f]{8}-?([0-9a-f]{4}-?){3}[0-9a-f]{12}$/i

// A IA às vezes passa o título em vez do id: se não for um id do Notion, procura a página pelo título exato (ou única)
async function resolveNotionId(userId, value) {
  const text = String(value ?? '').trim()
  if (NOTION_ID.test(text)) return { id: text }
  const { pages = [] } = await searchNotion(userId, { query: text })
  const exact = pages.filter((p) => p.title.toLowerCase() === text.toLowerCase())
  const hit = exact.length === 1 ? exact[0] : pages.length === 1 ? pages[0] : null
  if (hit) return { id: hit.id, title: hit.title }
  return { error: pages.length > 1 ? `Mais de uma página combina com "${text}": use o id de uma delas` : `Não achei a página "${text}" entre as que foram liberadas` }
}

export async function readNotionPage(userId, pageId) {
  const connection = await connectionFor(userId, 'notion')
  if (!connection) return { needsConnection: true }
  const target = await resolveNotionId(userId, pageId)
  if (target.error) return { error: target.error }
  const data = await executeTool(userId, 'NOTION_GET_PAGE_MARKDOWN', { page_id: target.id }, connection.id)
  const markdown = typeof data === 'string' ? data : data?.markdown ?? data?.content ?? data?.data ?? ''
  const text = String(markdown)
  return { markdown: text.slice(0, 40000), truncated: text.length > 40000, totalChars: text.length }
}

// Cria uma página NOVA dentro de uma página ou banco de dados que o usuário liberou. Nunca altera nem apaga as que já existem.
export async function createNotionPage(userId, { parentId, title, markdown } = {}) {
  const connection = await connectionFor(userId, 'notion')
  if (!connection) return { needsConnection: true }
  if (!parentId) return { error: 'Informe parent_id: a página onde a nova ficará. Use search_notion para listar as páginas disponíveis ou pergunte ao usuário.' }
  const parent = await resolveNotionId(userId, parentId)
  if (parent.error) return { error: parent.error }
  const created = await executeTool(
    userId,
    'NOTION_CREATE_NOTION_PAGE',
    { parent_id: parent.id, title: clean(title, 200) || 'Nova página', ...(markdown ? { markdown: String(markdown).slice(0, 20000) } : {}) },
    connection.id,
  )
  const id = pick(created, 'id')
  if (!id) return { error: 'O Notion não confirmou a criação da página' }
  return { page: { id, title: clean(title, 200) || 'Nova página', url: notionUrl(id, pick(created, 'url')), action: 'created' } }
}

// Acrescenta texto no FIM de uma página existente (não reescreve nem apaga o que já está lá)
export async function appendNotionPage(userId, { pageId, text, title } = {}) {
  const connection = await connectionFor(userId, 'notion')
  if (!connection) return { needsConnection: true }
  const blocks = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((line) => {
      const type = /^### /.test(line) ? 'heading_3' : /^## /.test(line) ? 'heading_2' : /^# /.test(line) ? 'heading_1' : /^- \[[ x]\] /.test(line) ? 'to_do' : /^[-*] /.test(line) ? 'bulleted_list_item' : 'paragraph'
      return { content: line.replace(/^(#{1,3} |- \[[ x]\] |[-*] )/, '').slice(0, 1900), block_property: type }
    })
  if (blocks.length === 0) return { error: 'Informe o texto a acrescentar' }
  const target = await resolveNotionId(userId, pageId)
  if (target.error) return { error: target.error }
  await executeTool(userId, 'NOTION_ADD_MULTIPLE_PAGE_CONTENT', { parent_block_id: target.id, content_blocks: blocks }, connection.id)
  return { page: { id: target.id, title: clean(title, 200) || target.title || 'Página', url: notionUrl(target.id), action: 'updated' } }
}
