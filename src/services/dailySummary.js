import { isSpending } from './financial.js'
import { groupLabel } from './visionCategories.js'

// Resumo do dia por WhatsApp (agente "Resumo"): quanto gastou hoje, em quê, como o mês está em relação ao mês passado
// e um alerta de cobrança repetida de hoje. Devolve o texto pronto, ou null se não há conta conectada.

const brl = (n) => `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dayMonth = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

function previousMonth(month) {
  const [year, mon] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, mon - 2, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

const sum = (list) => list.reduce((total, t) => total + Math.abs(t.amount), 0)

// Cobrança igual (mesma descrição e valor) em dias seguidos, em que a segunda é a de hoje
function repeatedToday(spending, today) {
  const todays = spending.filter((t) => t.date === today && !t.installment)
  for (const a of todays) {
    const twin = spending.find((b) => b !== a && !b.installment && b.description === a.description &&
      Math.abs(Math.abs(b.amount) - Math.abs(a.amount)) < 0.005 && b.date < today && Date.parse(`${today}T12:00:00Z`) - Date.parse(`${b.date}T12:00:00Z`) <= 86_400_000)
    if (twin) return `*Atenção:* ${a.description} foi cobrado 2 vezes (${brl(Math.abs(a.amount))}), em ${dayMonth(twin.date)} e ${dayMonth(today)}. Vale conferir se foi duplicado.`
  }
  return null
}

export function dailySummary({ accounts, transactions }, today) {
  if (!accounts || accounts.length === 0) return null
  const spending = transactions.filter(isSpending)

  const todays = spending.filter((t) => t.date === today)
  const lines = [`*Resumo do dia · ${dayMonth(today)}*`, '']

  if (todays.length === 0) {
    lines.push('Hoje não vi nenhum gasto nas suas contas. Alguns bancos demoram para lançar: se aparecer algo depois, entra no resumo de amanhã.')
  } else {
    lines.push(`Hoje você gastou *${brl(sum(todays))}*.`)
    const byCategory = new Map()
    for (const t of todays) {
      const name = groupLabel(t)
      byCategory.set(name, (byCategory.get(name) ?? 0) + Math.abs(t.amount))
    }
    const top = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    lines.push(top.map(([name, total]) => `${name} ${brl(total)}`).join(' · '))
  }

  // o mês contra o mesmo trecho do mês passado (até o mesmo dia), em vez de um limite que o usuário não definiu
  const month = today.slice(0, 7)
  const before = previousMonth(month)
  const day = today.slice(8, 10)
  const monthSpent = sum(spending.filter((t) => t.date.startsWith(month) && t.date <= today))
  const lastSpent = sum(spending.filter((t) => t.date.startsWith(before) && t.date.slice(8, 10) <= day))
  lines.push('')
  if (lastSpent > 0) {
    const change = Math.round((monthSpent / lastSpent - 1) * 100)
    const compare = change === 0 ? 'igual ao' : `${Math.abs(change)}% ${change > 0 ? 'a mais' : 'a menos'} que no`
    lines.push(`No mês você já gastou ${brl(monthSpent)}, ${compare} mesmo período do mês passado.`)
  } else {
    lines.push(`No mês você já gastou ${brl(monthSpent)}.`)
  }

  const attention = repeatedToday(spending, today)
  if (attention) lines.push('', attention)

  lines.push('', 'Quer que eu detalhe? Responda aqui.')
  return lines.join('\n')
}
