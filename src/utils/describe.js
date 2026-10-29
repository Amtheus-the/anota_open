// A descrição do banco vem crua ("Transferência enviada pelo Pix|EMPRESA LTDA"): deixa só o que ajuda a reconhecer a cobrança
export function cleanDescription(raw) {
  const text = String(raw ?? '').trim()
  const [kind, name] = text.split('|').map((part) => part.trim())
  if (!name) return text
  return /pix/i.test(kind) ? `Pix para ${name}` : name
}
