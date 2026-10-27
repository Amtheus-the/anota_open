import { query } from '../db.js'
import * as pluggy from './openFinance.js'

// "JOAO DA SILVA" -> "Joao Da Silva"; preposições ficam em minúsculas
const SMALL = new Set(['da', 'de', 'do', 'das', 'dos', 'e'])
function titleCase(name) {
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

// O nome do titular vem da identidade que o banco compartilha pelo Open Finance
async function fetchHolderName(itemId) {
  const identity = await pluggy.getIdentity(itemId)
  const name = String(identity?.fullName ?? '').trim()
  return name ? titleCase(name).slice(0, 255) : null
}

// Preenche users.name uma única vez, a partir da primeira conexão que tenha identidade.
// Falhas não quebram nada: o app continua sem o nome.
export async function ensureUserName(userId) {
  try {
    const [user] = await query('SELECT name FROM users WHERE id = ?', [userId])
    if (!user || user.name) return user?.name ?? null
    const connections = await query(
      "SELECT provider_item_id FROM connected_accounts WHERE user_id = ? AND status = 'connected' ORDER BY id",
      [userId],
    )
    for (const { provider_item_id: itemId } of connections) {
      const name = await fetchHolderName(itemId).catch(() => null)
      if (name) {
        await query('UPDATE users SET name = ? WHERE id = ? AND name IS NULL', [name, userId])
        return name
      }
    }
  } catch (err) {
    console.error('[identidade] não consegui obter o nome:', err.message)
  }
  return null
}
