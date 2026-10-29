import { categoryInfo } from './vision.js'

const isSpending = (t) => t.amount < 0 && !/credit card payment/i.test(t.category ?? '')
const round = (n) => Math.round(n * 100) / 100
const pad = (n) => String(n).padStart(2, '0')

const GROUPS = {
  moradia: { name: 'Moradia', emoji: '🏠', color: '#06b6d4' },
  compras: { name: 'Compras', emoji: '🛍️', color: '#ec4899' },
  financas: { name: 'Finanças', emoji: '💰', color: '#22c55e' },
  alimentacao: { name: 'Alimentação', emoji: '🍽️', color: '#fb923c' },
  transporte: { name: 'Transporte', emoji: '🚗', color: '#f59e0b' },
  saude: { name: 'Saúde e bem-estar', emoji: '💊', color: '#f43f5e' },
  educacao: { name: 'Educação', emoji: '📚', color: '#8b5cf6' },
  lazer: { name: 'Lazer e viagens', emoji: '🎬', color: '#3b82f6' },
  outros: { name: 'Outros', emoji: '📦', color: '#6b7280' },
}

// categoria (já em português) -> grupo
const GROUP_OF = {
  Água: 'moradia', Eletricidade: 'moradia', Telecomunicação: 'moradia', Internet: 'moradia', 'Contas da casa': 'moradia', Moradia: 'moradia', 'Utensílios para casa': 'moradia',
  Compras: 'compras',
  Transferências: 'financas', 'Empréstimos e financiamento': 'financas', Renda: 'financas', Salário: 'financas', 'Transferência - Mesma instituição': 'financas',
  Supermercado: 'alimentacao', 'Restaurantes, bares e lanchonetes': 'alimentacao', Alimentação: 'alimentacao', 'Delivery de alimentos': 'alimentacao', 'Alimentos e bebidas': 'alimentacao',
  'Táxi e transporte privado urbano': 'transporte', Transporte: 'transporte', Combustível: 'transporte', 'Postos de gasolina': 'transporte', 'Aluguel de veículos': 'transporte', 'Transporte público': 'transporte',
  Saúde: 'saude', Farmácia: 'saude', 'Prática de esportes': 'saude',
  Educação: 'educacao',
  Lazer: 'lazer', Streaming: 'lazer', Assinaturas: 'lazer', Viagens: 'lazer', Bilhetes: 'lazer',
}

// Rótulo curto para mensagens (ex.: resumo do dia): o grupo ("Transporte", "Alimentação"); Finanças e Outros mostram a categoria
export function groupLabel(t) {
  const info = categoryInfo(t)
  const key = GROUP_OF[info.name] ?? 'outros'
  return key === 'financas' || key === 'outros' ? info.name : GROUPS[key].name
}

const SHORT_MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

// Vencimento seguinte: a Pluggy informa o último (já passado); o próximo é o mesmo dia nos meses seguintes
function nextDueDate(raw, today) {
  if (!raw) return null
  const d = new Date(`${String(raw).slice(0, 10)}T12:00:00`)
  const t = new Date(`${today}T12:00:00`)
  while (d < t) d.setMonth(d.getMonth() + 1)
  return d.toLocaleDateString('sv-SE')
}

