// Widgets das respostas do chat: blocos visuais (listas, gráficos, cartões) montados no servidor
// com os dados da Pluggy. A IA só escolhe qual mostrar; os números nunca saem dela.
import { categoryInfo, buildSubscriptions, buildInstallments } from './vision.js'
import { buildCards } from './visionCategories.js'

const round = (n) => Math.round(n * 100) / 100
const localDate = (date) => date.toLocaleDateString('sv-SE')
const isBillPayment = (t) => /credit card payment/i.test(t.category ?? '')
const isSpending = (t) => t.amount < 0 && !isBillPayment(t)
const isCard = (t) => t.accountType === 'CREDIT'
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const PALETTE = ['#fb923c', '#ec4899', '#22c55e', '#f59e0b', '#3b82f6', '#8b5cf6', '#06b6d4', '#71717a']

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
function range(args) {
  if (ISO.test(args.from ?? '') && ISO.test(args.to ?? '') && args.from <= args.to) {
    return { days: Math.round((new Date(args.to) - new Date(args.from)) / 86_400_000) + 1, from: args.from, to: args.to }
  }
  const days = clamp(args.days, 1, 90, 30)
  const to = localDate(new Date())
  const from = localDate(new Date(Date.now() - (days - 1) * 86_400_000))
  return { days, from, to }
}

const inRange = (list, { from, to }) => list.filter((t) => t.date >= from && t.date <= to)
const sum = (list, pick) => round(list.reduce((s, t) => s + pick(t), 0))

function noData() {
  return { widget: null, summary: { error: 'Sem dados conectados para este pedido.' } }
}

// ---------- construtores ----------

function transactionsWidget(fin, args) {
  const r = range(args)
  const type = ['income', 'expense'].includes(args.type) ? args.type : 'all'
  const search = String(args.search ?? '').trim().toLowerCase()
  const category = String(args.category ?? '').trim().toLowerCase()
  const limit = clamp(args.limit, 1, 15, 10)

  const list = inRange(fin.transactions, r)
    .map((t) => ({ ...t, info: categoryInfo(t) }))
    .filter((t) => type === 'all' || (type === 'income' ? t.amount > 0 : t.amount < 0))
    .filter((t) => !search || t.description.toLowerCase().includes(search) || t.info.name.toLowerCase().includes(search))
    .filter((t) => !category || t.info.name.toLowerCase().includes(category))
    .sort((a, b) => (args.sort === 'amount' ? Math.abs(b.amount) - Math.abs(a.amount) : a.date < b.date ? 1 : -1))

  const items = list.slice(0, limit).map((t) => ({
    description: t.description,
    category: t.info.name,
    emoji: t.info.emoji,
    institution: t.institution,
    origin: isCard(t) ? 'card' : 'account',
    amount: round(t.amount),
    date: t.date,
  }))
  const widget = { type: 'transactions', title: 'Suas transações', ...r, total: list.length, items, institutions: [...new Set(fin.accounts.map((a) => a.institution))] }
  return {
    widget,
    summary: {
      periodo: `${r.from} a ${r.to}`,
      encontradas: list.length,
      entradas: sum(list.filter((t) => t.amount > 0), (t) => t.amount),
      saidas: sum(list.filter(isSpending), (t) => Math.abs(t.amount)),
      mostradas: items.map((i) => `${i.date} ${i.description} ${i.amount}`),
    },
  }
}

