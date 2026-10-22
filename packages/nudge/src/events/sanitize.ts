const NUL = '\u0000';

// Postgres text and jsonb reject U+0000 and lone surrogates; one such forged value would fail a whole batch.
export function sanitizeText(text: string): string {
  return text.replaceAll(NUL, '').toWellFormed();
}
