// Números da tela Vision, calculados no servidor a partir das contas e transações da Pluggy.
const round = (n) => Math.round(n * 100) / 100
const localDate = (date) => date.toLocaleDateString('sv-SE') // YYYY-MM-DD no fuso do servidor

// categoria (como a Pluggy devolve) -> nome em português e emoji
const CATEGORIES = [
  ['credit card payment', 'Pagamento de cartão de crédito', '💰'],
  ['transfer - internal', 'Transferência - Mesma instituição', '💰'],
  ['transfer', 'Transferências', '💰'],
  ['loans', 'Empréstimos e financiamento', '💰'],
  ['taxi', 'Táxi e transporte privado urbano', '🚗'],
  ['ride', 'Táxi e transporte privado urbano', '🚗'],
  ['car rental', 'Aluguel de veículos', '🚗'],
  ['gas station', 'Postos de gasolina', '🚗'],
  ['public transportation', 'Transporte público', '🚗'],
  ['transport', 'Transporte', '🚗'],
  ['groceries', 'Supermercado', '🍽️'],
  ['supermarket', 'Supermercado', '🍽️'],
  ['food delivery', 'Delivery de alimentos', '🍽️'],
  ['food and drinks', 'Alimentos e bebidas', '🍽️'],
  ['eating out', 'Restaurantes, bares e lanchonetes', '🍽️'],
  ['restaurant', 'Restaurantes, bares e lanchonetes', '🍽️'],
  ['food', 'Alimentação', '🍽️'],
  ['shopping', 'Compras', '🛍️'],
  ['online', 'Compras', '🛍️'],
  ['houseware', 'Utensílios para casa', '🏠'],
  ['water', 'Água', '🏠'],
  ['electric', 'Eletricidade', '🏠'],
  ['telecom', 'Telecomunicação', '🏠'],
  ['internet', 'Internet', '🏠'],
  ['utilit', 'Contas da casa', '🏠'],
  ['housing', 'Moradia', '🏠'],
  ['digital services', 'Serviços digitais', '💻'],
  ['services', 'Serviços', '📦'],
  ['donation', 'Doações', '🎁'],
  ['tickets', 'Bilhetes', '🎬'],
  ['pharmacy', 'Farmácia', '💊'],
  ['health', 'Saúde', '💊'],
  ['sports', 'Prática de esportes', '💊'],
  ['education', 'Educação', '📚'],
  ['entertainment', 'Lazer', '🎬'],
  ['streaming', 'Streaming', '🎬'],
  ['travel', 'Viagens', '✈️'],
  ['gas', 'Combustível', '🚗'],
  ['subscription', 'Assinaturas', '🎬'],
  ['income', 'Renda', '💰'],
  ['salary', 'Salário', '💰'],
]

export function categoryInfo(t) {
  const raw = t.category ?? ''
  const found = CATEGORIES.find(([key]) => raw.toLowerCase().includes(key))
  if (found) return { name: found[1], emoji: found[2] }
  return { name: t.categoryPt ?? (raw || 'Outros'), emoji: '🏷️' }
}

const isCardBillPayment = (t) => /credit card payment/i.test(t.category ?? '')
const isSpending = (t) => t.amount < 0 && !isCardBillPayment(t)

const monthKey = (date) => date.slice(0, 7)

