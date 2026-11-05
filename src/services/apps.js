import { connectionFor, executeTool, listConnections } from './composio.js'

// Apps do catálogo. "ready" = o chat já sabe usar; os outros ainda não têm ferramentas e aparecem como "Em breve".
export const APPS = [
  { slug: 'gmail', name: 'Gmail', text: 'Encontrar boletos e assinaturas', ready: true },
  { slug: 'googlecalendar', name: 'Google Calendar', text: 'Criar lembretes de vencimento', ready: true },
  { slug: 'notion', name: 'Notion', text: 'Acompanhar metas financeiras', ready: true },
  { slug: 'googledrive', name: 'Google Drive', text: 'Salvar relatórios e comprovantes', ready: false },
  { slug: 'trello', name: 'Trello', text: 'Organizar tarefas e metas em quadros kanban', ready: true },
  { slug: 'outlook', name: 'Outlook', text: 'E-mail e agenda da Microsoft', ready: true },
  { slug: 'googlemeet', name: 'Google Meet', text: 'Agendar reuniões e videochamadas', ready: true },
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
async function searchGoogleMail(userId, { query, queries, maxResults, pageToken } = {}) {
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

async function readGoogleMessage(userId, messageId) {
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
async function googleCalendarEvents(userId, { from, to } = {}) {
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
  console.log('[agenda] listou', from, 'a', to, '| agendas:', calendars.length, '| eventos:', events.length, '| falhas:', settled.filter((r) => r.status === 'rejected').length)
  return { events: events.slice(0, 60), calendars: calendars.map((c) => c.summary ?? c.id), failed: settled.filter((r) => r.status === 'rejected').length }
}

// Link da videochamada (Google Meet) que a agenda devolve junto com o evento
const meetLinkOf = (e) => e?.hangoutLink ?? e?.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

// Cria um evento na agenda principal, só do usuário (sem convidados e sem e-mail de convite).
// start: AAAA-MM-DDTHH:MM no horário de Brasília. reminders: minutos antes do início (aviso na tela).
async function createGoogleEvent(userId, { title, start, durationMinutes, description, reminders, meet } = {}) {
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
      create_meeting_room: Boolean(meet), // só gera link de videochamada quando foi pedido
    },
    connection.id,
  )
  const event = created?.response_data ?? created?.event ?? created
  console.log('[agenda] evento criado; convidados:', JSON.stringify(event?.attendees ?? null)?.slice(0, 200), '; lembretes:', JSON.stringify(event?.reminders ?? null)?.slice(0, 200))
  const id = event?.id ?? event?.event_id ?? created?.id
  if (!id) return { error: 'A agenda não confirmou a criação do evento' }

  // aviso na tela nos minutos pedidos (o padrão da agenda pode ser só um). Se falhar, o evento já existe e segue valendo.
  const wanted = (Array.isArray(reminders) && reminders.length ? reminders : [60, 0]).map((m) => clamp(m, 0, 40320, 0)).slice(0, 5)
  const patched = await executeTool(
    userId,
    'GOOGLECALENDAR_PATCH_EVENT',
    { event_id: id, calendar_id: 'primary', reminders: { useDefault: false, overrides: wanted.map((m) => ({ method: 'popup', minutes: m })) } },
    connection.id,
  ).catch((err) => console.error('[agenda] não ajustou os avisos:', err.message))
  console.log('[agenda] avisos pedidos', JSON.stringify(wanted), '; devolvido:', JSON.stringify(patched?.response_data?.reminders ?? patched?.reminders ?? patched)?.slice(0, 300))

  const end = new Date(new Date(`${when[1]}T${when[2]}:00${OFFSET}`).getTime() + minutes * 60_000)
  return {
    event: {
      id,
      calendarId: 'primary',
      title: clean(title, 200) || 'Lembrete',
      start: `${when[1]}T${when[2]}:00${OFFSET}`,
      end: end.toISOString(),
      link: event?.htmlLink ?? null,
      meetLink: meetLinkOf(event) ?? meetLinkOf(created),
      meetRequested: Boolean(meet),
      reminders: wanted,
    },
  }
}

async function deleteGoogleEvent(userId, eventId, calendarId = 'primary') {
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
    pages: found.slice(0, 25).map((o) => ({ id: o.id, type: o.object ?? 'page', title: notionTitle(o) || '(sem título)', url: notionUrl(o.id, o.url), edited: o.last_edited_time ?? '', parentType: o.parent?.type ?? '' })),
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
  let created
  try {
    created = await executeTool(
      userId,
      'NOTION_CREATE_NOTION_PAGE',
      { parent_id: parent.id, title: clean(title, 200) || 'Nova página', ...(markdown ? { markdown: String(markdown).slice(0, 20000) } : {}) },
      connection.id,
    )
  } catch (err) {
    // o Notion recusa subpáginas dentro de itens de um banco de dados: explica e sugere páginas comuns
    const known = (await searchNotion(userId, { query: '' }).catch(() => ({ pages: [] }))).pages
    const same = (a, b) => String(a).replace(/-/g, '') === String(b).replace(/-/g, '')
    const asked = known.find((p) => same(p.id, parent.id))
    if (asked?.parentType === 'database_id') {
      const alternatives = known.filter((p) => p.parentType !== 'database_id').slice(0, 5).map((p) => p.title)
      return { error: `"${asked.title}" é um item de um banco de dados do Notion, e o Notion não deixa criar páginas dentro dele por aqui.${alternatives.length ? ` Páginas comuns onde dá para criar: ${alternatives.join(', ')}.` : ''} Pergunte ao usuário em qual usar.` }
    }
    throw err
  }
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

// ---------- Trello ----------
// A Composio devolve listas ora direto, ora dentro de response_data/data: lê o que vier
const asList = (d, depth = 0) => {
  if (Array.isArray(d)) return d
  if (!d || typeof d !== 'object' || depth > 3) return []
  for (const v of Object.values(d)) {
    const found = asList(v, depth + 1)
    if (found.length) return found
  }
  return []
}
const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

// acha por id (ou código curto) ou pelo nome (exato, ou o único que contém o texto)
function pickByName(list, value) {
  const text = String(value ?? '').trim()
  if (!text) return { error: 'Informe o nome ou o id' }
  const byId = list.find((x) => x.id === text || x.shortLink === text)
  if (byId) return { item: byId }
  const exact = list.filter((x) => sameText(x.name, text))
  if (exact.length === 1) return { item: exact[0] }
  const partial = exact.length ? exact : list.filter((x) => String(x.name ?? '').toLowerCase().includes(text.toLowerCase()))
  if (partial.length === 1) return { item: partial[0] }
  return { error: partial.length > 1 ? `Mais de um combina com "${text}": ${partial.slice(0, 6).map((x) => x.name).join(', ')}. Pergunte qual` : `Não achei "${text}"` }
}

async function trelloBoards(userId, connection) {
  const data = await executeTool(userId, 'TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER', { idMember: 'me', filter: 'open', fields: 'name,url,shortUrl,shortLink,closed' }, connection.id)
  const boards = asList(data).filter((b) => b.id && !b.closed).map((b) => ({ id: b.id, name: b.name ?? '(sem nome)', url: b.shortUrl ?? b.url ?? null, shortLink: b.shortLink }))
  if (boards.length === 0) console.log('[trello] nenhum quadro; resposta do Trello:', JSON.stringify(data)?.slice(0, 400))
  return boards
}

async function trelloLists(userId, connection, boardId, withCards) {
  const data = await executeTool(
    userId,
    'TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD',
    { idBoard: boardId, filter: 'open', ...(withCards ? { cards: 'open', card_fields: 'name,due,url,shortUrl,idList,closed' } : {}) },
    connection.id,
  )
  return asList(data).filter((l) => l.id && !l.closed).map((l) => ({
    id: l.id,
    name: l.name ?? '(sem nome)',
    cards: (Array.isArray(l.cards) ? l.cards : []).filter((c) => c.id && !c.closed).map((c) => ({ id: c.id, name: c.name ?? '(sem nome)', due: c.due ?? null, url: c.shortUrl ?? c.url ?? null })),
  }))
}

// Sem board: lista os quadros. Com board (id ou nome): mostra as listas e os cartões abertos.
export async function trelloOverview(userId, { board } = {}) {
  const connection = await connectionFor(userId, 'trello')
  if (!connection) return { needsConnection: true }
  const boards = await trelloBoards(userId, connection)
  if (!board) return { boards: boards.slice(0, 30) }
  const picked = pickByName(boards, board)
  if (picked.error) return { error: picked.error }
  const lists = (await trelloLists(userId, connection, picked.item.id, true)).slice(0, 15)
  console.log('[trello] quadro', picked.item.name, '| listas:', lists.length, '| cartões:', lists.reduce((n, l) => n + l.cards.length, 0))
  return { board: { id: picked.item.id, name: picked.item.name, url: picked.item.url, lists: lists.map((l) => ({ ...l, cards: l.cards.slice(0, 40) })) } }
}

const dueOf = (value) => {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T12:00:00-03:00`
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text : undefined
}

// Cria um cartão numa lista do quadro. Não apaga nem arquiva nada.
export async function createTrelloCard(userId, { board, list, name, description, due } = {}) {
  const connection = await connectionFor(userId, 'trello')
  if (!connection) return { needsConnection: true }
  const title = clean(name, 200)
  if (!title) return { error: 'Informe o título do cartão' }
  const boards = await trelloBoards(userId, connection)
  const pickedBoard = pickByName(boards, board)
  if (pickedBoard.error) return { error: pickedBoard.error }
  const lists = await trelloLists(userId, connection, pickedBoard.item.id, false)
  const pickedList = pickByName(lists, list)
  if (pickedList.error) return { error: pickedList.error }

  const created = await executeTool(
    userId,
    'TRELLO_ADD_CARDS',
    { idList: pickedList.item.id, name: title, ...(description ? { desc: String(description).slice(0, 8000) } : {}), ...(dueOf(due) ? { due: dueOf(due) } : {}) },
    connection.id,
  )
  const card = created?.response_data ?? created?.card ?? created
  if (!card?.id) return { error: 'O Trello não confirmou a criação do cartão' }
  return { card: { id: card.id, name: title, board: pickedBoard.item.name, list: pickedList.item.name, url: card.shortUrl ?? card.url ?? null, due: dueOf(due) ?? null, action: 'created' } }
}

// Move um cartão (por id ou título) para outra lista do mesmo quadro
export async function moveTrelloCard(userId, { board, card, toList } = {}) {
  const connection = await connectionFor(userId, 'trello')
  if (!connection) return { needsConnection: true }
  const boards = await trelloBoards(userId, connection)
  const pickedBoard = pickByName(boards, board)
  if (pickedBoard.error) return { error: pickedBoard.error }
  const lists = await trelloLists(userId, connection, pickedBoard.item.id, true)
  const target = pickByName(lists, toList)
  if (target.error) return { error: target.error }
  const cards = lists.flatMap((l) => l.cards.map((c) => ({ ...c, listName: l.name })))
  const pickedCard = pickByName(cards, card)
  if (pickedCard.error) return { error: pickedCard.error }

  await executeTool(userId, 'TRELLO_UPDATE_CARDS_BY_ID_CARD', { idCard: pickedCard.item.id, idList: target.item.id }, connection.id)
  return { card: { id: pickedCard.item.id, name: pickedCard.item.name, board: pickedBoard.item.name, list: target.item.name, from: pickedCard.item.listName, url: pickedCard.item.url, action: 'moved' } }
}

// ---------- Outlook (Microsoft: e-mail e agenda) ----------
// As ferramentas do chat são as mesmas do Google; o roteador abaixo escolhe Google ou Microsoft conforme o que o usuário conectou.
const OL = 'ol:' // prefixo dos ids do Outlook, para saber de onde cada e-mail ou evento veio

const firstArray = (d, depth = 0) => {
  if (Array.isArray(d)) return d
  if (!d || typeof d !== 'object' || depth > 3) return []
  for (const v of Object.values(d)) {
    const found = firstArray(v, depth + 1)
    if (found.length) return found
  }
  return []
}

const addressOf = (p) => {
  const a = p?.emailAddress ?? p
  if (!a || typeof a !== 'object') return typeof a === 'string' ? a : ''
  return a.name && a.address ? `${a.name} <${a.address}>` : a.address ?? a.name ?? ''
}

function normalizeOutlookMail(m, limit) {
  const html = m.body?.content ?? ''
  const text = stripHtml(m.bodyPreview && !html ? m.bodyPreview : html || m.bodyPreview || '')
  return {
    id: m.id ? OL + m.id : undefined,
    from: addressOf(m.from ?? m.sender),
    subject: m.subject ?? '',
    date: m.receivedDateTime ?? m.sentDateTime ?? '',
    text: text.slice(0, limit),
    attachments: m.hasAttachments ? ['(tem anexo)'] : [],
  }
}

// converte a busca no estilo Gmail (after:, before:, newer_than:, has:attachment) para a busca do Outlook (KQL)
function toKql(query) {
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  return String(query ?? '')
    .replace(/\bafter:(\d{4})[\/-](\d{2})[\/-](\d{2})/gi, 'received>=$1-$2-$3')
    .replace(/\bbefore:(\d{4})[\/-](\d{2})[\/-](\d{2})/gi, 'received<=$1-$2-$3')
    .replace(/\bnewer_than:(\d+)d/gi, (_, n) => `received>=${day(Number(n))}`)
    .replace(/\bnewer_than:(\d+)m/gi, (_, n) => `received>=${day(Number(n) * 30)}`)
    .replace(/\bhas:attachment/gi, 'hasattachments:true')
    .replace(/\bin:\w+/gi, '')
    .trim()
}

async function searchOutlookMail(userId, { query, queries, maxResults } = {}) {
  const connection = await connectionFor(userId, 'outlook')
  if (!connection) return { needsConnection: 'outlook' }
  const searches = [...new Set([...(Array.isArray(queries) ? queries : []), query].map((q) => toKql(q).slice(0, 300)).filter(Boolean))].slice(0, MAX_QUERIES)
  if (searches.length === 0) searches.push('')
  const top = clamp(maxResults, 1, 25, searches.length > 1 ? 10 : 15)

  const settled = await Promise.allSettled(
    searches.map((q) => executeTool(userId, 'OUTLOOK_LIST_MESSAGES', { folder: 'allfolders', top, ...(q ? { search: q } : {}) }, connection.id)),
  )
  const answered = settled.filter((r) => r.status === 'fulfilled')
  if (answered.length === 0) throw settled[0].reason

  const seen = new Set()
  const emails = []
  for (const { value } of answered) {
    for (const message of firstArray(value)) {
      const email = normalizeOutlookMail(message, searches.length > 1 ? 500 : 700)
      if (!email.id || seen.has(email.id)) continue
      seen.add(email.id)
      emails.push(email)
    }
  }
  console.log('[outlook] busca:', JSON.stringify(searches), '| e-mails:', emails.length)
  if (emails.length === 0) console.log('[outlook] sem e-mails; resposta:', JSON.stringify(answered[0].value)?.slice(0, 300))
  return { emails: emails.slice(0, MAX_EMAILS), nextPageToken: null, total: null, searches: searches.length }
}

async function readOutlookMessage(userId, messageId) {
  const connection = await connectionFor(userId, 'outlook')
  if (!connection) return { needsConnection: 'outlook' }
  const id = String(messageId).replace(new RegExp('^' + OL), '')
  const data = await executeTool(userId, 'OUTLOOK_GET_MESSAGE', { message_id: id }, connection.id)
  return { email: normalizeOutlookMail(data?.response_data ?? data?.message ?? data ?? {}, 4000) }
}

// horário do Outlook: se vier em UTC, passa para Brasília; devolve AAAA-MM-DDTHH:MM:SS-03:00
function olTime(t) {
  const v = t?.dateTime ?? (typeof t === 'string' ? t : '')
  if (!v) return ''
  const zone = String(t?.timeZone ?? '')
  if (/^utc$/i.test(zone) || /z$/i.test(v)) {
    const local = new Date(new Date(v.replace(/z$/i, '').slice(0, 19) + 'Z').getTime() - 3 * 3_600_000)
    return `${local.toISOString().slice(0, 19)}${OFFSET}`
  }
  return `${v.slice(0, 19)}${OFFSET}`
}

async function outlookEvents(userId, { from, to }) {
  const connection = await connectionFor(userId, 'outlook')
  if (!connection) return { needsConnection: 'outlook' }
  const data = await executeTool(
    userId,
    'OUTLOOK_GET_CALENDAR_VIEW',
    { start_datetime: `${from}T00:00:00${OFFSET}`, end_datetime: `${to}T23:59:59${OFFSET}`, timezone: TZ, top: 50 },
    connection.id,
  )
  const events = firstArray(data)
    .filter((e) => e.id && !e.isCancelled)
    .map((e) => ({
      id: OL + e.id,
      calendarId: 'outlook',
      calendar: 'Outlook',
      title: e.subject ?? '(sem título)',
      start: olTime(e.start),
      end: olTime(e.end),
      allDay: Boolean(e.isAllDay),
      location: typeof e.location === 'string' ? e.location : e.location?.displayName ?? '',
      meetLink: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? null,
    }))
  console.log('[outlook] listou', from, 'a', to, '| eventos:', events.length)
  return { events, calendars: ['Outlook'], failed: 0 }
}

async function createOutlookEvent(userId, { title, start, durationMinutes, description, meet }) {
  const connection = await connectionFor(userId, 'outlook')
  if (!connection) return { needsConnection: 'outlook' }
  const when = String(start ?? '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  if (!when) return { error: 'Informe o início no formato AAAA-MM-DDTHH:MM' }
  const minutes = clamp(durationMinutes, 5, 1440, 15)
  const endLocal = new Date(new Date(`${when[1]}T${when[2]}:00Z`).getTime() + minutes * 60_000).toISOString().slice(0, 19)

  const created = await executeTool(
    userId,
    'OUTLOOK_CALENDAR_CREATE_EVENT',
    {
      subject: clean(title, 200) || 'Lembrete',
      start_datetime: `${when[1]}T${when[2]}:00`,
      end_datetime: endLocal,
      time_zone: TZ,
      ...(description ? { body: clean(description, 1000) } : {}),
      ...(meet ? { is_online_meeting: true, online_meeting_provider: 'teamsForBusiness' } : {}),
    },
    connection.id,
  )
  const event = created?.response_data ?? created?.event ?? created
  const id = event?.id ?? event?.event_id
  console.log('[outlook] evento criado; campos:', Object.keys(event ?? {}).join(','), '| reunião online pedida:', Boolean(meet))
  if (!id) return { error: 'A agenda não confirmou a criação do evento' }
  return {
    event: {
      id: OL + id,
      calendarId: 'outlook',
      title: clean(title, 200) || 'Lembrete',
      start: `${when[1]}T${when[2]}:00${OFFSET}`,
      end: new Date(new Date(`${when[1]}T${when[2]}:00${OFFSET}`).getTime() + minutes * 60_000).toISOString(),
      link: event?.webLink ?? null,
      meetLink: event?.onlineMeeting?.joinUrl ?? event?.onlineMeetingUrl ?? null,
      meetRequested: Boolean(meet),
      reminders: [],
    },
  }
}

async function deleteOutlookEvent(userId, eventId) {
  const connection = await connectionFor(userId, 'outlook')
  if (!connection) return { needsConnection: 'outlook' }
  await executeTool(userId, 'OUTLOOK_DELETE_CALENDAR_EVENT', { event_id: String(eventId).replace(new RegExp('^' + OL), '') }, connection.id)
  return { ok: true }
}

// ---------- Roteador Google x Microsoft ----------
// provider: 'outlook' ou 'google' quando o usuário disse qual usar; sem isso vale o que estiver conectado (os dois: junta nas consultas e cria no Google)
async function connected(userId) {
  const apps = new Set((await listConnections(userId).catch(() => [])).map((c) => c.app))
  return { gmail: apps.has('gmail'), calendar: apps.has('googlecalendar'), outlook: apps.has('outlook') }
}
const isOutlook = (p) => String(p ?? '').toLowerCase() === 'outlook'
const isGoogle = (p) => String(p ?? '').toLowerCase() === 'google'

export async function searchGmail(userId, opts = {}) {
  const has = await connected(userId)
  if (isOutlook(opts.provider) || (has.outlook && !has.gmail && !isGoogle(opts.provider))) return searchOutlookMail(userId, opts)
  if (has.outlook && has.gmail && !isGoogle(opts.provider)) {
    const [g, o] = await Promise.allSettled([searchGoogleMail(userId, opts), searchOutlookMail(userId, opts)])
    if (g.status === 'rejected' && o.status === 'rejected') throw g.reason
    const emails = [...(g.value?.emails ?? []), ...(o.value?.emails ?? [])]
    return { emails: emails.slice(0, MAX_EMAILS), nextPageToken: null, total: null, searches: g.value?.searches ?? 1 }
  }
  return searchGoogleMail(userId, opts)
}

export async function readGmailMessage(userId, messageId, provider) {
  if (String(messageId).startsWith(OL) || isOutlook(provider)) return readOutlookMessage(userId, messageId)
  return readGoogleMessage(userId, messageId)
}

export async function calendarEvents(userId, opts = {}) {
  const has = await connected(userId)
  const day = /^\d{4}-\d{2}-\d{2}$/
  if (!day.test(String(opts.from)) || !day.test(String(opts.to))) return { error: 'Informe as datas no formato AAAA-MM-DD' }
  if (isOutlook(opts.provider) || (has.outlook && !has.calendar && !isGoogle(opts.provider))) return outlookEvents(userId, opts)
  if (has.outlook && has.calendar && !isGoogle(opts.provider)) {
    const [g, o] = await Promise.allSettled([googleCalendarEvents(userId, opts), outlookEvents(userId, opts)])
    if (g.status === 'rejected' && o.status === 'rejected') throw g.reason
    const events = [...(g.value?.events ?? []), ...(o.value?.events ?? [])].sort((a, b) => (a.start < b.start ? -1 : 1))
    return {
      events: events.slice(0, 60),
      calendars: [...(g.value?.calendars ?? []), ...(o.value?.calendars ?? [])],
      failed: (g.value?.failed ?? 0) + (g.status === 'rejected' ? 1 : 0) + (o.status === 'rejected' ? 1 : 0),
    }
  }
  return googleCalendarEvents(userId, opts)
}

export async function createCalendarEvent(userId, opts = {}) {
  const has = await connected(userId)
  if (isOutlook(opts.provider) || (has.outlook && !has.calendar && !isGoogle(opts.provider))) return createOutlookEvent(userId, opts)
  return createGoogleEvent(userId, opts)
}

export async function deleteCalendarEvent(userId, eventId, calendarId = 'primary') {
  if (String(eventId).startsWith(OL)) return deleteOutlookEvent(userId, eventId)
  return deleteGoogleEvent(userId, eventId, calendarId)
}
