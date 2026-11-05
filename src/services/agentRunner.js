import { pool, query } from '../db.js'
import { loadFinancials, refreshFinancials } from './financial.js'
import { sendWhatsApp, whatsappConfigured } from './whatsapp.js'
import { RULES, scheduledMinutes } from './agentAlerts.js'
import { brazilDay } from './dailySummary.js'
import { calendarEvents, calendlyEvents } from './apps.js'
import { composioConfigured } from './composio.js'

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
    minutes: Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: 'numeric', hourCycle: 'h23' }).format(now)) * 60
      + Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, minute: 'numeric' }).format(now)),
  }
}

// Pauta: mensagem da manhã com os compromissos do dia (agendas Google/Outlook + Calendly). Devolve null se não há agenda conectada.
export async function agendaMessage(userId, today) {
  if (!composioConfigured()) return null
  const [cal, cly] = (await Promise.allSettled([
    calendarEvents(userId, { from: today, to: today }),
    calendlyEvents(userId, { from: today, to: today }),
  ])).map((r) => (r.status === 'fulfilled' ? r.value : { failed: true }))
  const usable = (r) => r && !r.failed && !r.needsConnection && !r.error
  if (!usable(cal) && !usable(cly)) {
    // nada conectado: não manda nada. Se estava conectado e deu erro agora, tenta de novo no próximo ciclo
    if (cal.failed || cly.failed) throw new Error('não consegui ler a agenda')
    return null
  }

  // o Calendly também grava na agenda: um evento no mesmo minuto é o mesmo (fica o do Calendly, que traz quem marcou)
  const fromCalendly = usable(cly) ? cly.events : []
  const taken = new Set(fromCalendly.map((e) => String(e.start).slice(0, 16)))
  const others = usable(cal) ? cal.events.filter((e) => e.allDay || !taken.has(String(e.start).slice(0, 16))) : []
  const events = [...others, ...fromCalendly].sort((a, b) => (a.start < b.start ? -1 : 1))

  const label = new Date(`${today}T12:00:00-03:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: TIMEZONE })
  const lines = events.slice(0, 15).map((e) => `• ${e.allDay ? 'Dia todo' : String(e.start).slice(11, 16)} – ${e.title}${e.location ? `\n   ${e.location}` : ''}`)
  const warn = [!usable(cal) && 'a agenda', !usable(cly) && 'o Calendly'].filter(Boolean)
  const note = warn.length > 0 && (cal.failed || cly.failed) ? `\n\n(Não consegui ler ${warn.join(' e ')} agora.)` : ''
  const body = events.length === 0
    ? 'Bom dia! Você não tem nenhum compromisso na agenda hoje 🦊'
    : `Bom dia! Você tem ${events.length} ${events.length === 1 ? 'compromisso' : 'compromissos'} hoje:\n\n${lines.join('\n')}${events.length > 15 ? `\n… e mais ${events.length - 15}` : ''}`
  return `*Anota Grana · Pauta de ${label}*\n\n${body}${note}`
}

async function processUser(userId, phone, agents, today, minutes) {
  let fin = null
  if (agents.some((a) => RULES[a.agentKey].needsData)) {
    // o fechamento do dia pede dados novos ao banco antes de calcular
    fin = agents.some((a) => RULES[a.agentKey].summary) ? await refreshFinancials(userId) : await loadFinancials(userId)
  }
  // sem conta conectada os agentes de dados não têm o que avisar
  const data = fin && fin.accounts.length > 0 ? fin : null

  const sections = []
  const sentKeys = [] // [agentId, key] confirmados só depois do envio
  const alertAgents = agents.filter((a) => !RULES[a.agentKey].summary && !RULES[a.agentKey].agenda)
  for (const agent of alertAgents) {
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
  // o resumo do dia vai em mensagem separada, igual todo dia (se houver conta conectada)
  let summarySent = false
  const summaryAgent = agents.find((a) => RULES[a.agentKey].summary)
  // O banco só manda os dados uma vez por dia (a MeuPluggy não aceita atualização sob demanda): se a atualização de hoje ainda
  // não chegou, espera o próximo ciclo (sem marcar como rodado) e só fecha com aviso na última chance dentro da tolerância.
  let waiting = false
  if (summaryAgent && data) {
    const lastChance = scheduledMinutes(summaryAgent.frequency) + GRACE_HOURS * 60 - 2 * (TICK_MS / 60_000)
    waiting = Boolean(data.syncedAt) && brazilDay(data.syncedAt) < today && minutes < lastChance
    if (waiting) console.log(`[luno] usuário ${userId}: o banco ainda não atualizou hoje (última: ${data.syncedAt}); espera o próximo ciclo`)
  }
  if (summaryAgent && data && !waiting) {
    const text = RULES[summaryAgent.agentKey].summary(data, today, { since: summaryAgent.lastRunAt })
    if (text) {
      await sendWhatsApp(phone, text)
      summarySent = true
      await query('UPDATE user_agents SET last_run_at = UTC_TIMESTAMP() WHERE id = ?', [summaryAgent.id])
      // registro para conferir com o extrato: de quando são os dados e o que entrou em cada conta do cálculo
      const todays = data.transactions.filter((t) => t.date === today)
      console.log(`[luno] usuário ${userId} dados de ${data.syncedAt ?? 'sem data'} | hoje: ${todays.length} transações | último fechamento: ${summaryAgent.lastRunAt ? new Date(summaryAgent.lastRunAt).toISOString() : 'nenhum'}`)
    }
  }
  // a Pauta vai em mensagem própria; se falhar, o erro sobe e o ciclo seguinte tenta de novo
  let agendaSent = false
  const agendaAgent = agents.find((a) => RULES[a.agentKey].agenda)
  if (agendaAgent) {
    const text = await agendaMessage(userId, today)
    if (text) {
      await sendWhatsApp(phone, text)
      agendaSent = true
    }
  }
  for (const agent of agents) {
    if (waiting && agent === summaryAgent) continue
    await query('UPDATE user_agents SET last_run_date = ? WHERE id = ?', [today, agent.id])
  }
  return sections.length > 0 || summarySent || agendaSent
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
    const { today, minutes } = brNow()
    const rows = await query(
      `SELECT a.id, a.user_id AS userId, a.agent_key AS agentKey, a.frequency, a.spend_limit AS spendLimit, a.last_run_at AS lastRunAt, u.phone
       FROM user_agents a JOIN users u ON u.id = a.user_id
       WHERE a.active = 1 AND a.agent_key IS NOT NULL AND u.whatsapp_optout_at IS NULL AND u.plan <> 'free' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= CURDATE()) AND (a.last_run_date IS NULL OR a.last_run_date < ?)
       ORDER BY a.user_id, a.id`,
      [today],
    )
    const due = rows.filter((a) => {
      const at = scheduledMinutes(a.frequency)
      return RULES[a.agentKey] && minutes >= at && minutes < at + GRACE_HOURS * 60
    })

    const byUser = new Map()
    for (const a of due) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), { ...a, spendLimit: a.spendLimit == null ? null : Number(a.spendLimit), lastRunAt: a.lastRunAt ? Date.parse(`${String(a.lastRunAt).replace(' ', 'T')}Z`) : null }])

    for (const [userId, agents] of byUser) {
      try {
        const sent = await processUser(userId, agents[0].phone, agents, today, minutes)
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
