import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'

// Composio (https://docs.composio.dev): cuida do login (OAuth) e das ações de cada app conectado.
// O Anota Grana guarda só quem é o usuário ("entidade") e pede a Composio para conectar e executar ferramentas.
export const composioConfigured = () => Boolean(config.composio.apiKey)

const entity = (userId) => `anotagrana_${userId}`

async function call(method, path, { body, query } = {}) {
  const url = new URL(`${config.composio.baseUrl}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) if (value != null) url.searchParams.set(key, value)
  let response
  try {
    response = await fetch(url, {
      method,
      headers: { 'x-api-key': config.composio.apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(40_000),
    })
  } catch {
    throw new HttpError(502, 'Não consegui falar com o serviço de conexões agora. Tente de novo')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    console.error('[composio]', method, path, response.status, JSON.stringify(data)?.slice(0, 300))
    throw new HttpError(502, 'O serviço de conexões recusou o pedido. Tente de novo')
  }
  return data
}

// Configuração de login de cada app. Use COMPOSIO_AUTH_CONFIG_<APP> (ex.: COMPOSIO_AUTH_CONFIG_GMAIL) para fixar uma criada no painel;
// sem ela, cria uma com o login gerenciado pela Composio na primeira conexão e lembra dela enquanto o servidor estiver no ar.
const authConfigs = new Map()
async function authConfigFor(toolkit) {
  const fixed = process.env[`COMPOSIO_AUTH_CONFIG_${toolkit.toUpperCase()}`]
  if (fixed) return fixed
  if (authConfigs.has(toolkit)) return authConfigs.get(toolkit)
  const data = await call('POST', '/auth_configs', { body: { toolkit: { slug: toolkit }, auth_config: { type: 'use_composio_managed_auth', name: toolkit } } })
  const id = data?.auth_config?.id
  if (!id) throw new HttpError(502, 'Não consegui preparar a conexão com este app')
  console.log(`[composio] criou a configuração de login de ${toolkit}: ${id}. Para fixar, defina COMPOSIO_AUTH_CONFIG_${toolkit.toUpperCase()}=${id}`)
  authConfigs.set(toolkit, id)
  return id
}

// Endereço para onde mandar o usuário se conectar; a Composio devolve para callbackUrl quando termina
export async function startConnection(userId, toolkit, callbackUrl) {
  const authConfigId = await authConfigFor(toolkit)
  const data = await call('POST', '/connected_accounts/link', {
    body: { user_id: entity(userId), auth_config_id: authConfigId, ...(callbackUrl ? { callback_url: callbackUrl } : {}) },
  })
  if (!data?.redirect_url) throw new HttpError(502, 'Não consegui abrir a conexão com este app')
  forget(userId)
  return data.redirect_url
}

// Conexões ativas do usuário: [{ id, app }]; guardadas por alguns segundos porque o chat consulta a cada ferramenta
const cache = new Map()
const forget = (userId) => cache.delete(userId)

export async function listConnections(userId) {
  const hit = cache.get(userId)
  if (hit && Date.now() < hit.expiresAt) return hit.list
  const data = await call('GET', '/connected_accounts', { query: { user_ids: entity(userId), statuses: 'ACTIVE' } })
  const list = (data?.items ?? [])
    .map((item) => ({ id: item.id, app: String(item.toolkit?.slug ?? item.toolkit_slug ?? '').toLowerCase() }))
    .filter((item) => item.id && item.app)
  cache.set(userId, { list, expiresAt: Date.now() + 15_000 })
  return list
}

export async function connectionFor(userId, toolkit) {
  return (await listConnections(userId)).find((item) => item.app === toolkit) ?? null
}

export async function removeConnections(userId, toolkit) {
  const mine = (await listConnections(userId)).filter((item) => item.app === toolkit)
  for (const item of mine) await call('DELETE', `/connected_accounts/${item.id}`)
  forget(userId)
  return mine.length
}

// Revoga tudo (exclusão da conta). Falhas não travam a exclusão.
export async function removeAllConnections(userId) {
  if (!composioConfigured()) return
  forget(userId)
  const list = await listConnections(userId).catch(() => [])
  await Promise.all(list.map((item) => call('DELETE', `/connected_accounts/${item.id}`).catch((err) => console.error('[composio] não revogou na exclusão da conta:', err.message))))
  forget(userId)
}

// Executa uma ferramenta de um app conectado (ex.: GMAIL_FETCH_EMAILS) em nome do usuário
export async function executeTool(userId, slug, args, connectedAccountId) {
  const data = await call('POST', `/tools/execute/${slug}`, {
    body: { user_id: entity(userId), ...(connectedAccountId ? { connected_account_id: connectedAccountId } : {}), arguments: args, version: 'latest' },
  })
  if (data?.successful === false) {
    console.error('[composio]', slug, 'falhou:', String(data.error).slice(0, 300))
    throw new HttpError(502, 'O app não respondeu ao pedido')
  }
  const result = data?.data ?? data
  // algumas ferramentas devolvem o resultado como texto JSON
  if (typeof result === 'string') {
    try {
      return JSON.parse(result)
    } catch {
      return result
    }
  }
  return result
}
