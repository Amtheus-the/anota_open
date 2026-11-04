import { config } from '../config.js'
import { HttpError } from '../utils/validators.js'
import { openAiTools, runTool } from './widgets.js'
import { CATEGORY_NAMES, previewCorrection } from './categoryRules.js'
import { composioConfigured } from './composio.js'
import { appendNotionPage, calendarEvents, createCalendarEvent, createNotionPage, deleteCalendarEvent, readGmailMessage, readNotionPage, searchGmail, searchNotion } from './apps.js'

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
AGENDA (Google Calendar): para ver compromissos use list_calendar_events (consulta todas as agendas dele; cite quais agendas foram vistas). Para "me lembra de..." ou criar um evento, use create_calendar_event:
crie DIRETO, é só na agenda dele e dá para desfazer; NUNCA coloque convidados nem mande e-mail de convite. Use datas e horas de Brasília, calcule "amanhã" e dias da semana a partir do "Agora" informado, e confirme em 1 frase com dia, hora e o que foi gravado.
Quando o lembrete for de uma conta, busque o valor e o vencimento reais nos dados do banco ou nos e-mails antes de criar, e ponha-os no título e na descrição. Para apagar, use delete_calendar_event com o id do evento.
Se a ferramenta devolver needs_connection, o usuário vê o cartão para autorizar: explique em 1 frase e não repita a chamada.
GOOGLE MEET: se o usuário pedir reunião online, videochamada ou Meet, chame create_calendar_event com meet=true e passe o link devolvido (meetLink) na resposta. Se meetLink vier vazio, diga que o evento foi criado mas o Google não gerou o link. Você NÃO convida outras pessoas: diga que ele pode copiar o link e enviar a quem quiser.
REGRA DA AGENDA: só diga que criou, agendou, marcou ou apagou algo DEPOIS de chamar create_calendar_event ou delete_calendar_event e receber ok. Nunca confirme por conta própria.
Se o usuário pediu para criar ou apagar e você ainda não chamou a ferramenta, chame agora. Se não achar o evento para apagar, diga que não encontrou.
NOTION: use search_notion para achar páginas (ele só vê o que o usuário liberou: se vier vazio, diga para conferir as permissões da conexão), read_notion_page para ler e resumir, create_notion_page para criar uma página NOVA e append_notion_page para acrescentar no fim de uma existente.
Para criar, o Notion exige a página onde ela ficará: se o usuário não disse onde, chame search_notion e PERGUNTE qual das páginas usar (ou, se só houver uma opção clara, diga qual vai usar). Escreva o markdown completo (títulos, listas, tarefas, valores reais dos dados dele).
Só crie páginas DENTRO de páginas com pode_ser_pai=true: itens de um banco de dados (pode_ser_pai=false) não aceitam subpáginas. Se o usuário pedir uma que não aceita, explique em 1 frase e ofereça páginas que aceitam; se a ferramenta devolver erro, diga com clareza que NADA foi criado.
Se o pedido já traz o título e o lugar (ex.: "crie 'Meta de teste' dentro de Anderson Matheus, com um plano mês a mês"), CRIE DIRETO em vez de perguntar: faça suposições razoáveis (valores e prazos a partir dos dados financeiros dele que já estão acima), escreva o plano completo e, depois de criar, diga em 1 frase o que supôs e que ele pode pedir ajuste. Só pergunte se faltar o LOCAL da página.
Para montar o conteúdo de uma página, use os números dos dados financeiros que você já recebeu: NÃO chame as ferramentas show_* (blocos visuais) a menos que o usuário peça para ver os dados.
Nunca escreva "vou criar" ou "aguarde um instante" e termine a resposta: se for criar, chame a ferramenta AGORA, na mesma resposta, e só depois escreva o resultado.
Nunca apague nem reescreva páginas. Só diga que criou ou atualizou DEPOIS de a ferramenta responder ok.
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

