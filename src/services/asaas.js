import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'

// Integração com o Asaas (https://docs.asaas.com): cliente + autorização de Pix Automático.
// A pessoa paga o primeiro Pix e, no mesmo QR Code, autoriza as cobranças dos meses seguintes.

export const asaasConfigured = () => Boolean(config.asaas.apiKey)

async function call(path, { method = 'GET', body } = {}) {
  if (!asaasConfigured()) throw new HttpError(503, 'A assinatura ainda não está disponível. Tente mais tarde')
  let response
  try {
    response = await fetch(`${config.asaas.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', access_token: config.asaas.apiKey, 'User-Agent': 'anota-grana' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new HttpError(502, 'Não consegui falar com o serviço de pagamento. Tente de novo')
  }
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* resposta sem corpo */ }
  if (!response.ok) {
    console.error(`[asaas] ${method} ${path} -> ${response.status}`, text.slice(0, 300))
    throw new HttpError(response.status === 400 ? 400 : 502, data?.errors?.[0]?.description ?? 'O serviço de pagamento recusou o pedido. Tente de novo')
  }
  return data
}

// O Asaas aceita clientes duplicados: antes de criar, procura um já cadastrado com o mesmo CPF
// (cobre timeouts em tentativas anteriores e quem excluiu a conta e voltou).
export async function createCustomer({ name, cpf, email, phone, userId }) {
  const existing = await call(`/v3/customers?cpfCnpj=${encodeURIComponent(cpf)}&limit=1`)
  if (existing?.data?.[0]?.id) return existing.data[0]
  return call('/v3/customers', {
    method: 'POST',
    body: { name, cpfCnpj: cpf, email, mobilePhone: phone, externalReference: String(userId) },
  })
}

// MONTHLY: o Asaas gera as cobranças dos meses seguintes (paymentCreationMode SUBSCRIPTION) e tenta de novo
// até 3 vezes em 7 dias se o Pix falhar. O QR Code devolvido cobra o primeiro mês e registra a autorização.
export async function createAuthorization({ customerId, contractId, value, startDate, description }) {
  return call('/v3/pix/automatic/authorizations', {
    method: 'POST',
    body: {
      frequency: 'MONTHLY',
      contractId,
      startDate,
      customerId,
      description,
      value,
      paymentCreationMode: 'SUBSCRIPTION',
      retryPolicy: 'ALLOW_THREE_IN_SEVEN_DAYS',
      immediateQrCode: { expirationSeconds: 3600, originalValue: value, description },
    },
  })
}

export async function cancelAuthorization(authorizationId) {
  return call(`/v3/pix/automatic/authorizations/${encodeURIComponent(authorizationId)}`, { method: 'DELETE' })
}
