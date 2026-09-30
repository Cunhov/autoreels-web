-- FIX-M5: contador de tentativas por enrollment (evita retry infinito de sequência)
ALTER TABLE "ig_sequence_enrollments" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
