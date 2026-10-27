import { Router } from 'express'

const router = Router()
const cache = new Map()
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i

// Logo da empresa pelo domínio (as <img> não enviam login, então esta rota é pública).
// O endereço buscado é sempre o do serviço de ícones, com o domínio só como parâmetro.
router.get('/', async (req, res) => {
  const domain = String(req.query.domain ?? '').toLowerCase()
  if (!DOMAIN.test(domain) || domain.length > 80) return res.status(400).end()

  let logo = cache.get(domain)
  if (!logo) {
    const response = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`, {
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    if (!response?.ok) return res.status(404).end()
    logo = { type: response.headers.get('content-type') ?? 'image/png', body: Buffer.from(await response.arrayBuffer()) }
    if (cache.size > 300) cache.clear()
    cache.set(domain, logo)
  }
  // o Helmet bloqueia imagens de outra origem por padrão; o front roda em outra porta
  res.set({ 'Content-Type': logo.type, 'Cache-Control': 'public, max-age=604800', 'Cross-Origin-Resource-Policy': 'cross-origin' })
  res.send(logo.body)
})

export default router
