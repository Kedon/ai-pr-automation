# AI PR Automation

Projeto para orquestrar agentes autônomos que recebem tarefas do Jira, pedem autorização via Slack, executam mudanças em repositórios Git com segurança, criam uma branch `ai/<ticket>-<slug>` e abrem um Pull Request obrigatoriamente para revisão humana.

## Objetivo

Criar uma base escalável para automação de tarefas de engenharia com estas regras iniciais:

- Fonte de tarefas: Jira
- Gatilho: label `ai-agent` ou menção `@agent`
- Branch obrigatória: `ai/<ticket>-<slug>`
- PR obrigatória ao final da execução
- Aprovação sempre humana
- Proibição total de operar na branch principal
- Resumo final com link da PR

## Premissas de produto

O primeiro corte do sistema deve priorizar segurança, auditabilidade e baixo custo de manutenção. O agente não deve "aprender" continuamente nem depender de treinamento fino. A inteligência deve vir de:

- regras determinísticas de elegibilidade
- prompts controlados
- contexto do repositório
- integrações simples e observáveis

## Arquitetura Recomendada

### 1. Jira Adapter

Responsável por:

- receber webhooks do Jira
- identificar tickets com label `ai-agent` ou `@agent`
- extrair metadados do ticket
- resolver qual repositório Git está vinculado ao projeto do Jira

### 2. Orchestrator API

Responsável por:

- validar elegibilidade da tarefa
- impedir execuções duplicadas
- persistir jobs e estados
- solicitar aprovação no Slack
- despachar execução para um worker

### 3. Worker de Execução

Responsável por:

- clonar ou atualizar o repositório correto
- garantir que nunca está operando em `main` ou equivalente
- criar a branch `ai/<ticket>-<slug>`
- executar o agente com contexto controlado
- rodar validações
- criar commit, push e Pull Request

### 4. Slack Adapter

Responsável por:

- enviar solicitação de aprovação
- informar início de execução
- informar conclusão
- devolver link da PR e resumo técnico

### 5. Git Provider Adapter

Responsável por:

- criar branch
- fazer push
- abrir Pull Request
- aplicar regras de segurança

### 6. Config Service

Responsável por mapear:

- projeto Jira -> repositório Git
- projeto Jira -> regras de execução
- projeto Jira -> canal do Slack
- projeto Jira -> branch base padrão

## Stack Recomendada

### Linguagem e runtime

- `TypeScript`
- `Node.js`

Motivos:

- excelente suporte a APIs e SDKs de Jira, Slack e GitHub
- baixo atrito para montar webhooks e workers
- tipagem ajuda bastante num sistema de integrações
- boa disponibilidade de desenvolvedores e manutenção simples

### API e orquestração

- `NestJS` ou `Fastify`

Recomendação:

- usar `NestJS` se você quiser uma estrutura mais opinativa desde o início
- usar `Fastify` se quiser algo mais enxuto

Para este projeto, eu recomendo `NestJS`, porque a separação entre módulos de integração, domínio e workers ajuda quando o sistema crescer para vários projetos e times.

### Banco de dados

- `PostgreSQL`

Motivos:

- confiável
- excelente para jobs, auditoria e histórico
- facilita subir de MVP para ambiente corporativo sem retrabalho

### Fila

- `Redis` + `BullMQ`

Motivos:

- boa separação entre API e execução
- reprocessamento simples
- controle de concorrência
- agendamento e retries

### Execução do agente

- worker Node.js
- execução de comandos em diretório isolado por job
- Git via CLI nativa

Motivos:

- Git pela CLI é mais previsível que abstrações incompletas
- isolar cada job reduz risco de contaminação entre execuções

### LLM / agente

- modelo de uso geral via API
- sem fine-tuning
- prompts versionados no repositório
- saída estruturada em JSON quando possível

Motivos:

- menor manutenção
- maior previsibilidade
- fácil trocar modelo no futuro

### Observabilidade

- logs estruturados com `Pino`
- monitoramento de erros com `Sentry`
- métricas opcionais com `Prometheus` depois

## Serviços Externos Recomendados

### Jira Cloud

Usar como fonte principal do MVP.

Necessidades:

- webhook de issue criada/atualizada
- leitura de labels, descrição, comentários e status
- campo ou convenção para mapear projeto ao Git

### Slack

Usar para:

- pedir autorização
- informar progresso
- devolver link da PR e resumo final

### GitHub

Usar inicialmente com conta pessoal e repositórios privados.

Necessidades:

- token com escopo restrito
- criação de branch
- push
- criação de PR
- branch protection na `main`

## Regra de Ouro de Segurança

O sistema nunca deve editar, commitar, fazer push ou abrir PR diretamente na branch principal.

Regras práticas:

- o worker sempre faz checkout da branch base apenas para leitura
- toda alteração acontece em branch `ai/<ticket>-<slug>`
- o PR sempre aponta para a branch base configurada
- `main` deve ter branch protection no GitHub
- o código deve abortar a execução se detectar tentativa de operar direto na branch protegida

