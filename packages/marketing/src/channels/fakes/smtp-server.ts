import { createServer, type Socket } from 'node:net';

const LOCALHOST = '127.0.0.1';
const END_OF_DATA = '\r\n.\r\n';
const RECIPIENT_ADDRESS = /<([^>]*)>/;

// Return a line to script a reply, undefined for the default reply, null to stay silent.
// `command` is the SMTP line ('RCPT TO:<a@b.test>'), 'CONNECT' for the greeting and '.' for the end of DATA;
// `index` counts commands across all connections, from 0.
export type SmtpReply = (
  command: string,
  index: number
) => string | null | undefined;

export interface FakeSmtpOptions {
  reply?: SmtpReply;
  delayMs?: number;
}

export interface FakeSmtpSession {
  recipients: string[];
  data: string;
  closed: boolean;
}

export interface FakeSmtp {
  port: number;
  // Delivered messages; addresses live in memory only.
  messages: { to: string[]; size: number; data: string }[];
  sessions: FakeSmtpSession[];
  // Mutable so a test can change behaviour between steps.
  reply: SmtpReply | undefined;
  delayMs: number;
  connections: () => number;
  close(): Promise<void>;
}

const defaultReply = (command: string): string => {
  const verb = command.slice(0, 4).toUpperCase();
  if (verb === 'CONN') {
    return '220 fake smtp';
  }
  if (verb === 'DATA') {
    return '354 go';
  }
  if (command === '.') {
    return '250 queued';
  }
  return verb === 'EHLO' || verb === 'HELO' ? '250 fake' : '250 ok';
};

export async function startFakeSmtp(
  options: FakeSmtpOptions = {}
): Promise<FakeSmtp> {
  const sockets = new Set<Socket>();
  let commandIndex = 0;
  const fake: FakeSmtp = {
    port: 0,
    messages: [],
    sessions: [],
    reply: options.reply,
    delayMs: options.delayMs ?? 0,
    connections: () => fake.sessions.length,
    close,
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    const session: FakeSmtpSession = {
      recipients: [],
      data: '',
      closed: false,
    };
    fake.sessions.push(session);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      session.closed = true;
      sockets.delete(socket);
    });
    const answer = (command: string) => {
      const scripted = fake.reply?.(command, commandIndex++);
      const line = scripted === undefined ? defaultReply(command) : scripted;
      if (line === null) {
        return;
      }
      setTimeout(() => {
        if (socket.writable) {
          socket.write(`${line}\r\n`);
        }
      }, fake.delayMs);
    };
    let buffer = '';
    let inData = false;
    let pending: string[] = [];
    answer('CONNECT');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (inData) {
        const end = buffer.indexOf(END_OF_DATA);
        if (end === -1) {
          return;
        }
        session.data = buffer.slice(0, end);
        buffer = buffer.slice(end + END_OF_DATA.length);
        inData = false;
        fake.messages.push({
          to: pending,
          size: session.data.length,
          data: session.data,
        });
        pending = [];
        answer('.');
      }
      let lineEnd = buffer.indexOf('\r\n');
      while (lineEnd !== -1 && !inData) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
        } else {
          if (verb === 'MAIL') {
            pending = [];
          }
          if (verb === 'RCPT') {
            session.recipients.push(line);
            pending.push(recipientAddress(line));
          }
          inData = verb === 'DATA';
          answer(line);
        }
        lineEnd = buffer.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, LOCALHOST, resolve));
  const address = server.address();
  fake.port = typeof address === 'object' && address ? address.port : 0;

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) {
        socket.destroy();
      }
    });
    return closing;
  }
  return fake;
}

export function recipientAddress(rcptLine: string): string {
  return RECIPIENT_ADDRESS.exec(rcptLine)?.[1] ?? '';
}
