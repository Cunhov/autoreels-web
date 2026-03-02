# PRD: Migração do Supabase para SQLite + Prisma + NextAuth

## Overview
Converter o projeto AutoReels para suportar implantação independente e escalável em qualquer VPS sem a necessidade de infraestrutura pesada. O banco de dados passará a ser SQLite (gerenciado pelo Prisma), a autenticação por NextAuth.js e os uploads/arquivos de mídia serão gerenciados localmente no sistema de arquivos da VPS.

**CONSTRAINTS DE SEGURANÇA (CRÍTICO):** 
1. Todo o trabalho **DEVE SER FEITO OBRIGATORIAMENTE na branch atual (`database-migration`)**. 
2. Você está PROIBIDO de fazer `git checkout main` ou qualquer operação de merge com a `main`. A branch `main` deve permanecer intocada e funcional com o código atual do Supabase. Apenas faça commits na branch atual.

## Task 1: Instalação de Dependências e Setup do Prisma
Remover as dependências do ecossistema antigo e instalar as ferramentas da nova arquitetura.
- Desinstalar pacotes do Supabase (`@supabase/supabase-js`, `@supabase/auth-helpers-nextjs`, `@supabase/auth-helpers-react`, `@supabase/auth-ui-react`, `@supabase/auth-ui-shared`).
- Instalar dependências essenciais: `prisma` (dev), `@prisma/client`, `next-auth` (v4 ou v5 dependendo do padrão adotado), e pacotes para parsing de arquivos em node caso necessário (ex: `formidable`).
- Executar a inicialização do Prisma com SQLite: `npx prisma init --datasource-provider sqlite`.
- Configurar o `.env` com a conexão para o arquivo local (ex: `DATABASE_URL="file:./dev.db"`).

## Task 2: Modelagem do Esquema Prisma
Traduzir as tabelas SQL mapeadas da nuvem para o `schema.prisma`.
- Criar os modelos base do NextAuth: `User`, `Account`, `Session`, `VerificationToken`.
- Migrar tabela `app_config` -> Model `AppConfig`.
- Migrar tabela `channels` -> Model `Channel`.
- Migrar tabela `planners` e `planner_logs` -> Model `Planner` e `PlannerLog`.
- Migrar tabela `content_items` -> Model `ContentItem`.
- Migrar tabela `posts` -> Model `Post` (configurar devidamente as relações com User e Channel).
- Migrar tabela `analytics` -> Model `Analytics`.
- Executar `npx prisma db push` (ou `migrate dev`) para validar e criar a base de desenvolvimento sqlite.

## Task 3: Configuração de Autenticação (NextAuth)
Trocar as rotas e ganchos do Supabase Auth para NextAuth.
- Configurar a rota de autenticação central do Next.js (ex: `app/api/auth/[...nextauth]/route.ts`) utilizando o provedor escolhido (Credentials ou Google) juntamente com o `PrismaAdapter`.
- Remover o `middleware.ts` do Supabase e substitui-lo por regras no middleware do NextAuth.
- Atualizar componentes de login e logout no Frontend, utilizando `signIn` e `signOut` do NextAuth, além do `useSession`.

## Task 4: Criação do Sistema de Uploads Local (File System)
Substituir a dependência do `supabase.storage` por um mecanismo simples e local.
- Criar o diretório raiz `/public/uploads`.
- Criar rota de API para gerenciar o upload de imagens e vídeos: `POST app/api/upload/route.ts`.
- Garantir que essa rota leia os dados de `multipart/form-data`, grave-os em `/public/uploads/` e retorne um caminho relativo (ex: `/uploads/file.mp4`) para o frontend.
- Refatorar qualquer componente React que enviava os dados (ex: Media Library) chamando a nova rota local com `fetch`.

## Task 5: Refatoração de Consultas no Backend (CRUD para Prisma) - P1
Migrar o acesso de dados de chamadas `.from('table').select()` para o `PrismaClient`. Parte focada em canais e postagens.
- Substituir consultas do Supabase referentes à tabela `channels` para a nova infraestrutura.
- Substituir comandos de manipulação (CRUD) referentes aos `posts` e `analytics`.
- Corrigir todas as injeções de cliente dependentes do `lib/supabase.ts` nesses módulos.

## Task 6: Refatoração de Consultas no Backend (CRUD para Prisma) - P2
Migrar as tabelas de gerenciamento de planners, configurações e media library.
- Substituir código de CRUD das rotas/componentes de `planners` e `planner_logs`.
- Substituir chamadas ao servidor para ler o `app_config`.
- Substituir acesso e manipulação na galeria/mídia que operava sobre `content_items`.

## Task 7: Build, Dockerização e Limpeza Final
Deixar a aplicação em estado estrito de produção.
- Limpar todo código órfão em `lib/supabase.ts` e configurações antigas como `supabase/`.
- Atualizar e testar o `Dockerfile` com os comandos essenciais para a nova realidade (instalar as dependências + compilar o cliente prisma no build step + rodar o `next start`).
- Executar um pipeline final de `npm run build` visualizando se não restaram erros de tipagem no lado do servidor e cliente.