function spendingWidget(fin, args) {
  const r = range(args)
  // "search": termos separados por vírgula (ex.: "ifood, mercado"); acha na descrição ou na categoria
  const terms = String(args.search ?? '').toLowerCase().split(/[,;]| e /).map((x) => x.trim()).filter(Boolean)
  const list = inRange(fin.transactions, r)
    .filter(isSpending)
    .filter((t) => {
      if (terms.length === 0) return true
      const hay = `${t.description} ${t.category ?? ''} ${categoryInfo(t).name}`.toLowerCase()
      return terms.some((term) => hay.includes(term))
    })
  const total = sum(list, (t) => Math.abs(t.amount))
  const groups = new Map()
  for (const t of list) {
    const info = categoryInfo(t)
    const g = groups.get(info.name) ?? { name: info.name, emoji: info.emoji, total: 0, items: [] }
    g.total += Math.abs(t.amount)
    g.items.push({ description: t.description, amount: round(Math.abs(t.amount)), date: t.date })
    groups.set(info.name, g)
  }
  const sorted = [...groups.values()].sort((a, b) => b.total - a.total)
  const categories = sorted.map((g, i) => ({
    name: g.name,
    emoji: g.emoji,
    color: PALETTE[i % PALETTE.length],
    total: round(g.total),
    share: total ? g.total / total : 0,
    items: g.items.sort((a, b) => b.amount - a.amount).slice(0, 5),
  }))
  const widget = {
    type: 'spending',
    title: 'Seus gastos',
    ...r,
    total,
    categories,
    origin: {
      card: sum(list.filter(isCard), (t) => Math.abs(t.amount)),
      account: sum(list.filter((t) => !isCard(t)), (t) => Math.abs(t.amount)),
    },
    institutions: [...new Set(fin.accounts.map((a) => a.institution))],
  }
  return { widget, summary: { periodo: `${r.from} a ${r.to}`, total, categorias: categories.slice(0, 6).map((c) => `${c.name}: ${c.total}`), origem: widget.origin } }
}

function incomeExpensesWidget(fin, args) {
  const monthsBack = clamp(args.months, 1, 4, 1)
  const now = new Date()
  const months = []
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    // só contas correntes: a compra no cartão não é saída da conta; o pagamento da fatura é
    const own = fin.transactions.filter((t) => !isCard(t) && t.date.slice(0, 7) === key)
    months.push({
      key,
      label: MONTHS[d.getMonth()],
      income: sum(own.filter((t) => t.amount > 0), (t) => t.amount),
      expenses: sum(own.filter((t) => t.amount < 0), (t) => Math.abs(t.amount)),
    })
  }
  const income = round(months.reduce((s, m) => s + m.income, 0))
  const expenses = round(months.reduce((s, m) => s + m.expenses, 0))
  const first = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1)
  const widget = {
    type: 'incomeExpenses',
    title: 'Entradas vs Saídas',
    from: localDate(first),
    to: localDate(now),
    income,
    expenses,
    balance: round(income - expenses),
    percent: income ? Math.round(Math.abs((income - expenses) / income) * 10000) / 100 : 0,
    saved: income >= expenses,
    months,
    institutions: [...new Set(fin.accounts.filter((a) => a.type !== 'CREDIT').map((a) => a.institution))],
  }
  return { widget, summary: { entradas: income, saidas: expenses, saldo_do_periodo: widget.balance, meses: months.map((m) => `${m.label}: entrou ${m.income}, saiu ${m.expenses}`) } }
}

function cardsWidget(fin) {
  const cards = buildCards(fin, {})
  if (cards.cards.length === 0) return { widget: null, summary: { error: 'Nenhum cartão de crédito conectado.' } }
  const limit = round(cards.cards.reduce((s, c) => s + (c.limit ?? 0), 0))
  const available = round(cards.cards.reduce((s, c) => s + (c.available ?? 0), 0))
  const used = round(Math.max(0, limit - available))

  const month = cards.month
  const charges = fin.transactions.filter((t) => isCard(t) && isSpending(t) && t.date.slice(0, 7) === month)
  const groups = new Map()
  for (const t of charges) {
    const info = categoryInfo(t)
    const g = groups.get(info.name) ?? { name: info.name, emoji: info.emoji, total: 0 }
    g.total += Math.abs(t.amount)
    groups.set(info.name, g)
  }
  const categories = [...groups.values()]
    .sort((a, b) => b.total - a.total)
    .map((g, i) => ({ ...g, total: round(g.total), color: PALETTE[i % PALETTE.length] }))

  const widget = {
    type: 'cards',
    title: 'Cartões de crédito',
    total: cards.total,
    limit,
    available,
    used,
    usedShare: limit ? used / limit : 0,
    lastTransaction: cards.lastTransaction,
    cards: cards.cards,
    categories,
    transactionCount: charges.length,
  }
  return {
    widget,
    summary: {
      fatura_estimada: cards.total,
      limite_total: limit,
      usado: used,
      disponivel: available,
      vencimentos: cards.cards.map((c) => `${c.name}: ${c.dueDate ?? 'sem data'}`),
    },
  }
}

