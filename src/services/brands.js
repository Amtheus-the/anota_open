// Nome que aparece na fatura -> empresa (nome, domínio para o logo e se é um serviço de assinatura).
// Só serviços de assinatura (streaming, telefonia, software, academia) entram na lista de Assinaturas:
// uma cafeteria ou uma parcela que se repete todo mês não é assinatura.
const BRANDS = [
  [/netflix/, 'Netflix', 'netflix.com', true],
  [/spotify/, 'Spotify', 'spotify.com', true],
  [/\btim\b/, 'TIM', 'tim.com.br', true],
  [/\bvivo\b/, 'Vivo', 'vivo.com.br', true],
  [/\bclaro\b/, 'Claro', 'claro.com.br', true],
  [/\boi\b/, 'Oi', 'oi.com.br', true],
  [/uber/, 'Uber', 'uber.com', false],
  [/ifood/, 'iFood', 'ifood.com.br', false],
  [/amazon prime|prime video/, 'Prime Video', 'primevideo.com', true],
  [/amazon/, 'Amazon', 'amazon.com.br', false],
  [/disney/, 'Disney+', 'disneyplus.com', true],
  [/\bhbo\b|\bmax\b/, 'Max', 'max.com', true],
  [/youtube/, 'YouTube', 'youtube.com', true],
  [/apple|itunes/, 'Apple', 'apple.com', true],
  [/google/, 'Google', 'google.com', true],
  [/microsoft/, 'Microsoft', 'microsoft.com', true],
  [/globo/, 'Globoplay', 'globoplay.globo.com', true],
  [/deezer/, 'Deezer', 'deezer.com', true],
  [/smart ?fit/, 'Smart Fit', 'smartfit.com.br', true],
  [/wellhub|gympass/, 'Wellhub', 'wellhub.com', true],
  [/openai|chatgpt/, 'ChatGPT', 'openai.com', true],
  [/adobe/, 'Adobe', 'adobe.com', true],
  [/canva/, 'Canva', 'canva.com', true],
  [/eletrobras light|\blight\b/, 'Light', 'light.com.br', false],
  [/enel/, 'Enel', 'enel.com.br', false],
  [/sabesp/, 'Sabesp', 'sabesp.com.br', false],
  [/\b99 ?pop\b|\b99\b/, '99', '99app.com', false],
  [/mercado ?livre|mercadolivre/, 'Mercado Livre', 'mercadolivre.com.br', false],
  [/shopee/, 'Shopee', 'shopee.com.br', false],
  [/rappi/, 'Rappi', 'rappi.com.br', false],
]

export function brandFor(text) {
  const t = String(text ?? '').toLowerCase()
  const found = BRANDS.find(([re]) => re.test(t))
  return found ? { name: found[1], domain: found[2], subscription: found[3] } : null
}

export function domainFor(text) {
  return brandFor(text)?.domain ?? null
}
