import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { query } from '../db.js'
import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'
import { sendWhatsApp, whatsappConfigured } from './whatsapp.js'

const CODE_TTL_MINUTES = 10
const RESEND_SECONDS = 60
const MAX_ATTEMPTS = 5

const MAX_CODES_PER_HOUR = 5

// Envia o código por WhatsApp. Em desenvolvimento ele também aparece no console.
async function deliverCode(phone, code) {
  if (!config.isProd) console.log(`[dev] código de verificação para ${phone}: ${code}`)
  if (!whatsappConfigured() && !config.isProd) return
  await sendWhatsApp(
    phone,
    `*Anota Grana*\n\nSeu código de verificação é *${code}*.\nEle vale por ${CODE_TTL_MINUTES} minutos. Não compartilhe com ninguém.`,
  )
}

export async function sendCode(phone) {
  // a idade do último código é calculada no próprio MySQL, que usa o mesmo relógio e fuso do created_at
  const [last] = await query(
    'SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM verification_codes WHERE phone = ? ORDER BY id DESC LIMIT 1',
    [phone],
  )
  if (last && last.age < RESEND_SECONDS) {
    throw new HttpError(429, `Aguarde ${RESEND_SECONDS - last.age}s para pedir outro código`)
  }

  // teto por hora no mesmo número: cada envio de WhatsApp conta no plano e abusos podem render banimento do chip
  const [{ n }] = await query(
    'SELECT COUNT(*) AS n FROM verification_codes WHERE phone = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)',
    [phone],
  )
  if (n >= MAX_CODES_PER_HOUR) throw new HttpError(429, 'Muitos códigos pedidos para esse número. Tente de novo mais tarde')

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const codeHash = await bcrypt.hash(code, 8)
  const { insertId } = await query(
    'INSERT INTO verification_codes (phone, code_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))',
    [phone, codeHash, CODE_TTL_MINUTES],
  )
  try {
    await deliverCode(phone, code)
  } catch (err) {
    // se o envio falhou, o código não vale e o usuário não precisa esperar o intervalo para tentar de novo
    await query('DELETE FROM verification_codes WHERE id = ?', [insertId])
    throw err
  }
}

export async function checkCode(phone, code) {
  const [row] = await query(
    `SELECT id, code_hash, attempts FROM verification_codes
     WHERE phone = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
     ORDER BY id DESC LIMIT 1`,
    [phone],
  )
  if (!row) throw new HttpError(400, 'Código expirado. Peça um novo')
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Tentativas demais. Peça um novo código')

  const ok = await bcrypt.compare(String(code ?? ''), row.code_hash)
  if (!ok) {
    await query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?', [row.id])
    throw new HttpError(400, 'Código incorreto')
  }
  await query('UPDATE verification_codes SET used_at = UTC_TIMESTAMP() WHERE id = ?', [row.id])
}
