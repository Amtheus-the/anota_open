import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'

const MAX_SECONDS = 180
const MAX_BYTES = 8 * 1024 * 1024

// Transcreve um áudio (Buffer) em português usando a OpenAI
export async function transcribeAudio(buffer, mimetype = 'audio/ogg') {
  if (!config.openai.apiKey) throw new HttpError(503, 'Transcrição indisponível')
  const ext = /mpeg|mp3/.test(mimetype) ? 'mp3' : /mp4|m4a|aac/.test(mimetype) ? 'm4a' : /wav/.test(mimetype) ? 'wav' : 'ogg'
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype.split(';')[0] || 'audio/ogg' }), `audio.${ext}`)
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1')
  form.append('language', 'pt')
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    console.error('[transcricao]', response.status, (await response.text().catch(() => '')).slice(0, 300))
    throw new HttpError(502, 'Não consegui transcrever o áudio')
  }
  return String((await response.json().catch(() => ({})))?.text ?? '').trim()
}

// Baixa o áudio recebido pelo WhatsApp (W-API). O formato exato do aviso varia: tenta os jeitos conhecidos e registra o que veio.
export async function downloadWhatsAppAudio(payload) {
  const audio = payload?.msgContent?.audioMessage ?? {}
  const seconds = Number(audio.seconds ?? 0)
  if (seconds > MAX_SECONDS) throw new HttpError(413, 'Áudio longo demais')
  const mimetype = String(audio.mimetype ?? 'audio/ogg')

  const inline = audio.base64 ?? audio.mediaBase64 ?? payload?.base64 ?? payload?.msgContent?.base64
  if (inline) return { buffer: Buffer.from(String(inline).replace(/^data:[^,]+,/, ''), 'base64'), mimetype }

  const fetchBuffer = async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return { status: response.status }
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('json')) {
      const json = await response.json().catch(() => ({}))
      const b64 = json.base64 ?? json.data?.base64 ?? json.fileBase64 ?? json.mediaBase64
      const link = json.url ?? json.fileUrl ?? json.link ?? json.data?.url
      if (b64) return { buffer: Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64') }
      if (link) return fetchBuffer(link)
      return { status: 'json sem arquivo', keys: Object.keys(json) }
    }
    return { buffer: Buffer.from(await response.arrayBuffer()) }
  }

  const attempts = []
  const direct = audio.url ?? audio.mediaUrl ?? audio.fileUrl ?? payload?.mediaUrl
  if (direct && !/\.enc(\?|$)/.test(String(direct))) attempts.push(['url', () => fetchBuffer(direct)])

  const { baseUrl, instanceId, token } = config.whatsapp
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const body = JSON.stringify({ messageId: payload.messageId, type: 'audio', mimetype, mediaKey: audio.mediaKey, directPath: audio.directPath, url: audio.url, fileLength: audio.fileLength })
  attempts.push(['download-media', () => fetchBuffer(`${baseUrl}/v1/message/download-media?instanceId=${encodeURIComponent(instanceId)}`, { method: 'POST', headers, body })])

  const tried = []
  for (const [name, run] of attempts) {
    try {
      const result = await run()
      if (result?.buffer?.length) {
        if (result.buffer.length > MAX_BYTES) throw new HttpError(413, 'Áudio grande demais')
        return { buffer: result.buffer, mimetype }
      }
      tried.push(`${name}: ${JSON.stringify(result)}`)
    } catch (err) {
      if (err instanceof HttpError) throw err
      tried.push(`${name}: ${err.message}`)
    }
  }
  // sem expor chaves: só os nomes dos campos, para ajustar o formato depois
  console.error('[whatsapp] não consegui baixar o áudio. campos do audioMessage:', Object.keys(audio).join(','), '| campos do aviso:', Object.keys(payload ?? {}).join(','), '| tentativas:', tried.join(' ; '))
  throw new HttpError(502, 'Não consegui baixar o áudio')
}
