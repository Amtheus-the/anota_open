import { query } from '../db.js'

// Agentes do catálogo: o chat só cria um destes
export const CATALOG = {
  faro: { name: 'Faro', text: 'Detecta cobranças suspeitas e duplicadas' },
  prisma: { name: 'Prisma', text: 'Corrige categorias financeiras e aprende com o usuário' },
  teto: { name: 'Teto', text: 'Alerta quando os gastos ultrapassam os limites definidos' },
  faisca: { name: 'Faísca', text: 'Cria missões financeiras inesperadas' },
  juizo: { name: 'Juízo', text: 'Chama a atenção para gastos exagerados ou incompatíveis com o orçamento' },
  luno: { name: 'Luno', text: 'Envia no fim do dia um resumo dos gastos, entradas e movimentações financeiras', defaultSchedule: 'Todo dia às 18h30' },
}

const COLUMNS = 'id, agent_key AS agentKey, name, text, frequency, spend_limit AS spendLimit, active'
const format = (row) => ({ ...row, active: Boolean(row.active), spendLimit: row.spendLimit == null ? null : Number(row.spendLimit) })

export async function listAgents(userId) {
  const rows = await query(`SELECT ${COLUMNS} FROM user_agents WHERE user_id = ? ORDER BY id`, [userId])
  return rows.map(format)
}

// cria o agente do catálogo; se já existir, só atualiza horário e limite
export async function upsertCatalogAgent(userId, { key, schedule, limit }) {
  const base = CATALOG[key]
  if (!base) return null
  await query(
    `INSERT INTO user_agents (user_id, agent_key, name, text, frequency, spend_limit, active) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE frequency = VALUES(frequency), spend_limit = VALUES(spend_limit), active = 1`,
    [userId, key, base.name, base.text, schedule || base.defaultSchedule || 'Todo dia às 9h', limit ?? null],
  )
  const [row] = await query(`SELECT ${COLUMNS} FROM user_agents WHERE user_id = ? AND name = ?`, [userId, base.name])
  return format(row)
}
