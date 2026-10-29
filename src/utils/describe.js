// A descrição do banco vem crua ("Transferência enviada pelo Pix|EMPRESA LTDA"): deixa só o que ajuda a reconhecer a cobrança
export function cleanDescription(raw) {
  const text = String(raw ?? '').trim()
  const [kind, name] = text.split('|').map((part) => part.trim())
  if (!name) return text
  if (!/pix/i.test(kind)) return name
  return /recebid/i.test(kind) ? `Pix de ${name}` : `Pix para ${name}`
}