const shiftKey = (key, delta) => {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

// Aba Cartões. A fatura aberta soma as compras que a Pluggy já marcou para o próximo vencimento
// (billForecastDate); as fechadas vêm das faturas do banco. Sem essa marcação, vale o mês da compra.
export function buildCards({ accounts, transactions, syncedAt }, params) {
  const cards = accounts.filter((a) => a.type === 'CREDIT')
  const charges = transactions.filter((t) => t.accountType === 'CREDIT' && t.amount < 0 && !/credit card payment/i.test(t.category ?? ''))
  const now = new Date()
  const today = now.toLocaleDateString('sv-SE')
  const billKey = (t) => t.billMonth ?? t.date.slice(0, 7)

  const dues = cards.map((c) => nextDueDate(c.credit?.dueDate, today)).filter(Boolean).sort()
  const openKey = dues[0]?.slice(0, 7) ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') && params.month <= openKey ? params.month : openKey

  // fatura de um cartão em um mês de vencimento: a fechada do banco, ou a soma das compras
  const billOf = (card, key) => {
    const closed = card.bills?.find((b) => b.dueDate.slice(0, 7) === key)
    if (closed && key !== openKey) return closed.total
    return round(charges.filter((t) => t.accountId === card.id && billKey(t) === key).reduce((sum, t) => sum + Math.abs(t.amount), 0))
  }
  const totalOf = (key) => round(cards.reduce((sum, c) => sum + billOf(c, key), 0))

  const months = []
  for (let i = 5; i >= 0; i--) {
    const key = shiftKey(openKey, -i)
    const [, mon] = key.split('-').map(Number)
    months.push({ month: key, label: SHORT_MONTHS[mon - 1], total: totalOf(key) })
  }
  const first = months[0].month
  const lastDate = charges[0]?.date ?? null

  const items = cards.map((c) => {
    const limit = c.credit?.limit ?? null
    const available = c.credit?.available ?? null
    const used = limit != null && available != null ? Math.max(0, limit - available) : null
    const closed = c.bills?.find((b) => b.dueDate.slice(0, 7) === month)
    return {
      institution: c.institution,
      // "gold" vira "Nubank Gold"
      name: c.name.toLowerCase().includes(c.institution.toLowerCase()) ? c.name : `${c.institution} ${c.name.charAt(0).toUpperCase()}${c.name.slice(1)}`,
      last4: c.last4,
      bill: billOf(c, month),
      dueDate: month === openKey ? nextDueDate(c.credit?.dueDate, today) : closed?.dueDate ?? null,
      limit,
      available,
      used,
      usedShare: limit ? Math.min(1, used / limit) : null,
    }
  })

  const [year, mon] = month.split('-').map(Number)
  return {
    month,
    label: `${MONTHS_FULL[mon - 1]} de ${year}`,
    shortLabel: `${SHORT_MONTHS[mon - 1]} ${year}`,
    isCurrent: month === openKey,
    hasPrevious: month > first,
    total: totalOf(month),
    lastTransaction: lastDate,
    syncedAt: syncedAt ?? null,
    cards: items,
    history: months,
  }
}

const MONTHS_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

// Gastos do mês agrupados por categoria (com as subcategorias de cada grupo)
export function buildCategories({ transactions }, params) {
  const spending = transactions.filter(isSpending)
  const months = [...new Set(spending.map((t) => t.date.slice(0, 7)))].sort()
  const now = new Date()
  const current = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  const requested = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month : current
  const month = requested

  const list = spending.filter((t) => t.date.slice(0, 7) === month)
  const groups = new Map()
  for (const t of list) {
    const info = categoryInfo(t)
    const key = GROUP_OF[info.name] ?? 'outros'
    const group = groups.get(key) ?? { ...GROUPS[key], total: 0, children: new Map() }
    const amount = Math.abs(t.amount)
    group.total += amount
    const child = group.children.get(info.name) ?? { name: info.name, emoji: info.emoji, total: 0 }
    child.total += amount
    group.children.set(info.name, child)
    groups.set(key, group)
  }

  const total = [...groups.values()].reduce((s, g) => s + g.total, 0)
  const top = Math.max(1, ...[...groups.values()].map((g) => g.total))
  const result = [...groups.values()]
    .sort((a, b) => b.total - a.total)
    .map((g, i) => ({
      rank: i + 1,
      name: g.name,
      emoji: g.emoji,
      color: g.color,
      total: round(g.total),
      share: total ? g.total / total : 0,
      bar: g.total / top,
      children: [...g.children.values()]
        .sort((a, b) => b.total - a.total)
        .map((c) => ({ name: c.name, emoji: c.emoji, total: round(c.total), bar: c.total / g.total })),
    }))

  const [year, mon] = month.split('-').map(Number)
  return {
    month,
    label: `${MONTHS_FULL[mon - 1]} de ${year}`,
    total: round(total),
    hasPrevious: months.some((m) => m < month),
    hasNext: month < current,
    groups: result,
  }
}
