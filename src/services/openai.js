import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'
import { openAiTools, runTool } from './widgets.js'
import { CATEGORY_NAMES, previewCorrection } from './categoryRules.js'
import { composioConfigured } from './composio.js'
import { readGmailMessage, searchGmail } from './apps.js'

const SYSTEM_PROMPT = `Você é o Anota Grana, um assistente de finanças pessoais em português do Brasil.
Ajude o usuário a entender gastos, organizar o orçamento e tomar decisões com clareza.
Seja direto, amigável e use valores em reais (R$). Não dê recomendação de investimento
personalizada como se fosse consultor licenciado; explique conceitos e riscos.
Se faltarem dados da conta do usuário, diga o que precisa para responder.
Responda sempre em português: os nomes de categoria dos dados podem estar em inglês, então traduza
(por exemplo, Electricity = Energia elétrica, Housing = Moradia, Telecommunications = Telefonia e internet).
Pagamento de fatura de cartão não é um gasto novo; as compras já estão no cartão.
Use SOMENTE os números e totais que aparecem nos dados do usuário (já vêm calculados por período).
Não some, não estime nem arredonde valores por conta própria. Escreva datas como dd/mm. Se o dado pedido não estiver nos dados
(outro período, outra conta), diga claramente que não tem essa informação.

Você tem ferramentas show_* que exibem blocos visuais (lista de transações, gastos por categoria, entradas e saídas,
cartões, assinaturas, contas, tendência, parcelas). Quando a pergunta combinar com um bloco, CHAME a ferramenta: o usuário
vê o bloco e os números vêm dele. Pode chamar mais de uma. Depois, escreva uma análise curta em 2 a 4 parágrafos, sem repetir
todos os números que já estão no bloco: destaque o que importa, o padrão e uma observação útil. Escreva texto corrido, SEM markdown (nada de **negrito**, #, listas com - ou *), com datas no formato dd/mm. Para conversa simples ou conceitos, responda só com texto.
REGRA: perguntas sobre os dados do usuário (gastos, entradas, saldo, cartão, assinaturas, parcelas, transações, com qualquer
estabelecimento ou período) SEMPRE exigem chamar uma ferramenta antes de responder. Nunca diga que não tem a informação sem
antes consultar. "3 meses" = days 90; "este mês" = days com o número de dias desde o dia 1.
Qual ferramenta usar:
- Dia ou período específico ("dia 18/10", "de 5 a 10 de outubro"): passe from e to (YYYY-MM-DD, ano atual) na ferramenta, nunca um intervalo maior "para garantir".
- "quanto gastei com X": show_spending com search, numa ÚNICA chamada com todos os termos ("ifood, mercado"); não repita a mesma ferramenta.
- "compara setembro com outubro" (gastos de dois meses): show_compare com month_a e month_b em YYYY-MM.
- "saúde financeira": show_cards, show_accounts e show_income_expenses com months=4; comente o conjunto (entradas x saídas, tendência dos meses, fatura, limite, saldo).
- "onde posso economizar": show_savings E show_subscriptions; comente os itens do bloco.
- "saldo e como evoluiu": show_accounts E show_trend.
PLANEJAMENTO E CONSELHO (meta de juntar dinheiro, economizar, "dá pra...?"): não responda só com a conta matemática. Primeiro
consulte os dados (show_income_expenses, show_accounts e, se houver cartão, show_cards) e cruze: renda do mês, quanto sobrou,
saldo, fatura. Diga com franqueza se cabe no orçamento, quanto isso representa da renda e quais são 2 ou 3 alavancas práticas,
citando os números reais do usuário. Termine com um próximo passo concreto. Percentuais só a partir dos números das ferramentas.
PERSONALIDADE: o Anota Grana é uma raposa. Em respostas mais longas, faça UMA brincadeira curta e natural (toca, faro, rabo, caça),
sem exagerar e sem atrapalhar a informação.
CORREÇÃO DE CATEGORIAS (agente Prisma): quando o usuário disser que uma compra ou estabelecimento está na categoria errada ("o Mercadinho Zé é
Alimentação", "esse Pix para a Maria não é gasto"), chame set_category com o nome como aparece no extrato e uma categoria da lista. Se não ficar
claro qual estabelecimento, pergunte antes. Depois confirme em uma frase o que mudou (estabelecimento, categoria e quantas transações) e diga que
vale para as próximas também. Os valores que você já mostrou nesta conversa não mudam sozinhos: avise que a nova categoria aparece nas próximas consultas.
AGENTES: o app tem 6 agentes que o usuário pode ativar: Luno (o agente do fechamento diário: manda por WhatsApp, no fim do dia, um resumo dos gastos, entradas e saldo), Faro (cobranças suspeitas e duplicadas), Prisma (corrige categorias e
aprende com o usuário), Teto (alerta quando os gastos passam do limite definido), Faísca (missões financeiras inesperadas) e
Juízo (chama a atenção para gastos exagerados, sincero e irônico sem humilhar). Quando o usuário pedir "Crie o X ..." NÃO crie
ainda: primeiro faça UMA pergunta curta com o que falta (Teto: qual limite de gasto por mês; Faro, Prisma, Faísca e Juízo: em que
horário quer receber o aviso; Luno: em que horário quer o fechamento do dia, padrão 21h, depois que o banco atualiza os dados do dia; se preferir, pode usar o padrão) e diga que o
agente avisa por WhatsApp, no número do cadastro, e que dá para parar a qualquer hora respondendo PARAR. Só DEPOIS que o usuário responder, chame create_agent e confirme em 2 ou 3 frases o que o agente
vai fazer e quando (padrão 9h, ou 21h no Luno, se ele não disse horário, e avise que pode ajustar). Nunca chame create_agent antes de o usuário
responder à sua pergunta. Se ele disser que não quer mais o agente, apenas confirme que não criou nada.
GMAIL: quando o usuário pedir algo que está nos e-mails dele (boletos, faturas, assinaturas, recibos, vencimentos, cobranças recusadas), use search_gmail.
Pesquise a caixa de entrada com cuidado e por inteiro: use SEMPRE "queries" com várias buscas diferentes de uma vez, nunca uma palavra só.
Para boletos, contas e vencimentos, no mínimo: "boleto", "fatura", "vencimento", "cobrança", "pagamento recusado", "segunda via", "nota fiscal" e "newer_than:60d has:attachment".
Se o resultado vier com poucos e-mails (menos de 3), amplie as buscas (outros termos, remetentes que apareceram, períodos maiores) antes de concluir que não há nada.
Se houver next_page_token numa busca única e ainda faltar ver e-mails, continue com page_token. Use read_gmail_message para ler um e-mail por inteiro.
Não pergunte qual e-mail abrir: leia você mesmo, com read_gmail_message, os até 5 mais relevantes (boleto, fatura, cobrança) antes de responder, para trazer valor e vencimento.
Cruze o que achou nos e-mails com os dados do banco (por exemplo, a fatura do cartão) e diga o que bate e o que não bate. Diga com franqueza o que não deu para ver
(valor ou vencimento que não estão no e-mail, anexos que você não leu). Nunca invente valor ou data. Preencha "reason" sempre, em uma frase curta que o usuário lê antes de autorizar.
Se a ferramenta devolver needs_connection, o usuário vê um cartão para autorizar o acesso: explique em 1 ou 2 frases o que vai fazer depois que ele autorizar e não chame a ferramenta de novo.
Descreva exatamente o que o bloco mostra: não omita itens nem troque valores. Se a ferramenta voltar sem resultado, aí sim diga que não encontrou.`

