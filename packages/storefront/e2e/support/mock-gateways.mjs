// One local process that stands in for everything the API would otherwise reach over the internet:
//
//   /nmi/*      NMI Payment API (sandbox.nmi.com)         -> POST /nmi/api/transact.php
//   /sezzle/*   Sezzle gateway (sandbox.gateway.sezzle.com) -> /sezzle/v2/{authentication,session,order/...}
//   /hook/*     the "customer's" webhook receiver (order.shipped, ...), see preload.mjs for how the API reaches it
//   :SMTP_PORT  an SMTP sink, so the real nodemailer path + email_outbox 'sent' transition run for real
//   /control/*  inspection + steering for specs (see support/mock.ts)
//
// The API reaches the first three only through the preload's host rewrite; specs reach /control directly.
import { createServer as createHttp } from 'node:http';
import { createServer as createSmtp } from 'node:net';
import { randomUUID } from 'node:crypto';
import { MOCK_PORT, SMTP_PORT, NMI, SEZZLE } from './env.mjs';

const state = { calls: [], hooks: [], mails: [], sezzle: new Map(), nmiTx: new Map(), seq: 1000, hookFailures: 0 };

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
const money = (cents, currency = 'USD') => ({ amount_in_cents: cents, currency });

// ── NMI ──────────────────────────────────────────────────────────────────────────────────────────────────
// payment_token decides the outcome: tok_decline -> declined, anything else approves. Amounts are taken verbatim
// from the API's request (that is what the specs assert on).
function nmi(req, res, path, raw) {
  if (path === '/api/transact.php') {
    const f = new URLSearchParams(raw);
    const call = { service: 'nmi', type: f.get('type'), amount: f.get('amount'), orderid: f.get('orderid'), token: f.get('payment_token'), transactionid: f.get('transactionid'), at: Date.now() };
    state.calls.push(call);
    const out = (o) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(new URLSearchParams(o).toString()); };
    if (f.get('security_key') !== NMI.securityKey) return out({ response: '3', responsetext: 'Authentication Failed', response_code: '300' });
    if (f.get('type') === 'sale') {
      if (f.get('payment_token') === 'tok_decline') return out({ response: '2', responsetext: 'DECLINE', response_code: '200', transactionid: `NMI-${++state.seq}` });
      const id = `NMI-${++state.seq}`;
      state.nmiTx.set(id, { amount: f.get('amount'), orderid: f.get('orderid') });
      return out({ response: '1', responsetext: 'SUCCESS', response_code: '100', transactionid: id, avsresponse: 'Y', cvvresponse: 'M' });
    }
    if (f.get('type') === 'refund' || f.get('type') === 'void') {
      return out({ response: '1', responsetext: 'SUCCESS', response_code: '100', transactionid: `NMI-${++state.seq}` });
    }
    return out({ response: '3', responsetext: 'Unsupported type', response_code: '300' });
  }
  json(res, 404, { error: 'unknown nmi path ' + path });
}

// ── Sezzle ───────────────────────────────────────────────────────────────────────────────────────────────
function sezzleOrderView(o) {
  return {
    uuid: o.uuid, reference_id: o.reference_id, order_amount: money(o.amount),
    checkout_status: o.captures.length ? 'approved' : 'created',
    authorization: o.captures.length
      ? { approved: true, expiration: new Date(Date.now() + 86_400_000).toISOString(), captures: o.captures, refunds: o.refunds, releases: [] }
      : undefined,
  };
}
function sezzle(req, res, path, raw) {
  state.calls.push({ service: 'sezzle', method: req.method, path, at: Date.now() });
  if (path === '/v2/authentication') {
    const b = JSON.parse(raw || '{}');
    if (b.public_key !== SEZZLE.publicKey || b.private_key !== SEZZLE.privateKey) return json(res, 401, { message: 'bad keys' });
    return json(res, 200, { token: 'e2e-sezzle-token', expiration_date: new Date(Date.now() + 3_600_000).toISOString() });
  }
  if (req.headers.authorization !== 'Bearer e2e-sezzle-token') return json(res, 401, { message: 'unauthorized' });
  if (path === '/v2/session' && req.method === 'POST') {
    const b = JSON.parse(raw);
    const uuid = randomUUID();
    state.sezzle.set(uuid, {
      uuid, reference_id: b.order.reference_id, amount: b.order.order_amount.amount_in_cents, currency: b.order.order_amount.currency,
      complete_url: b.complete_url.href, cancel_url: b.cancel_url.href, session: b, captures: [], refunds: [], intent: b.order.intent,
    });
    return json(res, 200, { order: { uuid, checkout_url: `https://sandbox.checkout.sezzle.com/?id=${uuid}` } });
  }
  const m = path.match(/^\/v2\/order\/([^/]+)(?:\/(capture|release|refund))?$/);
  if (m) {
    const o = state.sezzle.get(m[1]);
    if (!o) return json(res, 404, { message: 'order not found' });
    if (!m[2] && req.method === 'GET') return json(res, 200, sezzleOrderView(o));
    if (m[2] === 'capture') { o.captures.push({ uuid: randomUUID(), amount: money(o.amount, o.currency) }); return json(res, 200, { uuid: o.captures.at(-1).uuid }); }
    if (m[2] === 'release') return json(res, 200, { uuid: randomUUID() });
    if (m[2] === 'refund') {
      const b = JSON.parse(raw);
      const r = { uuid: randomUUID(), amount: money(b.amount_in_cents, b.currency) };
      o.refunds.push(r);
      return json(res, 200, { uuid: r.uuid });
    }
  }
  json(res, 404, { message: 'unknown sezzle path ' + path });
}