// Google Calendar (via Composio): ver os compromissos e criar lembretes na agenda do próprio usuário
const calendarTools = [
  {
    type: 'function',
    function: {
      name: 'list_calendar_events',
      description: 'Lista os compromissos de TODAS as agendas do usuário entre duas datas (inclusive), em ordem.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Primeiro dia, AAAA-MM-DD' },
          to: { type: 'string', description: 'Último dia (inclusive), AAAA-MM-DD. Para um dia só, igual a from.' },
          reason: reasonParam,
        },
        required: ['from', 'to', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Cria um evento ou lembrete na agenda principal do usuário, só dele (sem convidados). Fácil de desfazer: pode criar direto quando o usuário pediu.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título curto. Para contas, inclua o valor (ex.: "Pagar fatura Nubank - R$ 507,91 (vence 09/11)")' },
          start: { type: 'string', description: 'Início, AAAA-MM-DDTHH:MM, horário de Brasília' },
          duration_minutes: { type: 'integer', description: 'Duração em minutos. Padrão 15.' },
          description: { type: 'string', description: 'Detalhes úteis (valores, vencimento, de onde vem a informação)' },
          reminders: { type: 'array', items: { type: 'integer' }, description: 'Avisos na tela, em minutos antes do início. Padrão [60, 0].' },
          meet: { type: 'boolean', description: 'true para criar também um link de videochamada do Google Meet no evento (reunião online). Só use quando o usuário pedir reunião/videochamada/Meet.' },
          reason: reasonParam,
        },
        required: ['title', 'start', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_calendar_event',
      description: 'Apaga um evento que você criou ou listou, quando o usuário pedir para desfazer ou apagar.',
      parameters: { type: 'object', properties: { event_id: { type: 'string' }, calendar_id: { type: 'string', description: 'calendarId do evento (padrão primary)' }, reason: reasonParam }, required: ['event_id', 'reason'] },
    },
  },
]