// Agentes que o chat pode criar (o front guarda a lista; aqui só validamos qual foi escolhido)
const AGENT_KEYS = ['faro', 'prisma', 'teto', 'faisca', 'juizo', 'luno']
const createAgentTool = {
  type: 'function',
  function: {
    name: 'create_agent',
    description: 'Cria (ativa) um agente para o usuário, SOMENTE depois que ele respondeu à pergunta de configuração.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: AGENT_KEYS, description: 'faro, prisma, teto, faisca, juizo ou luno' },
        schedule: { type: 'string', description: 'Quando o agente avisa, em texto curto (ex.: "Todo dia às 9h"). Padrão: Todo dia às 9h' },
        limit: { type: 'number', description: 'Só para o Teto: limite de gastos por mês em reais' },
      },
      required: ['agent'],
    },
  },
}

// Prisma: corrige a categoria de um estabelecimento ou diz que não é gasto (a regra é gravada pelo chatService)
const setCategoryTool = {
  type: 'function',
  function: {
    name: 'set_category',
    description: 'Corrige a categoria de um estabelecimento ou pessoa nas transações do usuário, ou marca como "Não é gasto". Use quando ele disser que algo está na categoria errada ou que não é um gasto dele.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Nome do estabelecimento ou da pessoa, como aparece no extrato (ex.: "mercadinho ze", "movida")' },
        category: { type: 'string', enum: CATEGORY_NAMES, description: 'Categoria correta, ou "Não é gasto" (ex.: Pix para si mesmo, para a família, entre contas)' },
      },
      required: ['search', 'category'],
    },
  },
}

