// Minimal SMTP sink for the admin e2e harness. Staff invites are e-mail-only (the API never returns the accept token to
// the inviter), so the suite reads the invite link from the captured mail like a real invitee would. Plain SMTP, no
// AUTH, no STARTTLS (not advertised, so nodemailer sends in clear to 127.0.0.1). One JSON line per message.
import { createServer } from 'node:net';
import { appendFileSync } from 'node:fs';

export function startSmtpSink(port, mailboxFile) {
  const server = createServer((sock) => {
    let buf = '';
    let inData = false;
    let rcpt = [];
    let data = '';
    const say = (line) => sock.write(`${line}\r\n`);
    say('220 e2e-sink ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          appendFileSync(mailboxFile, `${JSON.stringify({ at: Date.now(), to: rcpt, data })}\n`);
          rcpt = []; data = '';
          say('250 OK queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') say('250 e2e-sink');
        else if (cmd === 'MAIL') say('250 OK');
        else if (cmd === 'RCPT') { const m = /<([^>]*)>/.exec(line); if (m) rcpt.push(m[1].toLowerCase()); say('250 OK'); }
        else if (cmd === 'DATA') { inData = true; say('354 end with <CRLF>.<CRLF>'); }
        else if (cmd === 'RSET') { rcpt = []; data = ''; say('250 OK'); }
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); return; }
        else say('250 OK');
      }
    });
    sock.on('error', () => {});
  });
  server.listen(port, '127.0.0.1');
  return server;
}