// Notion (via Composio): buscar, ler e criar páginas só nas páginas que o usuário liberou. Nunca apaga nem reescreve.
const notionTools = [
  {
    type: 'function',
    function: {
      name: 'search_notion',
      description: 'Procura páginas e bancos de dados do Notion pelo título. Query vazia lista os mais recentes. Só enxerga o que o usuário liberou ao conectar.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Parte do título (ex.: "metas"). Vazio para listar.' },
          kind: { type: 'string', enum: ['all', 'page', 'database'] },
          reason: reasonParam,
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_notion_page',
      description: 'Lê o conteúdo de uma página do Notion (em markdown) a partir do id devolvido por search_notion (use o campo id, não o título).',
      parameters: { type: 'object', properties: { page_id: { type: 'string', description: 'campo id da página em search_notion' }, reason: reasonParam }, required: ['page_id', 'reason'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_notion_page',
      description: 'Cria uma página NOVA no Notion, dentro de uma página ou banco de dados existente (parent_id). Nunca altera páginas que já existem.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          parent_id: { type: 'string', description: 'campo id da página ou do banco de dados onde a nova será criada (de search_notion), não o título' },
          markdown: { type: 'string', description: 'Conteúdo em markdown: títulos (##), listas (- ), tarefas (- [ ] ) e texto' },
          reason: reasonParam,
        },
        required: ['title', 'parent_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_notion_page',
      description: 'Acrescenta texto no fim de uma página existente do Notion, sem apagar nem reescrever o que já está lá. Use só quando o usuário pediu.',
      parameters: {
        type: 'object',
        properties: { page_id: { type: 'string', description: 'campo id da página em search_notion, não o título' }, title: { type: 'string', description: 'título da página, para mostrar ao usuário' }, text: { type: 'string', description: 'uma linha por bloco; use "## " para título, "- " para lista e "- [ ] " para tarefa' }, reason: reasonParam },
        required: ['page_id', 'text', 'reason'],
      },
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

// No WhatsApp só a agenda está liberada (e-mail fica no modo Computer do site): lembretes e compromissos por mensagem
const WHATSAPP_APPS_PROMPT = `AGENDA NO WHATSAPP: aqui você tem a agenda do usuário (list_calendar_events, create_calendar_event, delete_calendar_event), mas NÃO tem o Gmail.
Se ele pedir algo dos e-mails, diga em 1 frase que isso fica no modo Computer do site. O usuário não vê blocos visuais: ao criar ou listar, escreva na resposta o título, o dia da semana, a data e a hora,
em linhas curtas. Não tem botão Desfazer: para apagar, liste os compromissos do dia com list_calendar_events, ache o certo pelo título e use o id dele em delete_calendar_event; se houver dúvida entre dois, pergunte.
Se a agenda não estiver conectada, diga que a conexão é feita no site, em Minha conta, Apps, e peça para ele voltar depois.`

// Trava contra confirmação inventada: a IA às vezes escreve "lembrete criado" sem ter chamado a ferramenta
// também pega a promessa sem ação: "vou criar", "aguarde um instante enquanto crio"
const CLAIMS_CALENDAR_WRITE = /((vou|já vou|irei) (criar|montar|agendar|marcar|apagar|adicionar|acrescentar|registrar)|aguarde[^.]{0,40}(crio|monto|agendo|marco|acrescento|apago)|enquanto (crio|monto|agendo|marco|acrescento)|(criei|agendei|marquei|apaguei|removi|cancelei|exclu[ií])(?![a-zà-úç])|lembrete (agendado|criado)|evento (criado|agendado)|foi (removido|apagado|criado|agendado|marcado|exclu[ií]do)|já (foi|está) (removido|apagado|agendado|marcado))/i
// promessa sem ação ("vou criar", "aguarde enquanto crio"): aqui a ferramenta é FORÇADA, porque só pedir de novo o modelo ignora
const PROMISES_WRITE = /((vou|já vou|irei) (criar|montar|agendar|marcar|adicionar|acrescentar|registrar)|aguarde[^.]{0,40}(crio|monto|agendo|marco|acrescento)|enquanto (crio|monto|agendo|marco|acrescento))/i
const ASKS_WRITE = /(cri[ae]|marqu|agend|lembr|acrescent|adicion|anot|mont[ae]|fa[çc]a)/i
const MENTIONS_CALENDAR = /(lembrete|evento|agenda|reunião|reuniao|compromisso|notion|página|pagina)/i

// Fora do modo Computer a IA não tem as ferramentas de apps: precisa dizer isso, em vez de tentar ou fingir
const CHAT_MODE_PROMPT = `MODO: conversa normal. Aqui você NÃO tem acesso ao Gmail nem a outros apps conectados, só aos dados financeiros do Open Finance.
Se o usuário pedir algo que está nos e-mails ou em outro app (boletos por e-mail, recibos, faturas em PDF, agenda), diga em 1 ou 2 frases que isso fica no modo Computer: ele liga o botão
"Computer" (ao lado do +, na caixa de mensagem, no site) e pede de novo. Se der, responda a parte que os dados do banco permitem (por exemplo, a fatura do cartão e as parcelas), sem inventar o que só estaria no e-mail.
Não peça para conectar o Gmail nesta conversa e não diga que "não tem como": explique o caminho.`

export async function askWithWidgets(history, financialContext, fin, { channel = 'web', userId = null, mode = 'chat' } = {}) {
  if (!config.openai.apiKey) throw new HttpError(503, 'OpenAI não configurada (OPENAI_API_KEY)')
  // apps conectados (Gmail) só no modo Computer do site: no chat normal e no WhatsApp o assistente sabe que não os tem
  const appsAvailable = composioConfigured() && userId != null
  const gmailOn = appsAvailable && mode === 'computer' && channel === 'web' // e-mail: só no modo Computer do site
  const calendarOn = gmailOn || (appsAvailable && channel === 'whatsapp') // agenda: modo Computer do site e WhatsApp

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
  if (channel === 'whatsapp') messages.push({ role: 'system', content: WHATSAPP_PROMPT })
  if (composioConfigured() && !calendarOn) messages.push({ role: 'system', content: CHAT_MODE_PROMPT })
  if (appsAvailable && channel === 'whatsapp') messages.push({ role: 'system', content: WHATSAPP_APPS_PROMPT })
  if (calendarOn) {
    const now = new Date()
    const agora = now.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16)
    messages.push({ role: 'system', content: `Agora: ${agora} (horário de Brasília), ${now.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' })}.` })
  }
  if (financialContext) messages.push({ role: 'system', content: `Dados financeiros do usuário:
${financialContext}` })
  messages.push(...history)

  const widgets = []
  const agents = []
  const corrections = []
  let steps = 0
  // com o Gmail ligado a IA pode fazer várias buscas antes de responder
  const maxRounds = calendarOn ? 7 : 3
  let mailWidget = null
  let calendarWrote = false // criou ou apagou de verdade nesta resposta
  let nudges = 0
  let writeError = null // última falha de uma ação de escrita (criar/apagar) nesta resposta
  let forced = null // ferramenta que a próxima volta é obrigada a chamar

  for (let round = 0; round < maxRounds; round++) {
    const forceNow = forced
    forced = null
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.apiKey}` },
      body: JSON.stringify({
        model: config.openai.model,
        messages,
        temperature: 0.4,
        // na última volta a IA já tem os blocos e só precisa escrever
        ...(round < maxRounds - 1 ? { tools: [...(fin.accounts.length > 0 ? [...openAiTools, setCategoryTool] : []), createAgentTool, ...(gmailOn ? [...gmailTools, ...notionTools] : []), ...(calendarOn ? calendarTools : [])], ...(forceNow ? { tool_choice: { type: 'function', function: { name: forceNow } } } : {}) } : {}),
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
      if (calendarOn && !calendarWrote && nudges < 2 && agents.length === 0 && CLAIMS_CALENDAR_WRITE.test(reply) && MENTIONS_CALENDAR.test(reply)) {
        // disse que mexeu na agenda sem chamar a ferramenta: manda corrigir antes de o usuário acreditar
        nudges += 1
        const lastUser = String(history[history.length - 1]?.content ?? '')
        if (PROMISES_WRITE.test(reply) && ASKS_WRITE.test(lastUser) && !/apag|cancel|remov/i.test(lastUser)) {
          const notion = /notion|página|pagina/i.test(lastUser)
          if (notion && gmailOn) forced = /acrescent|adicion/i.test(lastUser) ? 'append_notion_page' : 'create_notion_page'
          else if (!notion) forced = 'create_calendar_event'
        }
        messages.push(message)
        messages.push({ role: 'system', content: 'ATENÇÃO: você escreveu que criou, agendou, apagou ou VAI fazer algo (agenda ou Notion), mas NÃO chamou a ferramenta. Chame agora a ferramenta certa (create_calendar_event, delete_calendar_event, create_notion_page ou append_notion_page; para apagar, liste antes e use o id certo). Se não for possível, diga com clareza que NÃO foi feito. Não responda de novo com promessa.' })
        continue
      }
      // a ação falhou e, mesmo assim, o texto diz que foi feita: troca por um aviso honesto
      if (writeError && !calendarWrote && CLAIMS_CALENDAR_WRITE.test(reply) && MENTIONS_CALENDAR.test(reply)) {
        return { reply: `Não consegui concluir isso: ${writeError}. Nada foi criado nem alterado.`, widgets, steps, agents, corrections }
      }
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
      if (call.function.name === 'list_calendar_events' || call.function.name === 'create_calendar_event' || call.function.name === 'delete_calendar_event') {
        let result
        try {
          if (call.function.name === 'list_calendar_events') result = await calendarEvents(userId, { from: args.from, to: args.to })
          else if (call.function.name === 'create_calendar_event') result = await createCalendarEvent(userId, { title: args.title, start: args.start, durationMinutes: args.duration_minutes, description: args.description, reminders: args.reminders, meet: args.meet })
          else result = await deleteCalendarEvent(userId, args.event_id, args.calendar_id)
        } catch (err) {
          console.error('[agenda]', err.message)
          if (call.function.name !== 'list_calendar_events') writeError = 'a agenda recusou o pedido'
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'A agenda recusou o pedido. NADA foi feito: diga isso ao usuário.' }) })
          continue
        }
        if (result.needsConnection) {
          if (channel === 'whatsapp') {
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ needs_connection: true, observacao: 'A agenda ainda não está conectada. A conexão só é feita no site: peça para abrir Minha conta, depois Apps, e conectar o Google Calendar.' }) })
          } else {
            if (!widgets.some((w) => w.type === 'connectApp' && w.app === 'googlecalendar')) widgets.push({ type: 'connectApp', title: 'Conectar o Google Calendar', app: 'googlecalendar', name: 'Google Calendar', reason: String(args.reason ?? 'para acessar a sua agenda').slice(0, 200) })
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ needs_connection: true, observacao: 'O usuário vê agora um cartão para autorizar o Google Calendar. Depois que ele autorizar, ele pede de novo.' }) })
          }
          continue
        }
        if (result.error) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: result.error }) })
          continue
        }
        if (result.events) {
          widgets.push({ type: 'calendarEvents', title: 'Compromissos na agenda', from: args.from, to: args.to, calendars: result.calendars, items: result.events.slice(0, 30), count: result.events.length })
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, agendas_consultadas: result.calendars, agendas_com_falha: result.failed, eventos: result.events, observacao: result.events.length === 0 ? 'Nenhum compromisso nesse período.' : undefined }) })
        } else if (result.event) {
          calendarWrote = true
          widgets.push({ type: 'calendarEvent', title: 'Evento criado na agenda', event: result.event })
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, criado: result.event }) })
        } else {
          calendarWrote = true
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, apagado: true }) })
        }
        continue
      }
      if (['search_notion', 'read_notion_page', 'create_notion_page', 'append_notion_page'].includes(call.function.name)) {
        let result
        try {
          if (call.function.name === 'search_notion') result = await searchNotion(userId, { query: args.query, kind: args.kind })
          else if (call.function.name === 'read_notion_page') result = await readNotionPage(userId, args.page_id)
          else if (call.function.name === 'create_notion_page') result = await createNotionPage(userId, { parentId: args.parent_id, title: args.title, markdown: args.markdown })
          else result = await appendNotionPage(userId, { pageId: args.page_id, text: args.text, title: args.title })
        } catch (err) {
          console.error('[notion]', err.message)
          if (call.function.name === 'create_notion_page' || call.function.name === 'append_notion_page') writeError = 'o Notion recusou o pedido'
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'O Notion recusou o pedido. NADA foi criado: diga isso ao usuário.' }) })
          continue
        }
        if (result.needsConnection) {
          if (!widgets.some((w) => w.type === 'connectApp' && w.app === 'notion')) widgets.push({ type: 'connectApp', title: 'Conectar o Notion', app: 'notion', name: 'Notion', reason: String(args.reason ?? 'para acessar as suas páginas').slice(0, 200) })
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ needs_connection: true, observacao: 'O usuário vê agora um cartão para autorizar o Notion. Depois que ele autorizar, ele pede de novo.' }) })
          continue
        }
        if (result.error) {
          if (call.function.name === 'create_notion_page' || call.function.name === 'append_notion_page') writeError = result.error
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: result.error }) })
          continue
        }
        if (result.pages) {
          widgets.push({ type: 'notionPages', title: 'Páginas no Notion', count: result.pages.length, more: Boolean(result.more), items: result.pages })
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, paginas: result.pages.map((p) => ({ ...p, pode_ser_pai: p.parentType !== 'database_id' })), mais_paginas_alem_destas: Boolean(result.more), observacao: result.pages.length === 0 ? 'Nada encontrado. O Notion só mostra o que o usuário liberou ao conectar: peça para conferir as permissões da conexão.' : undefined }) })
        } else if (result.page) {
          calendarWrote = true
          widgets.push({ type: 'notionPage', title: result.page.action === 'updated' ? 'Página atualizada no Notion' : 'Página criada no Notion', page: result.page })
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, pagina: result.page }) })
        } else {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, conteudo_markdown: result.markdown, cortado: result.truncated, observacao: result.truncated ? 'A página é maior que o limite: você leu só o começo. Diga isso ao usuário.' : 'Você leu a página INTEIRA. Ao resumir, passe por TODAS as seções (cada título #) em ordem, sem parar nas primeiras, e cite números e nomes que estão lá.' }) })
        }
        continue
      }
      const { widgets: built, summary } = runTool(call.function.name, args, fin)
      widgets.push(...built)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(summary) })
    }
  }
  throw new HttpError(502, 'O assistente não conseguiu responder agora. Tente de novo')
}
