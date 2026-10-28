import { pool, query } from '../db.js'
import { loadFinancials } from './financial.js'
import { sendWhatsApp, whatsappConfigured } from './whatsapp.js'
import { RULES, scheduledHour } from './agentAlerts.js'

const TICK_MS = 5 * 60 * 1000
const GRACE_HOURS = 3 // se o servidor estava fora no horário, ainda avisa até 3h depois
const PAUSE_MS = 4000 // pausa entre usuários: envio em rajada aumenta o risco de banimento do chip
const TIMEZONE = 'America/Sao_Paulo'

let running = false
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function brNow() {
  const now = new Date()
  return {
    today: now.toLocaleDateString('sv-SE', { timeZone: TIMEZONE }),
    hour: Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: 'numeric', hourCycle: 'h23' }).format(now)),
  }
}

async function processUser(userId, phone, agents, today) {
  let fin = null
  if (agents.some((a) => RULES[a.agentKey].needsData)) fin = await loadFinancials(userId)
  // sem conta conectada os agentes de dados não têm o que avisar
  const data = fin && fin.accounts.length > 0 ? fin : null

  const sections = []
  const sentKeys = [] // [agentId, key] confirmados só depois do envio
  for (const agent of agents) {
    const rule = RULES[agent.agentKey]
    if (rule.needsData && !data) continue
    const done = new Set((await query('SELECT dedupe_key FROM agent_alerts WHERE user_agent_id = ?', [agent.id])).map((r) => r.dedupe_key))
    const fresh = rule.run(data, today, agent).filter((alert) => !done.has(alert.key))
    if (fresh.length === 0) continue
    sections.push(`*${rule.title}*\n${fresh.map((a) => `• ${a.text}`).join('\n')}`)
    for (const alert of fresh) for (const key of [alert.key, ...(alert.alsoMark ?? [])]) sentKeys.push([agent.id, key])
  }

  // uma única mensagem por usuário, mesmo com vários agentes
  if (sections.length > 0) {
    await sendWhatsApp(phone, `*Anota Grana*\n\n${sections.join('\n\n')}`)
    for (const [agentId, key] of sentKeys) {
      await query('INSERT IGNORE INTO agent_alerts (user_agent_id, dedupe_key) VALUES (?, ?)', [agentId, key])
    }
  }
  for (const agent of agents) await query('UPDATE user_agents SET last_run_date = ? WHERE id = ?', [today, agent.id])
  return sections.length > 0
}

// Roda os agentes ativos cujo horário chegou e que ainda não rodaram hoje
export async function runDueAgents() {
  if (running) return
  running = true
  // A hospedagem pode subir mais de um processo da API: o lock do MySQL garante que só um deles rode o ciclo
  // (senão o mesmo aviso sairia duas vezes). O lock vale enquanto esta conexão estiver aberta.
  let lock = null
  try {
    lock = await pool.getConnection()
    const [[{ got }]] = await lock.query("SELECT GET_LOCK('anota_agent_runner', 0) AS got")
    if (got !== 1) return
    const { today, hour } = brNow()
    const rows = await query(
      `SELECT a.id, a.user_id AS userId, a.agent_key AS agentKey, a.frequency, a.spend_limit AS spendLimit, u.phone
       FROM user_agents a JOIN users u ON u.id = a.user_id
       WHERE a.active = 1 AND a.agent_key IS NOT NULL AND (a.last_run_date IS NULL OR a.last_run_date < ?)
       ORDER BY a.user_id, a.id`,
      [today],
    )
    const due = rows.filter((a) => {
      const at = scheduledHour(a.frequency)
      return RULES[a.agentKey] && hour >= at && hour < at + GRACE_HOURS
    })

    const byUser = new Map()
    for (const a of due) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), { ...a, spendLimit: a.spendLimit == null ? null : Number(a.spendLimit) }])

    for (const [userId, agents] of byUser) {
      try {
        const sent = await processUser(userId, agents[0].phone, agents, today)
        if (sent) await sleep(PAUSE_MS)
      } catch (err) {
        // falha de envio ou da Pluggy: não marca como rodado, tenta de novo no próximo ciclo
        console.error(`[agentes] usuário ${userId}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[agentes] falha no ciclo:', err.message)
  } finally {
    if (lock) {
      await lock.query("SELECT RELEASE_LOCK('anota_agent_runner')").catch(() => {})
      lock.release()
    }
    running = false
  }
}

export function startAgentRunner() {
  if (process.env.AGENTS_SCHEDULER === 'off') return console.log('[agentes] agendador desligado (AGENTS_SCHEDULER=off)')
  if (!whatsappConfigured()) return console.log('[agentes] agendador não iniciou: WhatsApp não configurado')
  setTimeout(runDueAgents, 30_000)
  setInterval(runDueAgents, TICK_MS)
  console.log('[agentes] agendador ativo')
}