// Gmail (via Composio): o chat procura e lê e-mails do usuário depois que ele autoriza o acesso
const reasonParam = { type: 'string', description: 'Uma frase curta, em português, dizendo ao usuário para que você precisa do Gmail (ex.: "para procurar no seu Gmail os boletos que vencem esta semana")' }
const gmailTools = [
  {
    type: 'function',
    function: {
      name: 'search_gmail',
      description: 'Procura e-mails na caixa de entrada do usuário (sintaxe de busca do Gmail). Devolve remetente, assunto, data e um trecho do texto.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Uma busca do Gmail, ex.: "boleto", "from:nubank fatura", "newer_than:30d vencimento"' },
          queries: { type: 'array', items: { type: 'string' }, description: 'Várias buscas de uma vez (até 6); os resultados vêm somados, sem repetir. Prefira isto a uma busca só.' },
          max_results: { type: 'integer', description: 'Quantos e-mails (1 a 25). Padrão 15.' },
          page_token: { type: 'string', description: 'next_page_token da busca anterior, para ver mais resultados' },
          reason: reasonParam,
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_gmail_message',
      description: 'Lê um e-mail por inteiro a partir do id devolvido por search_gmail.',
      parameters: { type: 'object', properties: { message_id: { type: 'string' }, reason: reasonParam }, required: ['message_id', 'reason'] },
    },
  },
]