// ── control ──────────────────────────────────────────────────────────────────────────────────────────────
function control(req, res, path, raw) {
  const url = new URL(req.url, 'http://x');
  if (path === '/calls') return json(res, 200, { calls: state.calls.filter((c) => !url.searchParams.get('service') || c.service === url.searchParams.get('service')) });
  if (path === '/hooks') return json(res, 200, { hooks: state.hooks });
  if (path === '/mails') return json(res, 200, { mails: state.mails });
  if (path === '/sezzle/sessions') return json(res, 200, { sessions: [...state.sezzle.values()] });
  if (path === '/sezzle/capture' && req.method === 'POST') {
    // The shopper approved + Sezzle auto-captured (intent CAPTURE): from now on the authoritative GET reports it.
    const { uuid } = JSON.parse(raw);
    const o = state.sezzle.get(uuid);
    if (!o) return json(res, 404, { error: 'no such session' });
    if (!o.captures.length) o.captures.push({ uuid: randomUUID(), amount: money(o.amount, o.currency) });
    return json(res, 200, sezzleOrderView(o));
  }
  if (path === '/reset' && req.method === 'POST') { state.calls = []; state.hooks = []; state.mails = []; state.hookFailures = 0; return json(res, 200, { ok: true }); }
  // Make the next N webhook deliveries answer 500 (delivery must retry / not be marked delivered).
  if (path === '/hooks/fail' && req.method === 'POST') { state.hookFailures = JSON.parse(raw).count ?? 1; return json(res, 200, { ok: true }); }
  json(res, 404, { error: 'unknown control path ' + path });
}

createHttp(async (req, res) => {
  const raw = req.method === 'GET' ? '' : await readBody(req);
  const path = req.url.split('?')[0];
  try {
    if (path === '/health') return json(res, 200, { ok: true });
    if (path.startsWith('/nmi/')) return nmi(req, res, path.slice(4), raw);
    if (path.startsWith('/sezzle/')) return sezzle(req, res, path.slice(7), raw);
    if (path.startsWith('/control/')) return control(req, res, path.slice(8), raw);
    if (path.startsWith('/hook')) {
      state.hooks.push({ path, headers: req.headers, body: raw, at: Date.now() });
      if (state.hookFailures > 0) { state.hookFailures--; return json(res, 500, { error: 'receiver is down' }); }
      return json(res, 200, { received: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error('mock-gateways handler error', error);
    json(res, 500, { error: 'mock handler error' });
  }
}).listen(MOCK_PORT, '127.0.0.1', () => console.log(`[mock] gateways + webhook receiver on :${MOCK_PORT}`));

// ── SMTP sink ────────────────────────────────────────────────────────────────────────────────────────────
function decodePart(headers, body) {
  const enc = /content-transfer-encoding:\s*(\S+)/i.exec(headers)?.[1]?.toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    return body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}
function decodeWords(v) {
  return v.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, k, t) => k.toLowerCase() === 'b'
    ? Buffer.from(t, 'base64').toString('utf8')
    : t.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))));
}
function parseMail(rawMsg) {
  const [head, ...rest] = rawMsg.split(/\r\n\r\n/);
  const body = rest.join('\r\n\r\n');
  const unfolded = head.replace(/\r\n[ \t]+/g, ' ');
  const header = (n) => decodeWords(new RegExp(`^${n}:\\s*(.*)$`, 'im').exec(unfolded)?.[1] ?? '');
  const out = { subject: header('subject'), to: header('to'), from: header('from'), text: '', html: '' };
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(unfolded)?.[1];
  const parts = boundary ? body.split('--' + boundary).slice(1, -1) : [`${head}\r\n\r\n${body}`];
  const walk = (chunk) => {
    const [ph, ...pb] = chunk.replace(/^\r\n/, '').split(/\r\n\r\n/);
    const inner = /boundary="?([^";\r\n]+)"?/i.exec(ph)?.[1];
    if (inner) { for (const sub of pb.join('\r\n\r\n').split('--' + inner).slice(1, -1)) walk(sub); return; }
    const type = /content-type:\s*([^;\r\n]+)/i.exec(ph)?.[1]?.toLowerCase() ?? 'text/plain';
    const text = decodePart(ph, pb.join('\r\n\r\n'));
    if (type === 'text/html') out.html += text; else if (type === 'text/plain') out.text += text;
  };
  parts.forEach(walk);
  return out;
}

createSmtp((socket) => {
  let buf = '', data = null, mail = { to: [] };
  socket.write('220 e2e-sink ESMTP\r\n');
  socket.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    for (;;) {
      if (data !== null) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        const msg = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
        buf = buf.slice(end + 5);
        data = null;
        state.mails.push({ envelopeTo: mail.to, ...parseMail(Buffer.from(msg, 'latin1').toString('utf8')), at: Date.now() });
        mail = { to: [] };
        socket.write('250 queued\r\n');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') socket.write('250-e2e-sink\r\n250 8BITMIME\r\n');
      else if (cmd === 'HELO') socket.write('250 e2e-sink\r\n');
      else if (cmd === 'MAIL') socket.write('250 ok\r\n');
      else if (cmd === 'RCPT') { mail.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); socket.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { data = ''; socket.write('354 go\r\n'); }
      else if (cmd === 'RSET') socket.write('250 ok\r\n');
      else if (cmd === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); return; }
      else socket.write('250 ok\r\n');
    }
  });
  socket.on('error', () => undefined);
}).listen(SMTP_PORT, '127.0.0.1', () => console.log(`[mock] smtp sink on :${SMTP_PORT}`));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
