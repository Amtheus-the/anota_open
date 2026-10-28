import { pool } from '../db.js'
import { config } from '../config.js'
import { whatsappConfigured } from '../services/whatsapp.js'

const TABLES = ['users', 'verification_codes', 'connected_accounts', 'conversations', 'chat_messages', 'user_agents', 'agent_alerts', 'whatsapp_inbound', 'payments']

// dicas para o erro de banco mais comum; só o código do erro aparece na tela (nunca host, usuário ou senha)
const DB_HINTS = {
  ECONNREFUSED: 'O MySQL recusou a conexão. Confira DB_HOST e DB_PORT (na Hostinger o host costuma ser "localhost" ou o que aparece no painel do banco).',
  ENOTFOUND: 'O endereço do banco não foi encontrado. Confira DB_HOST.',
  ETIMEDOUT: 'A conexão com o banco demorou demais. Confira DB_HOST e DB_PORT.',
  ER_ACCESS_DENIED_ERROR: 'Usuário ou senha do banco incorretos. Confira DB_USER e DB_PASSWORD.',
  ER_BAD_DB_ERROR: 'O banco informado não existe. Crie-o no painel e confira DB_NAME.',
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}min`].filter(Boolean).join(' ')
}

async function checkDatabase() {
  try {
    await pool.query('SELECT 1')
  } catch (err) {
    return { ok: false, code: err.code ?? 'ERRO', hint: DB_HINTS[err.code] ?? 'Erro ao falar com o banco. Veja os logs do servidor.' }
  }
  try {
    const [rows] = await pool.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()')
    const existing = new Set(rows.map((r) => r.name))
    return { ok: true, missing: TABLES.filter((t) => !existing.has(t)) }
  } catch {
    return { ok: true, missing: null }
  }
}

const row = (label, ok, detail = '') =>
  `<li class="${ok ? 'ok' : 'bad'}"><b>${ok ? '✔' : '✖'}</b><span>${escapeHtml(label)}${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span></li>`

export default async function statusPage(_req, res) {
  const db = await checkDatabase()
  const tablesOk = db.ok && db.missing?.length === 0

  const items = [
    row('Servidor rodando', true, `no ar há ${formatUptime(process.uptime())} · Node ${process.version} · ${config.isProd ? 'produção' : 'desenvolvimento'}`),
    row('Banco de dados conectado', db.ok, db.ok ? `${config.db.database}` : `${db.code}: ${db.hint}`),
    ...(db.ok
      ? [row('Tabelas criadas', tablesOk, db.missing == null ? 'não foi possível conferir' : tablesOk ? `${TABLES.length} tabelas` : `faltam: ${db.missing.join(', ')}. Rode "npm run db:init" uma vez.`)]
      : []),
    row('JWT_SECRET definido', Boolean(config.jwt.secret)),
    row('OpenAI (chat)', Boolean(config.openai.apiKey), config.openai.apiKey ? '' : 'falta OPENAI_API_KEY'),
    row('Pluggy (Open Finance)', Boolean(config.openFinance.clientId && config.openFinance.clientSecret), config.openFinance.clientId ? '' : 'falta OPEN_FINANCE_CLIENT_ID e OPEN_FINANCE_CLIENT_SECRET'),
    row('WhatsApp (W-API)', whatsappConfigured(), whatsappConfigured() ? '' : 'falta WHATSAPP_INSTANCE_ID e WHATSAPP_TOKEN: sem isso o cadastro não envia o código'),
    row('Conversa pelo WhatsApp (webhook)', Boolean(config.whatsapp.webhookSecret), config.whatsapp.webhookSecret ? '' : 'falta WHATSAPP_WEBHOOK_SECRET: sem isso o Anota Grana não responde mensagens recebidas'),
    row('Painel admin (ADMIN_CPFS)', config.adminCpfs.length > 0, config.adminCpfs.length > 0 ? `${config.adminCpfs.length} CPF(s) com acesso; confira se não há espaço ou letra: ${config.adminCpfs.every((cpf) => cpf.length === 11) ? 'todos com 11 dígitos' : 'algum não tem 11 dígitos'}` : 'ADMIN_CPFS não definido: ninguém acessa o /admin'),
    row('Endereço do site (CORS)', Boolean(process.env.FRONTEND_URL), process.env.FRONTEND_URL ? config.frontendUrl : 'FRONTEND_URL não definido: usando http://localhost:5173, o site publicado não conseguirá falar com a API'),
  ]
  const allOk = db.ok && tablesOk

  res.status(db.ok ? 200 : 503).type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Status · Anota Grana API</title>
<style>
body{margin:0;background:#09090b;color:#fafafa;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{width:100%;max-width:560px}
h1{font-size:22px;margin:0 0 4px}
.banner{margin:16px 0;padding:14px 16px;border-radius:12px;font-weight:600;background:${allOk ? '#052e1a' : '#3b0a0a'};color:${allOk ? '#4ade80' : '#f87171'}}
ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
li{display:flex;gap:12px;padding:12px 14px;border-radius:12px;background:#18181b;border:1px solid #27272a}
li b{flex:none}li.ok b{color:#4ade80}li.bad b{color:#f87171}
small{display:block;color:#a1a1aa;font-size:13px;margin-top:2px;word-break:break-word}
p{color:#71717a;font-size:13px}a{color:#a1a1aa}
</style></head><body><main>
<h1>Anota Grana · API</h1>
<div class="banner">${allOk ? 'Tudo certo: o servidor está no ar e o banco responde.' : db.ok ? 'O servidor está no ar, mas o banco precisa de atenção.' : 'O servidor está no ar, mas o banco de dados não conectou.'}</div>
<ul>${items.join('')}</ul>
<p>Atualize a página para verificar de novo. Versão em JSON: <a href="/api/health">/api/health</a></p>
</main></body></html>`)
}