## Como vincular Jira ao projeto Git

Esse vínculo é obrigatório para escalar o sistema para vários projetos.

### Opção recomendada para o MVP

Criar uma tabela de configuração no sistema:

- `jira_project_key`
- `repository_owner`
- `repository_name`
- `default_base_branch`
- `slack_channel`
- `enabled`

Exemplo:

- `APP` -> `seu-user/app-frontend` -> `main` -> `#ai-agents-app`
- `API` -> `seu-user/platform-api` -> `main` -> `#ai-agents-api`

Quando um ticket chegar do Jira, o sistema lê a chave do projeto e resolve automaticamente:

- qual repositório usar
- qual branch base usar
- para qual canal do Slack avisar

### Alternativas futuras

- custom field no Jira com URL do repositório
- componente do Jira mapeando para serviço
- integração com catálogo interno da empresa

Para começar, a tabela de mapeamento é a solução mais simples e mais estável.

## Critérios de elegibilidade do agente

Antes de executar, o sistema deve classificar a tarefa.

Critérios iniciais:

- possui `ai-agent` ou `@agent`
- projeto Jira está habilitado
- ticket tem descrição mínima
- ticket está em status permitido
- repositório alvo está mapeado
- não existe execução ativa para o mesmo ticket

Critérios de bloqueio:

- ticket sem contexto suficiente
- dependência explícita de decisão humana
- tarefa marcada como sensível
- projeto sem mapeamento Git

## Fluxo do MVP

1. Jira dispara webhook.
2. API valida se o ticket tem `ai-agent` ou `@agent`.
3. Sistema resolve o repositório a partir do projeto Jira.
4. Sistema cria um job pendente.
5. Slack recebe pedido de autorização.
6. Humano aprova.
7. Worker clona repo e cria branch `ai/<ticket>-<slug>`.
8. Agente executa a tarefa.
9. Worker roda validações mínimas.
10. Worker faz commit, push e abre PR.
11. Slack recebe link da PR e resumo final.

## Tecnologias que eu escolheria agora

- API: `NestJS`
- Banco: `PostgreSQL`
- Fila: `Redis` + `BullMQ`
- ORM: `Prisma`
- Logs: `Pino`
- Erros: `Sentry`
- HTTP client: `undici`
- Validação: `zod`
- GitHub: API oficial + `git` via CLI
- Deploy inicial: `Railway`, `Render` ou `Fly.io`

## Deploy e operação no MVP

Para começar com pouca manutenção:

- API e worker no mesmo provedor
- PostgreSQL gerenciado
- Redis gerenciado
- secrets em cofre do provedor

Se quiser minimizar ainda mais a operação, `Railway` costuma ser uma boa escolha para MVPs com Node, Postgres e Redis.

## O que evitar no início

- múltiplos provedores de task ao mesmo tempo
- fine-tuning de modelos
- memória persistente "inteligente" do agente
- autonomia total sem aprovação humana
- execução em múltiplos repositórios sem mapeamento explícito

## Roadmap sugerido

### Fase 1

- Jira
- Slack
- GitHub
- mapeamento projeto Jira -> repositório Git
- branch `ai/<ticket>-<slug>`
- PR obrigatória
- aprovação humana obrigatória

### Fase 2

- classificação automática melhorada
- templates de PR e resumo
- execução por projeto com políticas diferentes
- suporte a comentários no Jira com status do job

### Fase 3

- múltiplos repositórios por projeto
- Basecamp ou outro provedor de task
- políticas corporativas e SSO
- catálogo central de projetos

## Decisões iniciais recomendadas

- Começar com `Jira + Slack + GitHub`
- Fazer o vínculo `Jira project key -> repositório Git` dentro do sistema
- Exigir aprovação humana via Slack antes da execução
- Exigir PR obrigatória sempre
- Bloquear qualquer ação direta na branch principal
- Manter o agente stateless e sem necessidade de treinamento contínuo

## Próximos passos

1. Scaffold do monorepo com API, worker e packages compartilhados.
2. Modelagem do banco para projetos, jobs, aprovações e execuções.
3. Implementação do webhook do Jira.
4. Implementação do fluxo de aprovação no Slack.
5. Implementação do executor Git com criação de branch e PR.

## Ambiente local com Docker

O projeto já está preparado para rodar localmente com Docker Compose.

Portas reservadas:

- API: `9010`
- PostgreSQL: `9011`

Variáveis úteis:

- `APP_BASE_URL=http://localhost:9010`
- `SLACK_WEBHOOK_URL=<incoming-webhook-url>`
- `GITHUB_TOKEN=<github-personal-access-token>`
- `GIT_AUTHOR_NAME=AI PR Automation`
- `GIT_AUTHOR_EMAIL=ai-pr-automation@example.com`
- `EXECUTION_PROVIDER=bootstrap`
- `OPENAI_API_KEY=<platform-api-key>`
- `OPENAI_CODEX_MODEL=gpt-5.2-codex`
- `OPENAI_CODEX_REASONING_EFFORT=medium`
- `JIRA_BASE_URL=https://seu-dominio.atlassian.net`
- `JIRA_EMAIL=seu-email`
- `JIRA_API_TOKEN=seu-token`
- `JIRA_AI_AGENT_STATUS_NAME=AI Agent`

### Subir o ambiente

1. Copie `.env.example` para `.env` se quiser personalizar variáveis locais.
2. Rode `docker compose up --build`.
3. Acesse `http://localhost:9010/health`.

### Primeiro schema do banco

O schema inicial já cobre:

- mapeamento `Jira project key -> repositório Git`
- jobs do agente
- status de execução
- branch e URL da PR

### Próxima etapa sugerida

Implementar os módulos:

- `jira`
- `slack`
- `github`
- `project-config`
- `agent-jobs`

## Endpoints iniciais

### Health

- `GET /health`

### Configuração de projetos

- `POST /project-configs`
- `GET /project-configs`
- `GET /project-configs/:jiraProjectKey`

Payload de exemplo:

```json
{
  "jiraProjectKey": "APP",
  "repositoryOwner": "seu-user",
  "repositoryName": "app-frontend",
  "defaultBaseBranch": "main",
  "slackChannel": "#ai-agents-app",
  "enabled": true
}
```

### Jobs do agente

- `GET /agent-jobs`
- `GET /agent-jobs/:jobId`

### Webhook do Jira

- `POST /jira/webhook`

### Integração ativa com Jira Cloud

- `GET /jira/connection`
- `GET /jira/projects`
- `GET /jira/issues/eligible`
- `GET /jira/issues/eligible?projectKey=APP`
- `GET /jira/issues/:issueKey/transitions`
- `POST /jira/issues/:issueKey/move-to-ai-agent`
- `POST /jira/issues/:issueKey/enqueue`

O webhook já:

- valida projeto Jira mapeado
- detecta `label ai-agent`
- detecta menção `@agent` na descrição
- cria `AgentJob` em `queued`
- gera branch no padrão `ai/<ticket>-<slug>`
- move a issue para `AI Agent` quando possível
- envia mensagem ao Slack quando inicia, quando cria PR e quando falha
- executa o fluxo de Git sem aprovação prévia

## Jira Cloud no MVP

A integração ativa do Jira usa:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`

Fluxos já suportados:

- validar autenticação com a instância real
- listar projetos acessíveis
- buscar issues elegíveis com `label ai-agent` ou `@agent`
- consultar transições disponíveis de uma issue
- tentar mover a issue para a coluna/status `AI Agent`
- enfileirar manualmente uma issue real do Jira no fluxo local

## Notificações via Slack no MVP

Neste primeiro corte, o Slack usa `Incoming Webhook`.

Eventos enviados:

- início da execução
- PR pronta
- falha da tarefa

## Execução GitHub no MVP

Quando um job entra em execução com `EXECUTION_PROVIDER=bootstrap`:

- o sistema clona o repositório privado configurado
- faz checkout somente de leitura da branch base
- cria a branch `ai/<ticket>-<slug>`
- grava um artefato controlado em `.ai-pr-automation/jobs/<ticket>.md`
- cria commit e push na branch `ai/...`
- abre uma Pull Request obrigatória para revisão humana

Regras mantidas:

- nunca opera direto em `main`, `master`, `trunk` ou na branch base protegida
- falha se a branch não começar com `ai/`
- sempre exige `GITHUB_TOKEN`

Observação:

Nesta fase, a PR gerada é de bootstrap. Ela valida o fluxo de GitHub com segurança antes de conectarmos a camada que altera código real de forma autônoma.

## Preparação para Codex

O projeto agora já separa:

- `orquestrador`
- `provedor de execução`

Isso permite trocar o executor atual por um provedor real do Codex sem refazer Jira, Slack, GitHub e ciclo de jobs.

Opções atuais:

- `EXECUTION_PROVIDER=bootstrap`
- `EXECUTION_PROVIDER=codex`

No modo `codex`, o projeto usa um placeholder que ainda precisa ser ligado ao SDK real.

Agora o provedor `codex` já usa o SDK oficial da OpenAI para fazer a analise inicial da tarefa. O que ainda falta e sera a proxima etapa e o handoff do workspace Git para que o Codex consiga editar arquivos, rodar testes e abrir a PR diretamente.

O handoff inicial do workspace agora inclui:

- clone isolado do repositório
- checkout da branch `ai/...` ou criação a partir da base
- lista de arquivos versionados
- `package.json`
- `README`

O próximo passo depois disso será permitir que o Codex altere o workspace e rode comandos de validação.
