#!/bin/bash

# Script para exportar o banco de dados do Supabase Cloud
# Requer postgresql-client instalado locally

# Carregar variáveis de ambiente se necessário
# source .env

# Substitua pelas suas credenciais do Supabase Cloud (Settings > Database)
DB_HOST="db.diutmgiuipjskzcpvxam.supabase.co"
DB_NAME="postgres"
DB_USER="postgres"
DB_PORT="5432"

echo "🐘 Iniciando exportação do banco de dados Supabase Cloud..."

# Exportar apenas o esquema public e auth (essencial)
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --schema=public \
    --schema=auth \
    --no-owner --no-acl \
    > supabase_backup_$(date +%Y%m%d).sql

if [ $? -eq 0 ]; then
    echo "✅ Exportação concluída com sucesso: supabase_backup_$(date +%Y%m%d).sql"
else
    echo "❌ Erro na exportação. Verifique se o IP da sua máquina está na allowlist do Supabase."
fi
