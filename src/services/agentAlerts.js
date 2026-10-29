import { isSpending } from './financial.js'
import { dailySummary } from './dailySummary.js'

// Regras de cada agente. Cada uma recebe os dados financeiros e devolve avisos prontos:
// { key, text }. A "key" identifica o fato avisado, para o mesmo aviso nunca ser enviado duas vezes.
// Prisma (corrige categorias) conversa com o usuário e não tem aviso agendado.

const brl = (n) => `R$ ${Number(n).toFixed(2).replace('.', ',')}`
const dayMonth = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const dayShift = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

// Faro: a mesma cobrança (descrição e valor iguais) em dias seguidos nos últimos 3 dias
export function faroAlerts({ transactions }, today) {
  const since = dayShift(today, -3)
  const recent = transactions.filter((t) => isSpending(t) && !t.installment && t.date >= since)
  const alerts = []
  const seen = new Set()
  for (const a of recent) {
    const twin = recent.find((b) => b !== a && b.description === a.description && Math.abs(b.amount - a.amount) < 0.005 &&
      Math.abs(Date.parse(b.date) - Date.parse(a.date)) <= 86_400_000)
    if (!twin) continue
    const key = `faro:${a.description}:${Math.abs(a.amount).toFixed(2)}:${[a.date, twin.date].sort()[1]}`
    if (seen.has(key)) continue
    seen.add(key)
    alerts.push({ key, text: `Cobrança repetida: ${a.description}, ${brl(Math.abs(a.amount))}, em ${dayMonth(twin.date < a.date ? twin.date : a.date)} e ${dayMonth(twin.date < a.date ? a.date : twin.date)}. Vale conferir se foi cobrado em duplicidade.` })
  }
  return alerts.slice(0, 3)
}

// Teto: gasto do mês contra o limite que o usuário definiu (avisa aos 80% e ao passar de 100%)
export function tetoAlerts({ transactions }, today, limit) {
  if (!limit || limit <= 0) return []
  const month = today.slice(0, 7)
  const spent = transactions.filter((t) => isSpending(t) && t.date.startsWith(month)).reduce((sum, t) => sum + Math.abs(t.amount), 0)
  const percent = Math.round((spent / limit) * 100)
  if (percent >= 100) {
    return [{
      key: `teto:${month}:100`,
      text: `Você passou do limite do mês: gastou ${brl(spent)} e o limite era ${brl(limit)} (${percent}%).`,
      alsoMark: [`teto:${month}:80`],
    }]
  }
  if (percent >= 80) {
    return [{ key: `teto:${month}:80`, text: `Atenção: você já usou ${percent}% do limite do mês (${brl(spent)} de ${brl(limit)}).` }]
  }
  return []
}

// Juízo: compra bem acima do normal nos últimos 3 dias (mínimo R$ 300 e 3x a média das saídas)
export function juizoAlerts({ transactions }, today) {
  const outflows = transactions.filter(isSpending)
  if (outflows.length < 5) return []
  const average = outflows.reduce((sum, t) => sum + Math.abs(t.amount), 0) / outflows.length
  const threshold = Math.max(300, average * 3)
  const since = dayShift(today, -3)
  return outflows
    .filter((t) => t.date >= since && Math.abs(t.amount) >= threshold)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 2)
    .map((t) => ({
      key: `juizo:${t.accountId}:${t.date}:${t.description}:${Math.abs(t.amount).toFixed(2)}`,
      text: `${brl(Math.abs(t.amount))} em ${t.description} no dia ${dayMonth(t.date)}. Isso é bem acima do seu normal. Era necessário mesmo?`,
    }))
}

const MISSIONS = [
  'Passe 3 dias sem comprar nada por impulso.',
  'Revise suas assinaturas e cancele uma que você quase não usa.',
  'Cozinhe em casa em 4 refeições desta semana, no lugar do delivery.',
  'Anote tudo o que gastar até domingo e olhe o total no fim.',
  'Antes de cada compra acima de R$ 100, espere 24h para decidir.',
  'Separe R$ 20 agora para a sua reserva de emergência.',
]

// semana do ano (segunda a domingo) para a missão não repetir na mesma semana
function weekKey(today) {
  const d = new Date(`${today}T12:00:00Z`)
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1, 12))
  const week = Math.floor(((d - start) / 86_400_000 + ((start.getUTCDay() + 6) % 7)) / 7)
  return { id: `${d.getUTCFullYear()}-W${week}`, week }
}

// Faísca: uma missão por semana, sem depender dos dados da conta
export function faiscaAlerts(_fin, today) {
  const { id, week } = weekKey(today)
  return [{ key: `faisca:${id}`, text: `Missão da semana: ${MISSIONS[week % MISSIONS.length]}` }]
}

// Horário do aviso a partir do texto da frequência ("Todo dia às 9h", "às 18:30"); padrão 9h
export function scheduledHour(frequency) {
  const m = /(\d{1,2})\s*(?:h|:\d{2})/i.exec(String(frequency ?? ''))
  const hour = m ? Number(m[1]) : 9
  return hour >= 0 && hour <= 23 ? hour : 9
}

// Horário do aviso em minutos desde a meia-noite ("às 9h" = 540, "18h30" ou "18:30" = 1110); padrão 9h
export function scheduledMinutes(frequency) {
  const m = /(\d{1,2})\s*(?:h\s*(\d{2})?|:(\d{2}))/i.exec(String(frequency ?? ''))
  const hour = m ? Number(m[1]) : 9
  const minute = m ? Number(m[2] ?? m[3] ?? 0) : 0
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : 9 * 60
}

export const RULES = {
  faro: { title: 'Faro', needsData: true, run: (fin, today) => faroAlerts(fin, today) },
  teto: { title: 'Teto', needsData: true, run: (fin, today, agent) => tetoAlerts(fin, today, agent.spendLimit) },
  juizo: { title: 'Juízo', needsData: true, run: (fin, today) => juizoAlerts(fin, today) },
  faisca: { title: 'Faísca', needsData: false, run: (fin, today) => faiscaAlerts(fin, today) },
  // o resumo é uma mensagem própria (não entra na lista de avisos): o agendador chama `summary`
  resumo: { title: 'Resumo', needsData: true, run: () => [], summary: (fin, today) => dailySummary(fin, today) },
}