function shiftMonth(year, month, delta) {
  const d = new Date(year, month - 1 + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

const pad = (n) => String(n).padStart(2, '0')

import { brandFor } from './brands.js'

// Compras recorrentes (mesmo estabelecimento e valor parecido em meses diferentes) viram "assinaturas"
function detectSubscriptions(transactions, today) {
  const groups = new Map()
  for (const t of transactions.filter(isSpending)) {
    const key = t.description
      .toLowerCase()
      .replace(/^.*\|/, '')
      .replace(/[^a-zà-ú]+/g, ' ')
      .trim()
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }
  const result = []
  for (const [key, list] of groups) {
    const months = new Set(list.map((t) => monthKey(t.date)))
    if (months.size < 2) continue
    const amounts = list.map((t) => Math.abs(t.amount))
    const average = amounts.reduce((a, b) => a + b, 0) / amounts.length
    if (!amounts.every((a) => Math.abs(a - average) <= average * 0.1)) continue
    // um por mês, no máximo (compras várias vezes no mesmo mês não são assinatura)
    if (list.length > months.size + 1) continue
    const last = list.reduce((a, b) => (a.date >= b.date ? a : b))
    // só serviços de assinatura conhecidos (streaming, telefonia, software...): uma parcela ou uma cafeteria que se repete não é assinatura
    const brand = brandFor(`${key} ${last.description}`)
    if (!brand?.subscription) continue
    const next = new Date(`${last.date}T12:00:00`)
    next.setDate(next.getDate() + 30) // como o Pierre original: última cobrança + 30 dias
    result.push({
      name: brand.name,
      amount: round(Math.abs(last.amount)),
      description: last.description,
      institution: last.institution,
      domain: brand.domain,
      payments: list.length,
      lastPayment: last.date,
      nextPayment: localDate(next),
      active: localDate(next) >= today,
    })
  }
  return result.filter((s) => s.active).sort((a, b) => b.amount - a.amount)
}

export function buildVision({ accounts, transactions, connections }) {
  const now = new Date()
  const today = localDate(now)
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const dayOfMonth = now.getDate()
  const current = `${year}-${pad(month)}`
  const prevParts = shiftMonth(year, month, -1)
  const previous = `${prevParts.year}-${pad(prevParts.month)}`
  const daysInMonth = new Date(year, month, 0).getDate()
  const daysInPrevious = new Date(prevParts.year, prevParts.month, 0).getDate()

  const spending = transactions.filter(isSpending)
  const inMonth = (key) => spending.filter((t) => monthKey(t.date) === key)
  const currentList = inMonth(current)
  const previousList = inMonth(previous)

  const perDay = (list, days) => {
    const amounts = Array(days).fill(0)
    const counts = Array(days).fill(0)
    for (const t of list) {
      const d = Number(t.date.slice(8, 10)) - 1
      if (d >= 0 && d < days) {
        amounts[d] += Math.abs(t.amount)
        counts[d] += 1
      }
    }
    return { amounts, counts }
  }
  const cur = perDay(currentList, daysInMonth)
  const prev = perDay(previousList, daysInPrevious)

  // ritmo: gasto acumulado dia a dia, este mês x mês passado
  const rhythm = []
  let curSum = 0
  let prevSum = 0
  for (let day = 1; day <= 31; day += 1) {
    if (day <= daysInMonth && day <= dayOfMonth) curSum += cur.amounts[day - 1]
    if (day <= daysInPrevious) prevSum += prev.amounts[day - 1]
    rhythm.push({
      day,
      current: day <= dayOfMonth && day <= daysInMonth ? round(curSum) : null,
      previous: day <= daysInPrevious ? round(prevSum) : round(prevSum),
    })
  }
  const currentTotal = round(cur.amounts.slice(0, dayOfMonth).reduce((a, b) => a + b, 0))
  const previousSameDay = round(prev.amounts.slice(0, Math.min(dayOfMonth, daysInPrevious)).reduce((a, b) => a + b, 0))
  const previousTotal = round(prev.amounts.reduce((a, b) => a + b, 0))
  const changePct = previousSameDay > 0 ? round(((currentTotal - previousSameDay) / previousSameDay) * 100) : null

  // mapa de calor: um quadrado por dia do mês até hoje
  const heatmap = cur.amounts.slice(0, dayOfMonth).map((amount, i) => {
    const date = `${current}-${pad(i + 1)}`
    return { date, amount: round(amount), count: cur.counts[i], weekday: new Date(year, month - 1, i + 1).getDay() }
  })
  const highest = heatmap.reduce((a, b) => (b.amount > a.amount ? b : a), { amount: 0, date: null })

  // categorias do mês x mês passado
  const totalsBy = (list) => {
    const map = new Map()
    for (const t of list) {
      const info = categoryInfo(t)
      map.set(info.name, { ...info, total: (map.get(info.name)?.total ?? 0) + Math.abs(t.amount) })
    }
    return map
  }
  const curCats = totalsBy(currentList)
  const prevCats = totalsBy(previousList)
  const categories = [...curCats.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map((c) => {
      const before = prevCats.get(c.name)?.total ?? null
      return {
        name: c.name,
        emoji: c.emoji,
        current: round(c.total),
        previous: before === null ? null : round(before),
        change: before === null || before === 0 ? null : Math.round(((c.total - before) / before) * 100),
      }
    })

  // contas e cartões
  const bankAccounts = accounts.filter((a) => a.type !== 'CREDIT')
  const cards = accounts
    .filter((a) => a.type === 'CREDIT')
    .map((a) => ({
      institution: a.institution,
      // "gold" vira "Nubank Gold"
      name: a.name.toLowerCase().includes(a.institution.toLowerCase()) ? a.name : `${a.institution} ${a.name.charAt(0).toUpperCase()}${a.name.slice(1)}`,
      last4: a.last4,
      limit: a.credit?.limit ?? null,
      available: a.credit?.available ?? null,
      dueDate: a.credit?.dueDate ?? null,
    }))
  const totalLimit = cards.reduce((s, c) => s + Number(c.limit ?? 0), 0)
  const totalAvailable = cards.reduce((s, c) => s + Number(c.available ?? 0), 0)

  // últimas transações (com as semelhantes: mesmo estabelecimento, de outras datas)
  const merchantKey = (t) =>
    t.description.toLowerCase().replace(/^.*\|/, '').replace(/[^a-zà-ú ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 18)
  // últimos 5 dias (como no Pierre original); sem movimento recente, mostra as 10 últimas
  const cutoff = localDate(new Date(now.getTime() - 5 * 86_400_000))
  let latest = transactions.filter((t) => t.date >= cutoff).slice(0, 30)
  if (latest.length < 5) latest = transactions.slice(0, 10)
  const recent = latest.map((t) => {
    const info = categoryInfo(t)
    const key = merchantKey(t)
    const similar = key.length < 3
      ? []
      : transactions
          .filter((o) => o !== t && merchantKey(o) === key)
          .slice(0, 3)
          .map((o) => ({ date: o.date, description: o.description, amount: round(o.amount) }))
    return {
      date: t.date,
      description: t.description,
      amount: round(t.amount),
      category: info.name,
      emoji: info.emoji,
      institution: t.institution,
      similar,
    }
  })

  const subscriptions = detectSubscriptions(transactions, today)

  const biggest = categories[0]
  const insight =
    changePct === null
      ? 'Conectei suas contas. Assim que houver um mês de histórico, comparo seus gastos aqui.'
      : changePct <= 0
        ? `Que demais! Você está gastando ${Math.abs(Math.round(changePct))}% menos que no mês passado. Parabéns!`
        : `Atenção: você já gastou ${Math.round(changePct)}% a mais que no mesmo ponto do mês passado.`

  return {
    today,
    monthLabel: now.toLocaleDateString('pt-BR', { month: 'long' }),
    insight: {
      message: insight,
      spent: Math.round(currentTotal),
      changePct: changePct === null ? null : Math.round(changePct),
      biggest: biggest ? { name: biggest.name, emoji: biggest.emoji } : null,
    },
    rhythm: { data: rhythm, daysInMonth, currentDay: dayOfMonth, current: currentTotal, previousSameDay, previousTotal, difference: round(previousSameDay - currentTotal), changePct },
    heatmap: { days: heatmap, total: currentTotal, dailyAverage: round(currentTotal / Math.max(1, heatmap.filter((d) => d.amount > 0).length)), highest, firstWeekday: heatmap[0]?.weekday ?? 0 },
    categories,
    accounts: {
      total: round(bankAccounts.reduce((s, a) => s + Number(a.balance ?? 0), 0)),
      items: bankAccounts.map((a) => ({ institution: a.institution, name: a.type === 'SAVINGS' ? 'Poupança' : 'Conta corrente', balance: round(Number(a.balance ?? 0)) })),
    },
    cards: { available: round(totalAvailable), limit: round(totalLimit), items: cards },
    recent,
    subscriptions: { monthlyTotal: round(subscriptions.reduce((s, x) => s + x.amount, 0)), items: subscriptions.slice(0, 5) },
    banks: connections.map((c) => ({ id: c.id, institution: c.institution })),
  }
}

const PERIODS = {
  month: () => {
    const now = new Date()
    return { from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, to: localDate(now) }
  },
  previous: () => {
    const now = new Date()
    const p = shiftMonth(now.getFullYear(), now.getMonth() + 1, -1)
    return { from: `${p.year}-${pad(p.month)}-01`, to: `${p.year}-${pad(p.month)}-${pad(new Date(p.year, p.month, 0).getDate())}` }
  },
  '30d': () => ({ from: localDate(new Date(Date.now() - 30 * 86_400_000)), to: localDate(new Date()) }),
  '90d': () => ({ from: localDate(new Date(Date.now() - 90 * 86_400_000)), to: localDate(new Date()) }),
}

const SORTS = {
  'date-desc': (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0),
  'date-asc': (a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0),
  'amount-desc': (a, b) => Math.abs(b.amount) - Math.abs(a.amount),
  'amount-asc': (a, b) => Math.abs(a.amount) - Math.abs(b.amount),
}

// Lista filtrada para a aba Transações (período, conta, tipo, categoria, busca, ordem e página)
export function buildTransactions({ accounts, transactions }, params) {
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  const custom = params.period === 'custom' && ISO.test(params.dateFrom ?? '') && ISO.test(params.dateTo ?? '') && params.dateFrom <= params.dateTo
  const period = custom ? 'custom' : PERIODS[params.period] ? params.period : 'month'
  const { from, to } = custom ? { from: params.dateFrom, to: params.dateTo } : PERIODS[period]()
  const institutions = [...new Set(accounts.map((a) => a.institution))]
  const search = String(params.q ?? '').trim().toLowerCase()
  const type = ['expense', 'income'].includes(params.type) ? params.type : 'all'
  const perPage = [10, 25, 50].includes(Number(params.perPage)) ? Number(params.perPage) : 10

  const enriched = transactions.map((t) => ({ ...t, info: categoryInfo(t) }))
  const categories = [...new Set(enriched.map((t) => t.info.name))].sort((a, b) => a.localeCompare(b, 'pt-BR'))

  const list = enriched
    .filter((t) => t.date >= from && t.date <= to)
    .filter((t) => !params.account || t.institution === params.account)
    .filter((t) => !params.category || t.info.name === params.category)
    .filter((t) => type === 'all' || (type === 'income' ? t.amount > 0 : t.amount < 0))
    .filter((t) => !search || t.description.toLowerCase().includes(search) || t.info.name.toLowerCase().includes(search))
    .sort(SORTS[params.sort] ?? SORTS['date-desc'])

  const expenses = list.filter(isSpending).reduce((s, t) => s + Math.abs(t.amount), 0)
  const income = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const page = Math.min(Math.max(1, Number(params.page) || 1), Math.max(1, Math.ceil(list.length / perPage)))

  return {
    period, from, to, perPage, page,
    total: list.length,
    totals: { expenses: round(expenses), income: round(income), balance: round(income - expenses) },
    filters: { accounts: institutions, categories },
    items: list.slice((page - 1) * perPage, page * perPage).map((t) => ({
      date: t.date,
      description: t.description,
      amount: round(t.amount),
      category: t.info.name,
      emoji: t.info.emoji,
      institution: t.institution,
    })),
  }
}

// Compras parceladas: junta as parcelas da mesma compra e calcula pago/restante
export function buildInstallments({ transactions }, params) {
  const groups = new Map()
  for (const t of transactions) {
    if (!t.installment || t.amount >= 0) continue
    const name = t.description.replace(/\s*(?:parcela\s*)?\d{1,2}\s*(?:\/|de)\s*\d{1,2}\s*$/i, '').replace(/^.*\|/, '').trim() || t.description
    const key = `${t.institution}|${name.toLowerCase()}|${t.installment.total}`
    const group = groups.get(key) ?? { name, institution: t.institution, total: t.installment.total, amount: 0, number: 0, lastDate: '', category: categoryInfo(t) }
    if (t.installment.number >= group.number) {
      group.number = t.installment.number
      group.amount = Math.abs(t.amount)
      group.lastDate = t.date
    }
    groups.set(key, group)
  }

  const all = [...groups.values()].map((g) => ({
    name: g.name,
    institution: g.institution,
    category: g.category.name,
    emoji: g.category.emoji,
    amount: round(g.amount),
    number: g.number,
    total: g.total,
    totalAmount: round(g.amount * g.total),
    paid: round(g.amount * g.number),
    remaining: round(g.amount * (g.total - g.number)),
    lastDate: g.lastDate,
    finished: g.number >= g.total,
  }))

  const active = all.filter((i) => !i.finished)
  const finished = all.filter((i) => i.finished)
  const status = params.status === 'finished' ? 'finished' : 'active'
  const sorters = {
    remaining: (a, b) => b.remaining - a.remaining,
    amount: (a, b) => b.amount - a.amount,
    progress: (a, b) => b.number / b.total - a.number / a.total,
    date: (a, b) => (a.lastDate < b.lastDate ? 1 : -1),
  }
  const items = (status === 'finished' ? finished : active).sort(sorters[params.sort] ?? sorters.remaining)

  const sum = (key) => round(active.reduce((s, i) => s + i[key], 0))
  const totalAmount = sum('totalAmount')
  const paid = sum('paid')
  return {
    status,
    counts: { active: active.length, finished: finished.length },
    summary: { count: active.length, total: totalAmount, paid, remaining: sum('remaining'), progress: totalAmount ? Math.round((paid / totalAmount) * 100) : 0 },
    items,
  }
}

// Aba Assinaturas: cobranças recorrentes, com filtro por conta
export function buildSubscriptions({ accounts, transactions }, params) {
  const today = localDate(new Date())
  const all = detectSubscriptions(transactions, today)
  const items = all.filter((s) => !params.account || s.institution === params.account)
  const monthly = round(items.reduce((s, x) => s + x.amount, 0))
  return {
    filters: { accounts: [...new Set(accounts.map((a) => a.institution))] },
    summary: {
      count: items.length,
      monthly,
      yearly: round(monthly * 12),
      average: items.length ? round(monthly / items.length) : 0,
    },
    items,
  }
}
