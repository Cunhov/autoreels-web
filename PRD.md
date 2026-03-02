# PRD: Migração do Supabase para SQLite + Prisma + NextAuth

## Overview
Converter o projeto AutoReels para suportar implantação independente e escalável em qualquer VPS sem a necessidade de infraestrutura pesada. O banco de dados passará a ser SQLite (gerenciado pelo Prisma), a autenticação por NextAuth.js e os uploads/arquivos de mídia serão gerenciados localmente no sistema de arquivos da VPS. O objetivo final é ter um projeto "clone and run".

**CONSTRAINTS DE SEGURANÇA (CRÍTICO):** 
1. Todo o trabalho **DEVE SER FEITO OBRIGATORIAMENTE na branch atual (`database-migration`)**. 
2. Você está PROIBIDO de fazer `git checkout main` ou qualquer operação de merge com a `main`. A branch `main` deve permanecer intocada e funcional.
3. Se você quebrar a aplicação durante o processo, use o log de versionamento para reverter o arquivo modificado (`git restore <arquivo>`). Cuidado extremo ao lidar com `lib/supabase.ts`. 

---

## Task 1: Instalação de Dependências e Setup do Prisma
**Objetivo:** Remover as dependências do ecossistema antigo, instalar as ferramentas da nova arquitetura e inicializar o banco SQLite.
1. Execute `npm uninstall @supabase/supabase-js @supabase/auth-helpers-nextjs @supabase/auth-helpers-react @supabase/auth-ui-react @supabase/auth-ui-shared`.
2. Execute `npm install prisma -D` e `npm install @prisma/client next-auth uuid`.
3. Execute a inicialização do Prisma com SQLite: `npx prisma init --datasource-provider sqlite`.
4. Atualize o `.env` (ou `.env.local` se existir) garantindo que contenha: `DATABASE_URL="file:./dev.db"` e `NEXTAUTH_SECRET="uma_string_base64_qualquer"` (pode gerar via node crypto).
5. **Verificação:** Rodar `npx prisma -v` deve exibir as versões do Prisma sem erros.

## Task 2: Modelagem do Esquema Prisma (`prisma/schema.prisma`)
**Objetivo:** Traduzir estritamente as tabelas SQL originais para modelos do Prisma.
1. Crie os modelos base do NextAuth (obrigatórios segundo a documentação oficial para uso com Prisma Adapter): `User`, `Account`, `Session`, `VerificationToken`. 
2. Modele a tabela `AppConfig` (antiga `app_config`): Campos `key` (String @id) e `value` (String?).
3. Modele a tabela `Channel` (antiga `channels`): Campos `id` (String @id @default(uuid())), `userId` (relação com User), `name`, `platform`, `accessToken`, `accountId`, `status`, `createdAt`.
4. Modele as tabelas `Planner` e `PlannerLog` com suas devidas tipagens, e relacione Planner com User.
5. Modele a tabela `ContentItem` (antiga `content_items`): Campos para arquivos (`type`, `url`, `path`, `name`, `size`, `duration`, etc).
6. Modele a tabela `Post` (antiga `posts`): Campos como `videoUrl`, `caption`, `status`, e relações com `User` e `Channel`.
7. Execute `npx prisma db push` para aplicar esse modelo e criar o arquivo `dev.db`.
8. **Verificação:** Verifique a existência de um arquivo `dev.db` na raiz da pasta `prisma/`.

## Task 3: Configuração de Autenticação (NextAuth) e Remoção de Auth Middleware
**Objetivo:** Substituir as funções do Supabase Auth pelo NextAuth.
1. Crie o arquivo handler do NextAuth em `app/api/auth/[...nextauth]/route.ts`. 
2. Configure o `route.ts` usando `PrismaAdapter(prisma)` e adicione o `CredentialsProvider` (para simular login via email/senha, caso necessário, crie lógica dummy bcrypt ou plaintext SE para teste, OR apenas use OAuth como Providers.Google).
3. Se existir um arquivo `middleware.ts` na raiz, remova qualquer lógica importada de `@supabase` e utilize o `withAuth` do `next-auth/middleware`.
4. Atualize os utilitários de cliente (ex: `app/login/page.tsx`, `components/auth` ou similares). Substitua componentes Supabase AuthUI por botoes simples chamando a funcão estendida `signIn()` importada de `next-auth/react`. Considere criar um `<SessionProvider>` global em `app/layout.tsx`.
5. **Verificação:** Faça um script testando se o servidor next sobe e a rota HTTP GET para `/api/auth/providers` retorna `{}` ou os providers registrados.