function subscriptionsWidget(fin) {
  const subs = buildSubscriptions(fin, {})
  const widget = {
    type: 'subscriptions',
    title: 'Minhas Assinaturas',
    count: subs.summary.count,
    monthly: subs.summary.monthly,
    yearly: subs.summary.yearly,
    items: subs.items.slice(0, 12).map((s) => ({ name: s.name, amount: s.amount, domain: s.domain, nextPayment: s.nextPayment })),
  }
  return { widget, summary: { assinaturas: widget.items.map((i) => `${i.name}: ${i.amount}`), por_mes: subs.summary.monthly, por_ano: subs.summary.yearly } }
}

// Simulação informativa: o saldo parado versus o mesmo valor num CDB a 111% do CDI (CDI de referência fixo, juros compostos ao ano)
const CDI = 13.65
const CDB_PERCENT = 111
function projectionFor(balance) {
  if (balance <= 0) return null
  const rate = (CDI * CDB_PERCENT) / 10000
  const points = Array.from({ length: 6 }, (_, year) => ({ year, value: round(balance * (1 + rate) ** year) }))
  const final = points[5].value
  return { name: 'CDB mIAu Anota Grana', percent: CDB_PERCENT, cdi: CDI, position: 0, years: 5, base: round(balance), final, gain: round(final - balance), points }
}

function accountsWidget(fin) {
  const own = fin.accounts.filter((a) => a.type !== 'CREDIT') // dívida do cartão não é saldo da conta
  if (own.length === 0) return noData()
  const items = own.map((a) => ({
    institution: a.institution,
    name: a.name,
    type: a.type === 'CREDIT' ? 'Cartão de crédito' : a.type === 'SAVINGS' ? 'Poupança' : 'Conta corrente',
    balance: round(Number(a.balance ?? 0)),
  }))
  const total = round(items.reduce((s, i) => s + i.balance, 0))
  const widget = { type: 'accounts', title: 'Suas contas', total, connections: fin.connections.length, items, projection: projectionFor(total) }
  return { widget, summary: { saldo_total: total, contas: items.map((i) => `${i.institution} ${i.name}: ${i.balance}`) } }
}

// Categorias que não são "cortáveis": transferências, fatura, renda, saúde e educação
const NOT_CUTTABLE = /fatura|pagamento|transfer|renda|sal[aá]rio|sa[uú]de|farm[aá]cia|educa|empr[eé]stimo/i
// tipo do gasto -> ícone, cor, fração que dá para economizar e dica
const SAVINGS_KINDS = [
  { test: /água|energia|eletricidade|luz|contas da casa|moradia/i, icon: 'trending', color: '#F59E0B', rate: 0.3, tip: 'Confira se a conta veio alta por consumo real ou por erro de leitura, e defina um limite mensal para manter o controle.' },
  { test: /telecom|internet|assinatura|streaming/i, icon: 'card', color: '#3B82F6', rate: 0.5, tip: 'Compare planos e cancele o que você quase não usa. Dá para economizar sem mexer na rotina.' },
  { test: /restaurante|aliment|supermercado/i, icon: 'bag', color: '#FB923C', rate: 0.25, tip: 'Planejar as refeições da semana e reduzir pedidos por aplicativo costuma cortar esse gasto sem sacrifício.' },
  { test: /compras|lazer|viage/i, icon: 'bag', color: '#EC4899', rate: 0.35, tip: 'Espere 48 horas antes de compras por impulso e priorize o que realmente faz falta.' },
  { test: /táxi|transporte|combust/i, icon: 'swap', color: '#8B5CF6', rate: 0.3, tip: 'Trocar corridas curtas por outra opção e juntar deslocamentos reduz o custo do mês.' },
]
const DEFAULT_KIND = { icon: 'swap', color: '#8B5CF6', rate: 0.3, tip: 'Considere reduzir a frequência ou buscar alternativas mais em conta para este gasto recorrente.' }

