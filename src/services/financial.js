import { query } from '../db.js'
import * as pluggy from './openFinance.js'
import { bankFrom } from './banks.js'

const CACHE_MS = 2 * 60 * 1000
const PERIOD_DAYS = 90
const cache = new Map()
const lastGood = new Map() // último resultado bom: usado se a Pluggy sair do ar

// Parcela X de Y: vem dos metadados do cartão ou do fim da descrição ("Loja 2/10", "Loja parcela 2 de 10")
function installmentOf(t) {
  const meta = t.creditCardMetadata
  if (meta?.installmentNumber && meta?.totalInstallments > 1) {
    return { number: Number(meta.installmentNumber), total: Number(meta.totalInstallments) }
  }
  // só com a palavra "parcela": "Loja 05/12" poderia ser uma data
  const m = String(t.description ?? '').match(/parcela\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\s*$/i)
  if (m && Number(m[2]) > 1 && Number(m[1]) <= Number(m[2])) return { number: Number(m[1]), total: Number(m[2]) }
  return null
}

// Estorno e reembolso desfazem uma cobrança anterior do mesmo valor (e da mesma conta) em até 24h:
// as duas linhas saem, senão a cobrança vira gasto e o estorno vira entrada
const REFUND = /^(estorno|reembolso)/i
const REFUND_WINDOW_MS = 24 * 3_600_000

export function cancelRefunds(list) {
  const drop = new Set()
  const byTime = list.map((t, i) => ({ t, i })).sort((a, b) => Date.parse(a.t.at) - Date.parse(b.t.at))
  for (const { t: refund, i: ri } of byTime) {
    if (refund.amount <= 0 || !REFUND.test(refund.description)) continue
    const match = [...byTime].reverse().find(({ t, i }) =>
      !drop.has(i) && t.amount < 0 && t.accountId === refund.accountId &&
      Math.abs(Math.abs(t.amount) - refund.amount) < 0.005 &&
      Date.parse(t.at) <= Date.parse(refund.at) && Date.parse(refund.at) - Date.parse(t.at) <= REFUND_WINDOW_MS)
    if (match) { drop.add(ri); drop.add(match.i) }
  }
  return list.filter((_, i) => !drop.has(i))
}

// Parcela N de uma compra no cartão: a Pluggy a data pelo fechamento da fatura. O que vale é a data da compra
// mais (N - 1) meses (compra de 07/08, parcela 2 -> 07/09), como o Pierre original mostra
function installmentDate(t) {
  const meta = t.creditCardMetadata
  if (!meta?.purchaseDate || !meta?.installmentNumber) return null
  const d = new Date(meta.purchaseDate)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCMonth(d.getUTCMonth() + Number(meta.installmentNumber) - 1)
  return d.toISOString()
}

// A Pluggy manda os horários em UTC; o dia que vale é o de Brasília (pagar às 21h36 do dia 6 não é dia 7)
const brDate = (iso) => {
  const raw = String(iso ?? '')
  if (raw.length <= 10) return raw // data sem horário: já é o dia certo
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? raw.slice(0, 10) : d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
}

// Padaria, lanchonete, bar e restaurante: o código do estabelecimento (MCC) do cartão vale mais que a categoria da Pluggy
// (a mesma lanchonete chega como "Groceries" no cartão e "Eating out" no Pix)
const EATING_MCC = new Set([5462, 5811, 5812, 5813, 5814])

const BILL_PAYMENT = /pagamento (de )?fatura|pagamento recebido/i
const brl = (n) => `R$ ${Number(n).toFixed(2).replace('.', ',')}`
const isoDate = (date) => date.toISOString().slice(0, 10)

// Contas e transações dos últimos 90 dias de todas as conexões prontas do usuário.
// Fica em cache por 2 minutos: cada mensagem do chat não deve repetir as chamadas à Pluggy.
export async function loadFinancials(userId) {
  const hit = cache.get(userId)
  if (hit && Date.now() < hit.expiresAt) return hit.data
  try {
    return await fetchFinancials(userId)
  } catch (err) {
    // Pluggy fora do ar ou lenta: mostra os últimos dados bons em vez de uma tela de erro
    const stale = lastGood.get(userId)
    if (!stale) throw err
    console.error('[financeiro] Pluggy falhou, usando dados de', stale.loadedAt, '-', err.message)
    cache.set(userId, { data: stale, expiresAt: Date.now() + 30_000 })
    return stale
  }
}