// Título curto para a lista "Recentes" (ex.: "Gastos com transporte por app").
// Roda em segundo plano; se falhar, o título provisório continua valendo.
export async function generateTitle(userMessage, assistantReply) {
  if (!config.openai.apiKey) return null
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.apiKey}` },
    body: JSON.stringify({
      model: config.openai.model,
      temperature: 0.2,
      max_tokens: 20,
      messages: [
        {
          role: 'system',
          content: 'Resuma o assunto da conversa em um título de 2 a 5 palavras, em português, sem aspas e sem ponto final.',
        },
        { role: 'user', content: `Pergunta: ${userMessage.slice(0, 300)}\nResposta: ${assistantReply.slice(0, 300)}` },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) return null
  const data = await response.json()
  const title = data.choices?.[0]?.message?.content?.trim().replace(/^["'“]|["'”.]$/g, '')
  return title ? title.slice(0, 80) : null
}

// history: [{ role: 'user' | 'assistant', content: string }]
export async function askAssistant(history, financialContext = '') {
  if (!config.openai.apiKey) throw new HttpError(503, 'OpenAI não configurada (OPENAI_API_KEY)')

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
  if (financialContext) messages.push({ role: 'system', content: `Dados financeiros do usuário:\n${financialContext}` })
  messages.push(...history)

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify({ model: config.openai.model, messages, temperature: 0.4 }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('[openai] erro', response.status, detail.slice(0, 300))
    throw new HttpError(502, 'O assistente não conseguiu responder agora. Tente de novo')
  }

  const data = await response.json()
  const reply = data.choices?.[0]?.message?.content?.trim()
  if (!reply) throw new HttpError(502, 'Resposta vazia do assistente')
  return reply
}

// Versão com ferramentas: a IA pode pedir blocos visuais; eles são montados aqui com os dados reais.
// Devolve { reply, widgets, steps, agents }.
// No WhatsApp o usuário não vê os blocos visuais: a resposta precisa trazer os números no próprio texto.
const WHATSAPP_PROMPT = `CANAL: o usuário está conversando pelo WhatsApp e NÃO vê os blocos visuais das ferramentas show_*. Chame as ferramentas
normalmente para obter os números, mas escreva na resposta os valores e itens principais que ele precisaria ver (por exemplo as 3 a 5
maiores categorias, os totais e as datas), em linhas curtas. Aqui você pode usar o negrito do WhatsApp (*assim*) e listas com "•".
Seja objetivo: no máximo cerca de 1200 caracteres, sem enrolação.`

// Fora do modo Computer a IA não tem as ferramentas de apps: precisa dizer isso, em vez de tentar ou fingir
const CHAT_MODE_PROMPT = `MODO: conversa normal. Aqui você NÃO tem acesso ao Gmail nem a outros apps conectados, só aos dados financeiros do Open Finance.
Se o usuário pedir algo que está nos e-mails ou em outro app (boletos por e-mail, recibos, faturas em PDF, agenda), diga em 1 ou 2 frases que isso fica no modo Computer: ele liga o botão
"Computer" (ao lado do +, na caixa de mensagem, no site) e pede de novo. Se der, responda a parte que os dados do banco permitem (por exemplo, a fatura do cartão e as parcelas), sem inventar o que só estaria no e-mail.
Não peça para conectar o Gmail nesta conversa e não diga que "não tem como": explique o caminho.`

export async function askWithWidgets(history, financialContext, fin, { channel = 'web', userId = null, mode = 'chat' } = {}) {
  if (!config.openai.apiKey) throw new HttpError(503, 'OpenAI não configurada (OPENAI_API_KEY)')
  // apps conectados (Gmail) só no modo Computer do site: no chat normal e no WhatsApp o assistente sabe que não os tem
  const gmailOn = composioConfigured() && userId != null && mode === 'computer' && channel === 'web'

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
  if (channel === 'whatsapp') messages.push({ role: 'system', content: WHATSAPP_PROMPT })
  if (composioConfigured() && !gmailOn) messages.push({ role: 'system', content: CHAT_MODE_PROMPT })
  if (financialContext) messages.push({ role: 'system', content: `Dados financeiros do usuário:
