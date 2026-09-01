-- Migration 0014_add_first_comment — F4: primeiro comentário por item de biblioteca.
--
-- Decisão do dono: o campo first_comment vive no ContentItem (library). O YouTube
-- publica o comentário AUTOMATICAMENTE após o Short; IG/TikTok apenas salvam o
-- texto (sem API oficial de comentário). O publisher consome `post.first_comment`,
-- então a criação do post (buildPostData) faz um SNAPSHOT do campo do item para a
-- row do Post — por isso a coluna posts.first_comment existe também (additive,
-- espelha o padrão das captions por plataforma 0009/0012).
ALTER TABLE "content_items" ADD COLUMN "first_comment" TEXT;
ALTER TABLE "posts" ADD COLUMN "first_comment" TEXT;