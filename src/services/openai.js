import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'
import { openAiTools, runTool } from './widgets.js'
import { CATEGORY_NAMES, previewCorrection } from './categoryRules.js'

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
horário quer receber o aviso; Luno: em que horário quer o fechamento do dia, padrão 18h30; se preferir, pode usar o padrão) e diga que o
agente avisa por WhatsApp, no número do cadastro, e que dá para parar a qualquer hora respondendo PARAR. Só DEPOIS que o usuário responder, chame create_agent e confirme em 2 ou 3 frases o que o agente
vai fazer e quando (padrão 9h, ou 18h30 no Luno, se ele não disse horário, e avise que pode ajustar). Nunca chame create_agent antes de o usuário
responder à sua pergunta. Se ele disser que não quer mais o agente, apenas confirme que não criou nada.
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

export async function askWithWidgets(history, financialContext, fin, { channel = 'web' } = {}) {
  if (!config.openai.apiKey) throw new HttpError(503, 'OpenAI não configurada (OPENAI_API_KEY)')

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
  if (channel === 'whatsapp') messages.push({ role: 'system', content: WHATSAPP_PROMPT })
  if (financialContext) messages.push({ role: 'system', content: `Dados financeiros do usuário:
${financialContext}` })
  messages.push(...history)

  const widgets = []
  const agents = []
  const corrections = []
  let steps = 0

  for (let round = 0; round < 3; round++) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.apiKey}` },
      body: JSON.stringify({
        model: config.openai.model,
        messages,
        temperature: 0.4,
        // na última volta a IA já tem os blocos e só precisa escrever
        ...(round < 2 ? { tools: [...(fin.accounts.length > 0 ? [...openAiTools, setCategoryTool] : []), createAgentTool] } : {}),
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
      const { widgets: built, summary } = runTool(call.function.name, args, fin)
      widgets.push(...built)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(summary) })
    }
  }
  throw new HttpError(502, 'O assistente não conseguiu responder agora. Tente de novo')
}
