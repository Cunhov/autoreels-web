-- AlterTable: add proxy per channel (HTTP/HTTPS)
ALTER TABLE "channels" ADD COLUMN "proxy_url" TEXT;
ALTER TABLE "channels" ADD COLUMN "proxy_enabled" BOOLEAN DEFAULT true;