${financialContext}` })
  messages.push(...history)

  const widgets = []
  const agents = []
  const corrections = []
  let steps = 0
  // com o Gmail ligado a IA pode fazer várias buscas antes de responder
  const maxRounds = gmailOn ? 7 : 3
  let mailWidget = null

  for (let round = 0; round < maxRounds; round++) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.apiKey}` },
      body: JSON.stringify({
        model: config.openai.model,
        messages,
        temperature: 0.4,
        // na última volta a IA já tem os blocos e só precisa escrever
        ...(round < maxRounds - 1 ? { tools: [...(fin.accounts.length > 0 ? [...openAiTools, setCategoryTool] : []), createAgentTool, ...(gmailOn ? gmailTools : [])] } : {}),
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      console.error('[openai] erro', response.status, detail.slice(0, 300))
      throw new HttpError(502, 'O assistente não conseguiu responder agora. Tente de novo')
    }
    const message = (await response.json()).choices?.[0]?.message
    const calls = message?.tool_calls ?? []

    if (calls.length === 0) {
      const reply = message?.content?.trim()
      if (!reply) throw new HttpError(502, 'Resposta vazia do assistente')
      return { reply, widgets, steps, agents, corrections }
    }

    messages.push(message)
    for (const call of calls) {
      let args = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        /* argumentos inválidos: usa os padrões */
      }
      steps += 1
      if (call.function.name === 'create_agent') {
        const key = AGENT_KEYS.includes(args.agent) ? args.agent : null
        if (key) agents.push({ key, schedule: String(args.schedule ?? 'Todo dia às 9h').slice(0, 60), limit: Number(args.limit) > 0 ? Number(args.limit) : null })
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(key ? { ok: true, agent: key } : { ok: false, error: 'agente desconhecido' }) })
        continue
      }
      if (call.function.name === 'set_category') {
        const result = previewCorrection(fin, args)
        if (result.ok) corrections.push({ merchants: result.merchants, target: result.target })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.ok
            ? { ok: true, categoria: result.category, estabelecimentos: result.merchants.map((m) => ({ nome: m.label, transacoes: m.count, total: m.total })), observacao: 'A regra vale para todas as transações desse estabelecimento, passadas e futuras.' }
            : { ok: false, error: result.error, exemplos: result.exemplos }),
        })
        continue
      }
      if (call.function.name === 'search_gmail' || call.function.name === 'read_gmail_message') {
        let result
        try {
          result = call.function.name === 'search_gmail'
            ? await searchGmail(userId, { query: args.query, maxResults: args.max_results, pageToken: args.page_token })
            : await readGmailMessage(userId, args.message_id)
        } catch (err) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'Não consegui acessar o Gmail agora' }) })
          console.error('[gmail]', err.message)
          continue
        }
        if (result.needsConnection) {
          if (channel === 'whatsapp') {
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ needs_connection: true, observacao: 'O Gmail ainda não está conectado. A conexão só é feita no app: peça para abrir Minha conta, depois Apps, e conectar o Gmail.' }) })
          } else {
            if (!widgets.some((w) => w.type === 'connectApp')) widgets.push({ type: 'connectApp', title: 'Conectar o Gmail', app: 'gmail', name: 'Gmail', reason: String(args.reason ?? 'para procurar nos seus e-mails').slice(0, 200) })
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ needs_connection: true, observacao: 'O usuário vê agora um cartão para autorizar o Gmail. Depois que ele autorizar, ele pede de novo.' }) })
          }
          continue
        }
        // um único bloco mostra tudo o que foi lido, para o usuário saber de onde vieram as respostas
        const read = result.emails ?? [result.email]
        if (!mailWidget) {
          mailWidget = { type: 'mailRead', title: 'E-mails lidos no Gmail', count: 0, items: [] }
          widgets.push(mailWidget)
        }
        mailWidget.count += read.length
        for (const e of read) if (mailWidget.items.length < 30) mailWidget.items.push({ from: String(e.from).slice(0, 80), subject: String(e.subject).slice(0, 120), date: String(e.date).slice(0, 40) })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: true, emails: read, next_page_token: result.nextPageToken ?? null, total_estimado: result.total ?? null, observacao: read.length === 0 ? 'Nenhum e-mail encontrado com essa busca.' : 'Os textos são trechos. Se um e-mail parece ter valor ou vencimento que o trecho não mostra, chame read_gmail_message AGORA para ele (até 5 e-mails, sem perguntar ao usuário). Só diga que não aparece depois de ler o e-mail inteiro.' }),
        })
        continue
      }
      const { widgets: built, summary } = runTool(call.function.name, args, fin)
      widgets.push(...built)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(summary) })
    }
  }
  throw new HttpError(502, 'O assistente não conseguiu responder agora. Tente de novo')
}