function savingsWidget(fin) {
  const today = localDate(new Date())
  const since = localDate(new Date(Date.now() - 29 * 86_400_000))
  const before = localDate(new Date(Date.now() - 59 * 86_400_000))
  const spending = fin.transactions.filter(isSpending)
  const byName = (list) => {
    const m = new Map()
    for (const t of list) {
      const info = categoryInfo(t)
      m.set(info.name, (m.get(info.name) ?? 0) + Math.abs(t.amount))
    }
    return m
  }
  const current = byName(spending.filter((t) => t.date >= since && t.date <= today))
  const previous = byName(spending.filter((t) => t.date >= before && t.date < since))

  const items = [...current.entries()]
    .filter(([name]) => !NOT_CUTTABLE.test(name))
    .map(([name, total]) => {
      const kind = SAVINGS_KINDS.find((k) => k.test.test(name)) ?? DEFAULT_KIND
      const grew = (previous.get(name) ?? 0) > 0 && total > previous.get(name) * 1.1
      return {
        name,
        icon: kind.icon,
        color: kind.color,
        upTo: round(total * kind.rate),
        tip: grew ? 'Seus gastos nesta categoria aumentaram recentemente. Tente definir um limite mensal para manter o controle.' : kind.tip,
      }
    })
    .filter((i) => i.upTo >= 5)
    .sort((a, b) => b.upTo - a.upTo)
    .slice(0, 4)

  const total = round(items.reduce((sum, i) => sum + i.upTo, 0))
  items.forEach((i) => (i.share = total ? i.upTo / total : 0))
  const widget = { type: 'savings', title: 'Oportunidades de economia', total, items }
  return { widget, summary: { economia_estimada_mes: total, oportunidades: items.map((i) => `${i.name}: até ${i.upTo}/mês`) } }
}

const monthLabel = (key) => `${MONTHS[Number(key.slice(5)) - 1]}/${key.slice(0, 4)}`
const isMonth = (k) => /^\d{4}-(0[1-9]|1[0-2])$/.test(k ?? '')

// Gastos de um mês contra outro (padrão: mês passado x este mês), mais a quebra por categoria de cada um
function compareWidget(fin, args) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const current = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const previous = `${prevDate.getFullYear()}-${pad(prevDate.getMonth() + 1)}`
  const a = isMonth(args.month_a) ? args.month_a : previous
  const b = isMonth(args.month_b) ? args.month_b : current

  const totalOf = (key) => sum(fin.transactions.filter((t) => isSpending(t) && t.date.slice(0, 7) === key), (t) => Math.abs(t.amount))
  const rangeOf = (key) => {
    const [y, m] = key.split('-').map(Number)
    return { from: `${key}-01`, to: localDate(new Date(y, m, 0)) } // o mês inteiro, como no original
  }
  const ta = totalOf(a)
  const tb = totalOf(b)
  const diff = round(tb - ta)
  const comparison = {
    type: 'comparison',
    title: 'Comparação',
    a: { label: monthLabel(a), total: ta },
    b: { label: monthLabel(b), total: tb, partial: b === current },
    diff,
    percent: ta ? Math.round((diff / ta) * 100) : 0,
    institutions: [...new Set(fin.accounts.map((x) => x.institution))],
  }
  const breakdowns = [a, b].map((key) => {
    const w = spendingWidget(fin, rangeOf(key)).widget
    w.label = monthLabel(key)
    return w
  })
  return {
    widgets: [comparison, ...breakdowns],
    summary: {
      [`gastos_${a}`]: ta,
      [`gastos_${b}`]: tb,
      diferenca: diff,
      variacao_percentual: comparison.percent,
      mes_atual_incompleto: b === current,
      maiores_categorias: breakdowns.map((w) => `${w.label}: ${w.categories.slice(0, 3).map((c) => `${c.name} ${c.total}`).join('; ')}`),
    },
  }
}

function weekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return localDate(d)
}

function trendWidget(fin, args) {
  const weeks = clamp(args.weeks, 2, 13, 8)
  const from = weekStart(localDate(new Date(Date.now() - (weeks - 1) * 7 * 86_400_000)))
  const buckets = new Map()
  for (let i = 0; i < weeks; i++) buckets.set(localDate(new Date(new Date(`${from}T12:00:00`).getTime() + i * 7 * 86_400_000)), 0)
  for (const t of fin.transactions.filter(isSpending)) {
    const key = weekStart(t.date)
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + Math.abs(t.amount))
  }
  const points = [...buckets.entries()].map(([date, total]) => {
    const d = new Date(`${date}T12:00:00`)
    return { date, label: `${d.getDate()} de ${MONTHS[d.getMonth()]}`, total: round(total) }
  })
  const total = round(points.reduce((s, p) => s + p.total, 0))
  const widget = { type: 'trend', title: 'Tendência de gastos', from, to: localDate(new Date()), total, average: round(total / points.length), points }
  return { widget, summary: { total, media_semanal: widget.average, semanas: points.map((p) => `${p.label}: ${p.total}`) } }
}

function installmentsWidget(fin) {
  const inst = buildInstallments(fin, { status: 'active' })
  const widget = {
    type: 'installments',
    title: 'Parcelas',
    summary: inst.summary,
    items: inst.items.slice(0, 8).map((i) => ({ name: i.name, amount: i.amount, number: i.number, total: i.total, remaining: i.remaining })),
  }
  return { widget, summary: { parcelamentos_ativos: inst.summary.count, falta_pagar: inst.summary.remaining } }
}

// ---------- ferramentas oferecidas à IA ----------

const daysParam = { type: 'integer', description: 'Quantos dias para trás (1 a 90). Padrão 30.' }

