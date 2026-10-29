import { query } from '../db.js'
import { cleanDescription } from '../utils/describe.js'

// Prisma: o usuário corrige a categoria de um estabelecimento (ou diz que não é gasto) e a regra passa a valer
// para todas as transações dele, passadas e futuras, em todas as telas, nos alertas e no chat.

// nome em português (como a IA e o usuário falam) -> categoria da Pluggy que o resto do sistema já entende
export const OPTIONS = {
  Supermercado: 'groceries',
  'Restaurantes, bares e lanchonetes': 'eating out',
  'Delivery de alimentos': 'food delivery',
  Alimentação: 'food',
  Transporte: 'transport',
  'Táxi e transporte por app': 'taxi',
  Combustível: 'gas',
  Compras: 'shopping',
  Moradia: 'housing',
  Saúde: 'health',
  Farmácia: 'pharmacy',
  Educação: 'education',
  Lazer: 'entertainment',
  Streaming: 'streaming',
  Assinaturas: 'subscription',
  Viagens: 'travel',
  Serviços: 'services',
  Doações: 'donation',
  Transferências: 'transfer',
}
export const NOT_SPENDING = 'Não é gasto'
export const CATEGORY_NAMES = [...Object.keys(OPTIONS), NOT_SPENDING]

const MAX_RULES = 500
const MAX_MERCHANTS_PER_CORRECTION = 5

// "Transferência enviada pelo Pix|MOVIDA PARTICIPACOES S.A." -> "movida participacoes s a"
export function merchantKey(description) {
  return String(description ?? '')
    .split('|')
    .pop()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

export async function loadRules(userId) {
  const rows = await query('SELECT merchant_key AS merchantKey, category_key AS categoryKey, ignored FROM category_rules WHERE user_id = ?', [userId])
  return new Map(rows.map((r) => [r.merchantKey, { categoryKey: r.categoryKey, ignored: Boolean(r.ignored) }]))
}

// Aplica as regras nas transações carregadas. "Não é gasto" reaproveita a exclusão que o sistema já faz com pagamento de fatura.
export function applyRules(transactions, rules) {
  if (rules.size === 0) return
  for (const t of transactions) {
    const rule = rules.get(merchantKey(t.description))
    if (!rule) continue
    t.ruled = true
    t.originalCategory = t.category
    if (rule.ignored) {
      t.ignored = true
      t.category = 'Credit card payment'
    } else if (rule.categoryKey) {
      t.category = rule.categoryKey
      t.categoryPt = null
    }
  }
}

// Quais estabelecimentos o pedido atinge, antes de gravar (a IA mostra o resultado ao usuário)
export function previewCorrection(fin, { search, category }) {
  const target = category === NOT_SPENDING ? { ignored: true, categoryKey: null } : OPTIONS[category] ? { ignored: false, categoryKey: OPTIONS[category] } : null
  if (!target) return { ok: false, error: `Categoria inválida. Use uma destas: ${CATEGORY_NAMES.join(', ')}` }
  const needle = merchantKey(search)
  if (needle.length < 3) return { ok: false, error: 'Preciso do nome do estabelecimento ou da pessoa, como aparece no extrato' }

  const found = new Map()
  for (const t of fin.transactions) {
    const key = merchantKey(t.description)
    if (!key.includes(needle)) continue
    const item = found.get(key) ?? { key, label: cleanDescription(t.description), count: 0, total: 0 }
    item.count += 1
    item.total += Math.abs(t.amount)
    found.set(key, item)
  }
  if (found.size === 0) return { ok: false, error: 'Não achei nenhuma transação com esse nome nos últimos 90 dias' }
  if (found.size > MAX_MERCHANTS_PER_CORRECTION) {
    return { ok: false, error: `Esse nome aparece em ${found.size} estabelecimentos diferentes. Peça um nome mais específico`, exemplos: [...found.values()].slice(0, 5).map((m) => m.label) }
  }
  const merchants = [...found.values()].map((m) => ({ ...m, total: Math.round(m.total * 100) / 100 }))
  return { ok: true, target, category, merchants }
}

export async function saveRules(userId, merchants, target) {
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM category_rules WHERE user_id = ?', [userId])
  for (const merchant of merchants) {
    if (n >= MAX_RULES) break
    await query(
      `INSERT INTO category_rules (user_id, merchant_key, label, category_key, ignored) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE label = VALUES(label), category_key = VALUES(category_key), ignored = VALUES(ignored)`,
      [userId, merchant.key, String(merchant.label).slice(0, 120), target.categoryKey, target.ignored ? 1 : 0],
    )
  }
}
