import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'

// Envio de mensagens pela W-API (https://docs.w-api.app). O token e a instância ficam só no .env.
export const whatsappConfigured = () => Boolean(config.whatsapp.instanceId && config.whatsapp.token)

// phone: celular brasileiro só com DDD + número (como fica no banco); o DDI 55 é acrescentado aqui
export async function sendWhatsApp(phone, message) {
  if (!whatsappConfigured()) {
    // em desenvolvimento, sem credenciais, a mensagem só aparece no console
    if (!config.isProd) return console.log(`[dev] WhatsApp para ${phone}:\n${message}`)
    throw new HttpError(503, 'WhatsApp não configurado (WHATSAPP_INSTANCE_ID e WHATSAPP_TOKEN no .env)')
  }

  const { baseUrl, instanceId, token } = config.whatsapp
  let response
  try {
    response = await fetch(`${baseUrl}/v1/message/send-text?instanceId=${encodeURIComponent(instanceId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ phone: `55${phone}`, message, delayMessage: 1 }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    console.error('[whatsapp] falha de rede:', err.message)
    throw new HttpError(502, 'Não foi possível enviar a mensagem pelo WhatsApp. Tente de novo')
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('[whatsapp] erro', response.status, detail.slice(0, 300))
    throw new HttpError(502, 'Não foi possível enviar a mensagem pelo WhatsApp. Tente de novo')
  }
  return (await response.json().catch(() => ({}))).messageId ?? null
}
