import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'

// Integração com a Pluggy (https://docs.pluggy.ai).
// Fluxo: o servidor cria um connectToken -> o front abre o Pluggy Connect com ele ->
// o usuário autoriza no banco -> o widget devolve o itemId -> o front manda o itemId para cá.
// Os dados (contas, transações) são sempre lidos pelo servidor, com a API Key.

const API_KEY_TTL_MS = 110 * 60 * 1000 // a API Key da Pluggy vale 2 horas
let cachedKey = { value: null, expiresAt: 0 }

function ensureConfigured() {
  const { clientId, clientSecret } = config.openFinance
  if (!clientId || !clientSecret) {
    throw new HttpError(503, 'Pluggy não configurada (OPEN_FINANCE_CLIENT_ID e OPEN_FINANCE_CLIENT_SECRET no .env)')
  }
}

async function pluggyFetch(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const response = await fetch(`${config.openFinance.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error(`[pluggy] ${method} ${path.split('?')[0]} -> ${response.status}`, detail.slice(0, 300))
    let code = null
    try { code = JSON.parse(detail).codeDescription ?? null } catch { /* corpo não era JSON */ }
    return { ok: false, status: response.status, code }
  }
  return { ok: true, data: await response.json() }
}

async function getApiKey(force = false) {
  ensureConfigured()
  if (!force && cachedKey.value && Date.now() < cachedKey.expiresAt) return cachedKey.value

  const { clientId, clientSecret } = config.openFinance
  const result = await pluggyFetch('/auth', { method: 'POST', body: { clientId, clientSecret } })
  if (!result.ok || !result.data.apiKey) {
    throw new HttpError(502, 'Não foi possível autenticar na Pluggy. Confira o Client ID e o Client Secret')
  }
  cachedKey = { value: result.data.apiKey, expiresAt: Date.now() + API_KEY_TTL_MS }
  return cachedKey.value
}

// Chamada autenticada; renova a API Key uma vez se ela tiver expirado/sido invalidada
async function pluggy(path, options = {}) {
  let result = await pluggyFetch(path, { ...options, headers: { 'X-API-KEY': await getApiKey() } })
  if (!result.ok && (result.status === 401 || result.status === 403)) {
    result = await pluggyFetch(path, { ...options, headers: { 'X-API-KEY': await getApiKey(true) } })
  }
  if (!result.ok) {
    // em consultas (GET), 400/404 significam id inexistente ou malformado (os ids vêm do usuário)
    if (result.code === 'TRIAL_CLIENT_ITEM_CREATE_NOT_ALLOWED') {
      throw new HttpError(403, 'Sua conta da Pluggy é de teste (Trial): só permite o MeuPluggy e os bancos de teste. Para conectar bancos reais é preciso ativar o plano de produção na Pluggy.')
    }
    const isLookup = (options.method ?? 'GET') === 'GET'
    if (result.status === 404 || (result.status === 400 && isLookup)) throw new HttpError(404, 'Recurso não encontrado na Pluggy')
    throw new HttpError(502, 'A Pluggy não respondeu como esperado. Tente de novo')
  }
  return result.data
}

// Status do Item (Pluggy) -> status interno da conexão
export function mapItemStatus(item) {
  switch (item.status) {
    case 'UPDATED': return 'connected'
    case 'LOGIN_ERROR':
    case 'OUTDATED': return 'error'
    default: return 'pending' // UPDATING, WAITING_USER_INPUT, WAITING_USER_ACTION...
  }
}

// Ordem de destaque na lista (a mesma do Pierre original)
const POPULAR = ['Nubank', 'Inter', 'Itaú', 'Mercado Pago', 'Santander', 'PicPay', 'Banco do Brasil', 'Bradesco', 'InfinitePay', 'C6 Bank']
const CONNECTORS_TTL_MS = 60 * 60 * 1000
let connectorsCache = { list: null, expiresAt: 0 }

const MEUPLUGGY_ID = 200 // conexão da conta pessoal do próprio usuário, via MeuPluggy
const SANDBOX_OPEN_FINANCE_ID = 600 // banco de mentira que simula o fluxo Open Finance
const PLUGGY_BANK_ID = 2 // banco de mentira de login direto, sem sair do Anota Grana
// credenciais de teste publicadas pela Pluggy para o Pluggy Bank (não são de nenhuma conta real)
const PLUGGY_BANK_CREDENTIALS = { user: 'user-ok', password: 'password-ok' }
// CPF de teste publicado pela Pluggy para o fluxo normal do sandbox (o conector recusa CPFs reais)
export const SANDBOX_CPF = '76109277673'

const toInstitution = (c, extra = {}) => ({
  id: c.id,
  name: c.name,
  type: c.type === 'INVESTMENT' ? 'invest' : 'bank',
  imageUrl: c.imageUrl,
  primaryColor: c.primaryColor,
  needsCpf: (c.credentials ?? []).some((cred) => cred.name === 'cpf'),
  ...extra,
})

// Instituições Open Finance para pessoa física (bancos e corretoras), com os destaques no topo.
export async function listInstitutions() {
  if (connectorsCache.list && Date.now() < connectorsCache.expiresAt) return connectorsCache.list

  const [live, sandbox] = await Promise.all([
    pluggy('/connectors?countries=BR'),
    config.isProd ? { results: [] } : pluggy('/connectors?sandbox=true'),
  ])
  const liveList = live.results ?? []

  const featured = []
  const meuPluggy = liveList.find((c) => c.id === MEUPLUGGY_ID)
  if (meuPluggy) featured.push(toInstitution(meuPluggy, { featured: true, note: 'Conta pessoal' }))
  const pluggyBank = (sandbox.results ?? []).find((c) => c.id === PLUGGY_BANK_ID)
  if (pluggyBank) featured.push(toInstitution(pluggyBank, { featured: true, sandbox: true, direct: true, note: 'Teste' }))
  const sandboxOf = (sandbox.results ?? []).find((c) => c.id === SANDBOX_OPEN_FINANCE_ID)
  if (sandboxOf) featured.push(toInstitution(sandboxOf, { featured: true, sandbox: true, note: 'Teste' }))

  const banks = liveList
    .filter((c) => c.isOpenFinance && c.oauth && (c.type === 'PERSONAL_BANK' || c.type === 'INVESTMENT'))
    .map((c) => toInstitution(c))
    .sort((x, y) => {
      const px = POPULAR.indexOf(x.name)
      const py = POPULAR.indexOf(y.name)
      if (px !== -1 || py !== -1) return (px === -1 ? 99 : px) - (py === -1 ? 99 : py)
      if (x.type !== y.type) return x.type === 'bank' ? -1 : 1
      return x.name.localeCompare(y.name, 'pt-BR')
    })

  const list = [...featured, ...banks]
  connectorsCache = { list, expiresAt: Date.now() + CONNECTORS_TTL_MS }
  return list
}

// Cria o Item. Fluxo OAuth (padrão): sem senha do banco, só o CPF, e o banco devolve depois a URL de
// autorização. O Pluggy Bank (teste) é de login direto, com as credenciais de teste da Pluggy.
export async function createItem({ institution, cpf, userId, redirectUri }) {
  const parameters = institution.direct ? PLUGGY_BANK_CREDENTIALS : institution.needsCpf ? { cpf } : {}
  return pluggy('/items', {
    method: 'POST',
    body: {
      connectorId: institution.id,
      parameters,
      clientUserId: String(userId),
      // a Pluggy só aceita HTTPS público (nunca localhost); sem ele o front acompanha por consulta
      ...(redirectUri ? { oauthRedirectUri: redirectUri } : {}),
    },
  })
}

// URL da página de autorização do banco (a que mostra o QR Code), quando já estiver pronta
export function oauthAuthorization(item) {
  const p = item.parameter
  if (p && p.type === 'oauth' && p.data) return { url: p.data, expiresAt: p.expiresAt ?? null }
  return null
}

export async function getItem(itemId) {
  return pluggy(`/items/${encodeURIComponent(itemId)}`)
}

export async function getAccounts(itemId) {
  const data = await pluggy(`/accounts?itemId=${encodeURIComponent(itemId)}`)
  return data.results ?? []
}

// Identidade do titular (nome completo etc.); alguns bancos não compartilham: aí devolve null
export async function getIdentity(itemId) {
  try {
    return await pluggy(`/identity?itemId=${encodeURIComponent(itemId)}`)
  } catch (err) {
    if (err.status === 404) return null
    throw err
  }
}

export async function getAccount(accountId) {
  return pluggy(`/accounts/${encodeURIComponent(accountId)}`)
}

// Usa o /v2/transactions (paginação por cursor); o /transactions antigo será removido em 31/12/2026.
export async function getTransactions(accountId, { dateFrom, dateTo, maxPages = 5 } = {}) {
  const params = new URLSearchParams({ accountId })
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)

  const transactions = []
  let path = `/v2/transactions?${params}`
  for (let page = 0; page < maxPages && path; page++) {
    const data = await pluggy(path)
    transactions.push(...(data.results ?? []))
    // "next" já vem como query string pronta (ex.: "?accountId=...&after=...")
    path = data.next ? `/v2/transactions${data.next}` : null
  }
  return transactions
}

// Faturas fechadas de um cartão (a fatura aberta não vem pronta: ela se soma pelas compras)
export async function getBills(accountId) {
  const data = await pluggy(`/bills?accountId=${encodeURIComponent(accountId)}`)
  return data.results ?? []
}