export const TOOLS = [
  {
    name: 'show_transactions',
    description: 'Mostra uma lista de transações (Pix, compras, entradas...). Use para "me mostre", "quais foram", filtrando por texto, tipo ou categoria.',
    parameters: {
      type: 'object',
      properties: {
        days: daysParam,
        from: { type: 'string', description: 'Data inicial YYYY-MM-DD. Para um dia específico (ex.: "dia 18/10") use from e to iguais, com o ano atual. Se usar from/to, ignora days.' },
        to: { type: 'string', description: 'Data final YYYY-MM-DD.' },
        type: { type: 'string', enum: ['all', 'income', 'expense'], description: 'income = entradas, expense = saídas' },
        search: { type: 'string', description: 'Texto na descrição ou categoria (ex.: pix, uber, ifood)' },
        category: { type: 'string', description: 'Nome da categoria em português' },
        sort: { type: 'string', enum: ['date', 'amount'], description: 'amount = maiores valores primeiro' },
        limit: { type: 'integer', description: 'Quantidade (1 a 15). Padrão 10.' },
      },
    },
    build: transactionsWidget,
  },
  {
    name: 'show_spending',
    description: 'Mostra os gastos por categoria no período, com a origem (cartão ou conta). Use para "onde gastei", quanto gastei com X, maiores gastos, detalhamento. Com "search" filtra por estabelecimento ou categoria.',
    parameters: {
      type: 'object',
      properties: {
        days: daysParam,
        from: { type: 'string', description: 'Data inicial YYYY-MM-DD. Para um dia específico (ex.: "dia 18/10") use from e to iguais, com o ano atual. Se usar from/to, ignora days.' },
        to: { type: 'string', description: 'Data final YYYY-MM-DD.' },
        search: { type: 'string', description: 'Termos separados por vírgula, em minúsculas (ex.: "ifood, mercado, uber"). Omita para ver tudo.' },
      },
    },
    build: spendingWidget,
  },
  {
    name: 'show_income_expenses',
    description: 'Mostra entradas versus saídas da conta, mês a mês. Use para quanto entrou/saiu e quanto sobrou. Para comparar GASTOS entre meses use show_compare.',
    parameters: { type: 'object', properties: { months: { type: 'integer', description: 'Quantos meses (1 a 4), contando o atual. Padrão 1; use 4 para saúde financeira, evolução ou comparação entre meses.' } } },
    build: incomeExpensesWidget,
  },
  {
    name: 'show_cards',
    description: 'Mostra a fatura estimada, o limite usado e o vencimento dos cartões de crédito.',
    parameters: { type: 'object', properties: {} },
    build: cardsWidget,
  },
  {
    name: 'show_subscriptions',
    description: 'Mostra as assinaturas (cobranças recorrentes) com valor e próxima cobrança.',
    parameters: { type: 'object', properties: {} },
    build: subscriptionsWidget,
  },
  {
    name: 'show_accounts',
    description: 'Mostra os saldos das contas conectadas e o saldo total, com uma simulação de rendimento. Use para saldo e, junto com show_trend, para evolução do saldo.',
    parameters: { type: 'object', properties: {} },
    build: accountsWidget,
  },
  {
    name: 'show_trend',
    description: 'Mostra a evolução dos gastos semana a semana. Use para tendência, ritmo de gastos, evolução.',
    parameters: { type: 'object', properties: { weeks: { type: 'integer', description: 'Quantas semanas (2 a 13). Padrão 8.' } } },
    build: trendWidget,
  },
  {
    name: 'show_compare',
    description: 'Compara os GASTOS de dois meses (total, diferença e categorias de cada um). Use para "compara setembro com outubro", "gastei mais ou menos que mês passado". Meses no formato YYYY-MM.',
    parameters: {
      type: 'object',
      properties: {
        month_a: { type: 'string', description: 'Mês mais antigo, ex.: 2026-09. Padrão: mês passado.' },
        month_b: { type: 'string', description: 'Mês mais novo, ex.: 2026-10. Padrão: este mês.' },
      },
    },
    build: compareWidget,
  },
  {
    name: 'show_savings',
    description: 'Mostra oportunidades de economia por categoria, com quanto dá para economizar por mês. Use para "onde posso economizar", cortar gastos.',
    parameters: { type: 'object', properties: {} },
    build: savingsWidget,
  },
  {
    name: 'show_installments',
    description: 'Mostra as compras parceladas em andamento e quanto falta pagar.',
    parameters: { type: 'object', properties: {} },
    build: installmentsWidget,
  },
]

export const openAiTools = TOOLS.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }))

export function runTool(name, args, fin) {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool || fin.accounts.length === 0) return { widgets: [], summary: noData().summary }
  const result = tool.build(fin, args ?? {})
  const widgets = result.widgets ?? (result.widget ? [result.widget] : [])
  const syncedAt = new Date().toISOString()
  widgets.forEach((w) => (w.syncedAt = syncedAt))
  return { widgets, summary: result.summary }
}

// Chips de "o que perguntar em seguida", conforme o que a resposta mostrou
const FOLLOWUPS = {
  transactions: ['Quais foram meus maiores gastos?', 'Quanto entrou na minha conta este mês?'],
  spending: ['Compara este mês com o anterior', 'Onde posso economizar?'],
  incomeExpenses: ['Detalhar meus gastos', 'Como está meu saldo?'],
  cards: ['Detalhar gastos do cartão', 'Quais assinaturas eu tenho?'],
  subscriptions: ['Onde posso economizar?', 'Quanto já usei do limite do cartão?'],
  accounts: ['Como estão meus gastos por semana?', 'Quanto entrou na minha conta este mês?'],
  trend: ['Detalhar meus gastos', 'Onde posso economizar?'],
  installments: ['Quais assinaturas eu tenho?', 'Como está meu saldo?'],
  comparison: ['Onde posso economizar?', 'Como está minha saúde financeira?'],
  savings: ['Quais assinaturas eu tenho?', 'Quero juntar R$ 2.000 em 3 meses'],
}

export function followupsFor(widgets) {
  const out = []
  for (const w of widgets) for (const q of FOLLOWUPS[w.type] ?? []) if (!out.includes(q)) out.push(q)
  return out.slice(0, 3)
}