## Task 4: Criação do Sistema de Uploads Local (File System)
**Objetivo:** Substituir a dependência do Storage do Supabase por um mecanismo nativo dentro do host.
1. Crie o diretório raiz `/public/uploads` para testes de desenvolvimento. (Garantir no `.gitignore` que o conteúdo da pasta não suba pro git).
2. Crie a estrutura lógica de API de Node para uploads (Exemplo: crie `app/api/upload/route.ts`).
3. Implemente no `route.ts` leitura FormData de uma chave `file`, salvando via `fs.writeFile` em `public/uploads/{uuid}-{filename}`. Retorne `{ url: '/uploads/{filename}' }`.
4. Identifique todos os componentes front-end que realizavam manipulação de storage via Supabase (geralmente nos recursos de vídeo/imagem, `lib/supabase.ts` possivelmente expunha `supabase.storage.from`).
5. Redirecione os métodos de Client upload para realizar requisições convencionais `POST /api/upload`.
6. **Verificação:** Assegure-se de que testes enviando FormData local resultem em mídia efetivamente aparecendo em `public/uploads/`.

## Task 5: Refatoração do Código Dependente do Banco de Dados - Tabelas Clássicas
**Objetivo:** Refatorar todos os arquivos utilizando as antigas consultas PostgreSQL para a sintaxe ORM do Prisma.
1. Use ferramentas de busca no VSCode (ou CLI como `grep -ri "supabase.from" app/`) para listar interações antigas com banco.
2. Crie uma abstração ou apenas use injeções limpas de `const prisma = new PrismaClient()` nos arquivos Server e API Routes que fazem as chamadas para as tabelas `posts`, `channels` e `analytics`.
3. Substituir inserções: `supabase.from('posts').insert(x)` por `prisma.post.create({ data: x })`.
4. Substituir leituras: `supabase.from('channels').select('*')` por `prisma.channel.findMany()`.
5. Substitua todos os getters focados em obter sessão estritamente: `await supabase.auth.getSession()` pelo `await getServerSession(authOptions)`.

## Task 6: Refatoração do Código Dependente do Banco de Dados - Módulos Adicionais e Limpeza
**Objetivo:** Extirpar inteiramente todas as linhas restantes relacionadas ao Supabase.
1. Refatore operações pendentes de leitura/escrita relativas a `planners`, `planner_logs`, `app_config` e `content_items` invocando a API do Prisma.
2. Identifique quais referências globais dependem ainda do cliente exportado em `lib/supabase.ts` ou arquivos parecidos. Exclua as menções antigas a variáveis de ambiente preexistentes na nuvem.
3. Se um cliente Supabase for criado na renderização de Server Components ou Cliente (com hooks nativos do Supabase Auth Helpers), apague essas chamadas inteiras. A página e Layouts deverão confiar em `<SessionProvider>` de `next-auth/react`.

## Task 7: Build, Testes e Documentação
**Objetivo:** Deixar a aplicação pronta para rodar como produção local de maneira escalada em VPS através de contêineres e um novo Build de sucesso.
1. O Dockerfile precisa ser alterado para o novo workflow: no build step deverá executar `npx prisma generate` além da cópia padrão.
2. Execute localmente o `npm run build` na plataforma dev para auditar as checagens rigorosas de tipos e páginas (App Router) construídas com as novas tipagens de Prisma.
3. Excluir com segurança as pastas órfãs (ex: a suposta pasta antiga de referencial de deploy/migrações do Supabase, exceto o seu novo `.env`).
4. **Verificação Crítica Final:** O App não deve possuir nenhum arquivo referenciando pacote do `@supabase` ou strings na pasta `app/**/*`.