async function fetchFinancials(userId) {

  const connections = await query(
    "SELECT id, institution, provider_item_id FROM connected_accounts WHERE user_id = ? AND status = 'connected'",
    [userId],
  )
  const from = isoDate(new Date(Date.now() - PERIOD_DAYS * 86_400_000))
  const accounts = []
  const transactions = []
  let syncedAt = null // quando a Pluggy buscou os dados no banco pela última vez

  for (const connection of connections) {
    const found = await pluggy.getAccounts(connection.provider_item_id)
    const item = await pluggy.getItem(connection.provider_item_id).catch(() => null)
    if (item?.lastUpdatedAt && (!syncedAt || item.lastUpdatedAt > syncedAt)) syncedAt = item.lastUpdatedAt
    // o banco vem da conta corrente (o cartão não diz de qual banco é); sem pista, fica o nome da conexão
    const reference = found.find((a) => a.type !== 'CREDIT') ?? found[0]
    const institution =
      bankFrom(`${reference?.name ?? ''} ${reference?.marketingName ?? ''}`) ?? bankFrom(connection.institution) ?? connection.institution

    for (const account of found) {
      accounts.push({
        institution,
        id: account.id,
        type: account.type,
        name: account.name ?? account.marketingName ?? 'Conta',
        balance: account.type === 'CREDIT' ? -Math.abs(Number(account.balance ?? 0)) : account.balance, // cada banco informa a fatura com um sinal: no cartão o saldo é sempre dívida
        last4: String(account.number ?? '').slice(-4) || null,
        bills: account.type === 'CREDIT'
          ? (await pluggy.getBills(account.id).catch(() => [])).map((b) => ({ dueDate: String(b.dueDate).slice(0, 10), total: Math.round(Number(b.totalAmount ?? 0) * 100) / 100 }))
          : [],
        credit: account.creditData
          ? {
              limit: account.creditData.creditLimit ?? null,
              available: account.creditData.availableCreditLimit ?? null,
              dueDate: account.creditData.balanceDueDate ?? null,
            }
          : null,
      })
      const list = await pluggy.getTransactions(account.id, { dateFrom: from, maxPages: 2 })
      for (const t of list) {
        // o sinal do valor muda de banco para banco (no cartão, compra vem positiva): o tipo manda
        const raw = Number(t.amount ?? 0)
        const amount = t.type === 'DEBIT' ? -Math.abs(raw) : t.type === 'CREDIT' ? Math.abs(raw) : raw
        const billPayment = BILL_PAYMENT.test(t.description ?? '')
        // o lado do cartão do pagamento da fatura não é gasto nem entrada: só confunde as contas
        if (billPayment && account.type === 'CREDIT') continue
        transactions.push({
          institution,
          accountId: account.id,
          accountType: account.type,
          date: brDate(installmentDate(t) ?? t.date),
          at: installmentDate(t) ?? String(t.date ?? ''),
          description: t.description ?? '',
          amount,
          type: t.type,
          // pagamento de fatura sai da conta como "Transferência", mas as compras já estão no cartão
          category: billPayment ? 'Credit card payment' : EATING_MCC.has(Number(t.creditCardMetadata?.payeeMCC)) ? 'Eating out' : t.category ?? null,
          categoryPt: t.categoryTranslated ?? null,
          installment: installmentOf(t),
          billMonth: t.creditCardMetadata?.billForecastDate ?? null, // mês da fatura em que a compra vai cair
        })
      }
    }
  }
  const collapsed = cancelRefunds(transactions)
  transactions.length = 0
  transactions.push(...collapsed)
  transactions.sort((a, b) => (a.date < b.date ? 1 : -1))

  const data = { connections, accounts, transactions, syncedAt, loadedAt: new Date().toISOString() }
  cache.set(userId, { data, expiresAt: Date.now() + CACHE_MS })
  lastGood.set(userId, data)
  return data
}

export function clearFinancialsCache(userId) {
  cache.delete(userId)
  lastGood.delete(userId)
}

// Em erro da Pluggy o chat segue funcionando, só sem os dados
export async function safeFinancials(userId) {
  try {
    return await loadFinancials(userId)
  } catch (err) {
    console.error('[financeiro] não consegui carregar os dados:', err.message)
    return { connections: [], accounts: [], transactions: [] }
  }
}

