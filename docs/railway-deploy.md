# Railway Deploy

O projeto ja esta pronto para subir no Railway usando o `Dockerfile` atual.

## O que subir

- 1 servico da aplicacao usando este repositorio
- 1 banco PostgreSQL gerenciado no mesmo projeto Railway

## Variaveis recomendadas no Railway

Use como base o arquivo [`.env.railway.example`](c:/Projetos/ai-pr-automation/.env.railway.example).

Obrigatorias:

- `DATABASE_URL`
- `APP_BASE_URL`
- `GITHUB_TOKEN`
- `OPENAI_API_KEY`
- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`

Importantes:

- `PORT=9010`
- `NODE_ENV=production`
- `EXECUTION_PROVIDER=codex`
- `SLACK_WEBHOOK_URL`
- `JIRA_AI_AGENT_STATUS_NAME=AI Agent`

## Checklist do Railway

1. Criar um novo projeto no Railway.
2. Adicionar um banco `PostgreSQL`.
3. Criar um servico a partir deste repositorio GitHub.
4. Garantir que o Railway use o `Dockerfile` do projeto.
5. Preencher as variaveis de ambiente.
6. Copiar a URL publica gerada pelo Railway.
7. Configurar `APP_BASE_URL` com essa URL.
8. Fazer um novo deploy para a aplicacao ler a URL final.
9. Testar `GET /health`.

Exemplo:

- `APP_BASE_URL=https://ai-pr-automation-production.up.railway.app`
- healthcheck: `https://ai-pr-automation-production.up.railway.app/health`

## Checklist do webhook no Jira

Depois que a URL publica estiver pronta:

1. Abrir a configuracao de webhooks do Jira.
2. Criar um webhook apontando para:
   `https://<seu-dominio-publico>/jira/webhook`
3. Assinar pelo menos estes eventos:
   - issue created
   - issue updated
4. Se quiser reduzir ruido, limitar por projeto `SCRUM`.
5. Criar uma task com `@agent` ou `ai-agent`.
6. Confirmar se o job aparece em `GET /agent-jobs`.

## Observacoes para a POC

- O app continua ouvindo em `PORT`, entao o Railway pode sobrescrever esse valor sem problema.
- O `Dockerfile` ja roda `prisma migrate deploy` antes de subir a API.
- O clone dos repositorios continua acontecendo em workspace temporario dentro do container.
- Para a POC, API e execucao podem ficar juntas no mesmo servico.
