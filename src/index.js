// commutai.com sale page — Cloudflare Worker
// Serves the static page from /public and handles the offer form.
// The owner's email address is NEVER in this repo or the page: it lives in the
// CONTACT_TO secret (set with `npx wrangler secret put CONTACT_TO`).
//
// Email is delivered with Cloudflare Email Routing's free send_email binding,
// which can send to any *verified* destination address of the account.

import { EmailMessage } from 'cloudflare:email';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// UTF-8 safe base64, wrapped at 76 chars for MIME.
const b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/.{1,76}/g, '$&\r\n').trimEnd();
};
// RFC 2047 encoded-word for headers that may contain non-ASCII text.
const hdr = (str) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(str)))}?=`;
const addr = (s) => String(s).replace(/[\r\n<>"]/g, '');

export function buildMime({ from, fromName, to, replyTo, replyName, subject, text, html }) {
  const boundary = 'b' + crypto.randomUUID().replace(/-/g, '');
  return [
    `From: ${hdr(fromName)} <${addr(from)}>`,
    `To: <${addr(to)}>`,
    `Reply-To: ${hdr(replyName)} <${addr(replyTo)}>`,
    `Subject: ${hdr(subject)}`,
    `Message-ID: <${crypto.randomUUID()}@${addr(from).split('@')[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

const clean = (v, max) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);

async function verifyTurnstile(token, ip, env) {
  if (!token || !env.TURNSTILE_SECRET) return false;
  const allowed = new Set(
    String(env.TURNSTILE_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean),
  );
  let res;
  try {
    const r = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip || '' }),
    });
    if (!r.ok) return false;
    res = await r.json();
  } catch (err) {
    console.error('siteverify unreachable', err?.message);
    return false;
  }
  return (
    res.success === true &&
    res.action === 'offer' &&
    (allowed.size === 0 || allowed.has(res.hostname))
  );
}

async function handleContact(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Send the form as JSON.' }, 400);
  }

  // Honeypot: real visitors never fill this field.
  if (data.website) return json({ ok: true });

  const name = clean(data.name, 100);
  const email = clean(data.email, 200);
  const offer = clean(data.offer, 20);
  const topic = clean(data.topic, 40) || 'Buying the domain';
  const message = clean(data.message, 4000);

  if (!name || !message) return json({ error: 'Add your name and a message, then send again.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address so the owner can reply.' }, 400);

  const ip = request.headers.get('CF-Connecting-IP');
  const human = await verifyTurnstile(data['cf-turnstile-response'], ip, env);
  if (!human) return json({ error: 'Verification failed. Complete the check again, then send.' }, 403);

  if (!env.CONTACT_TO || !env.EMAIL) return json({ error: 'The contact form is not configured yet.' }, 503);

  const subject = `[commutai.com] ${topic}${offer ? ` — offer $${offer}` : ''} from ${name}`.slice(0, 200);
  const text = [
    `Topic: ${topic}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Offer: ${offer ? '$' + offer : '(none)'}`,
    `Country: ${request.cf?.country || 'unknown'}`,
    '',
    message,
    '',
    '— Sent from the commutai.com sale page. Reply to this email to answer the sender.',
  ].join('\n');
  const html = `
    <h2 style="font-family:sans-serif">${esc(topic)}</h2>
    <table style="font-family:sans-serif;font-size:14px">
      <tr><td><b>Name</b></td><td>${esc(name)}</td></tr>
      <tr><td><b>Email</b></td><td>${esc(email)}</td></tr>
      <tr><td><b>Offer</b></td><td>${offer ? '$' + esc(offer) : '(none)'}</td></tr>
      <tr><td><b>Country</b></td><td>${esc(request.cf?.country || 'unknown')}</td></tr>
    </table>
    <p style="font-family:sans-serif;white-space:pre-wrap">${esc(message)}</p>
    <p style="font-family:sans-serif;color:#666;font-size:12px">Sent from the commutai.com sale page. Reply to answer the sender.</p>`;

  const from = env.MAIL_FROM || 'offers@commutai.com';
  try {
    const raw = buildMime({
      from, fromName: 'commutai.com offers', to: env.CONTACT_TO,
      replyTo: email, replyName: name, subject, text, html,
    });
    await env.EMAIL.send(new EmailMessage(from, env.CONTACT_TO, raw));
  } catch (err) {
    console.error('send failed', err?.code, err?.message);
    return json({ error: 'The message could not be sent. Try again in a minute.' }, 502);
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // One canonical address for search engines: www → apex (permanent).
    if (url.hostname === 'www.commutai.com') {
      url.hostname = 'commutai.com';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({ siteKey: env.TURNSTILE_SITE_KEY || '' });
    }
    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      return handleContact(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
