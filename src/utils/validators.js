export const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '')

export function validCpf(value) {
  const cpf = onlyDigits(value)
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false
  for (let t = 9; t < 11; t++) {
    let sum = 0
    for (let i = 0; i < t; i++) sum += Number(cpf[i]) * (t + 1 - i)
    if (((sum * 10) % 11) % 10 !== Number(cpf[t])) return false
  }
  return true
}

export const normalizePhone = (value) => onlyDigits(value).replace(/^55(?=\d{10,11}$)/, '')

export const validPhone = (value) => /^\d{10,11}$/.test(normalizePhone(value))

export const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v ?? ''))

// Aceita dd/mm/aaaa e devolve aaaa-mm-dd (ou null se for inválida)
export function parseBirthDate(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? ''))
  if (!m) return null
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(year, month - 1, day)
  const ok = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  if (!ok || year < 1900 || date > new Date()) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