// pagamento da fatura sai da conta corrente, mas as compras já estão no cartão: contar os dois seria gasto em dobro
const isCardBillPayment = (t) => /credit card payment/i.test(t.category ?? '')
export const isSpending = (t) => t.amount < 0 && !isCardBillPayment(t)

function spendingByCategory(transactions) {
  const totals = new Map()
  for (const t of transactions) {
    if (!isSpending(t) || !t.category) continue
    totals.set(t.category, (totals.get(t.category) ?? 0) + Math.abs(t.amount))
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])
}

// Totais de uma janela de dias, calculados aqui para a IA não precisar somar nada
function windowStats(transactions, days) {
  const since = isoDate(new Date(Date.now() - days * 86_400_000))
  const list = transactions.filter((t) => t.date >= since)
  return {
    since,
    list,
    income: list.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0),
    spending: list.filter(isSpending).reduce((sum, t) => sum + Math.abs(t.amount), 0),
    categories: spendingByCategory(list).slice(0, 10),
  }
}

// Texto com os dados do usuário que vai junto das perguntas ao assistente.
// Não inclui número de conta/agência nem CPF.
export function summarize({ accounts, transactions }) {
  if (accounts.length === 0) return ''
  const lines = [`Hoje é ${isoDate(new Date())}.`, 'Contas:']
  for (const a of accounts) lines.push(`- ${a.institution} · ${a.name} (${a.type}): saldo ${brl(a.balance)}`)
  // somado aqui para o assistente não depender de fazer a conta de cabeça
  const net = accounts.reduce((sum, a) => sum + Number(a.balance ?? 0), 0)
  lines.push(`Saldo líquido (contas somadas, já com a dívida do cartão descontada): ${brl(net)}.`)

  for (const days of [30, PERIOD_DAYS]) {
    const w = windowStats(transactions, days)
    lines.push(
      '',
      `Últimos ${days} dias (desde ${w.since}): entradas ${brl(w.income)}; gastos ${brl(w.spending)} (sem contar o pagamento da fatura do cartão).`,
    )
    if (w.categories.length) {
      lines.push(`Gastos por categoria nos últimos ${days} dias:`)
      for (const [name, total] of w.categories) lines.push(`- ${name}: ${brl(total)}`)
    }
  }

  const recent = windowStats(transactions, 30).list.slice(0, 60)
  lines.push('', 'Todas as transações dos últimos 30 dias (mais recentes primeiro; valor negativo = saída):')
  for (const t of recent) lines.push(`- ${t.date} · ${t.description} · ${brl(t.amount)}${t.category ? ` · ${t.category}` : ''}`)
  return lines.join('\n')
}

const CATEGORY_PT = [
  ['groceries', 'mercado'], ['eating out', 'restaurantes'], ['restaurant', 'restaurantes'], ['transport', 'transporte'],
  ['water', 'água'], ['electric', 'luz'], ['internet', 'internet'], ['utilit', 'contas da casa'], ['shopping', 'compras'],
  ['health', 'saúde'], ['pharmacy', 'farmácia'], ['education', 'educação'], ['entertainment', 'lazer'], ['travel', 'viagens'],
  ['gas', 'combustível'], ['subscription', 'assinaturas'],
]

// Atalhos do chat baseados no que realmente aparece nas transações do usuário
export function suggestionsFor({ accounts, transactions }) {
  if (accounts.length === 0 || transactions.length === 0) return []
  const out = []

  if (transactions.some((t) => /pix/i.test(t.description) || /pix/i.test(t.category ?? ''))) out.push('Minhas transferências PIX')
  if (transactions.some((t) => t.accountType === 'CREDIT')) out.push('Compras recentes')

  const [topCategory] = spendingByCategory(transactions)[0] ?? []
  const translated = topCategory && CATEGORY_PT.find(([key]) => topCategory.toLowerCase().includes(key))
  if (translated) out.push(`Detalhamento de ${translated[1]}`)

  for (const fallback of ['Quanto gastei nos últimos 30 dias?', 'Onde posso economizar?', 'Como está meu saldo?']) {
    if (out.length >= 3) break
    out.push(fallback)
  }
  return out.slice(0, 3)
}
