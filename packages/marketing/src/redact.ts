const REDACTED = '[redacted]';
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER = /(Bearer\s+)[^\s"',;]+/gi;
const PRIVATE_KEY_VALUE =
  /("?private_key"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\s,}]+)/gi;

function toText(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof Error) {
    return `${input.name}: ${input.message}`;
  }
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

export function redactSecrets(input: unknown, secrets: string[]): string {
  let text = toText(input)
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(PRIVATE_KEY_VALUE, `$1${REDACTED}`);
  for (const secret of secrets) {
    if (secret) {
      text = text.replaceAll(secret, REDACTED);
    }
  }
  return text;
}
