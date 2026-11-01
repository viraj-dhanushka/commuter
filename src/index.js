// commutai.com sale page — Cloudflare Worker
// Serves the static page from /public and handles the offer form.
// The owner's email address is NEVER in this repo or the page: it lives in the
// CONTACT_TO secret (set with `npx wrangler secret put CONTACT_TO`).

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  try {
    await env.EMAIL.send({
      to: env.CONTACT_TO,
      from: { email: env.MAIL_FROM || 'offers@commutai.com', name: 'commutai.com offers' },
      replyTo: { email, name },
      subject,
      text,
      html,
    });
  } catch (err) {
    console.error('send failed', err?.code, err?.message);
    return json({ error: 'The message could not be sent. Try again in a minute.' }, 502);
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
