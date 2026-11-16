import { hkdfSync } from 'node:crypto';

const KEY_BYTES = 32;
const LINK_INFO = 'marketing-link-v1';
const WEBHOOK_INFO = 'marketing-msg91-webhook-v1';

// The project id is the HKDF salt, so one project's key reveals nothing about another's.
function derive(encryptionKey: string, projectId: string, info: string) {
  return Buffer.from(
    hkdfSync('sha256', encryptionKey, projectId, info, KEY_BYTES)
  );
}

export function linkKey(encryptionKey: string, projectId: string): Buffer {
  return derive(encryptionKey, projectId, LINK_INFO);
}

export function webhookSecret(
  encryptionKey: string,
  projectId: string
): string {
  return derive(encryptionKey, projectId, WEBHOOK_INFO).toString('base64url');
}

export function webhookPath(projectId: string, secret: string): string {
  return `/marketing/webhooks/msg91/${projectId}/${secret}`;
}
