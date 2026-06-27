// api/generate-quote.js
// ─────────────────────────────────────────────────────────────────────────────
// Called by admin/index.html to generate a signed, tamper-proof token
// that encodes the quote details. The token is appended to quote-checkout.html
// as a URL parameter. quote-checkout.html sends the token to initialize-quote.js
// which verifies the signature before creating the Paystack transaction.
//
// Security model:
//   - Token is signed with QUOTE_SECRET using HMAC-SHA256
//   - Amount, currency, service, expiry are all encoded IN the token
//   - Client cannot change the amount — any tamper breaks the signature
//   - Admin password is verified server-side before any token is issued
//   - Tokens expire after the configured number of days
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    clientName,
    clientEmail,
    manuscriptTitle,
    service,
    amount,
    currency,
    notes,
    expiryDays,
    generatedBy,
    adminPassword,
  } = req.body || {};

  // ── Verify admin password ──────────────────────────────────────────────────
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (!clientName || !clientEmail || !service || !amount || !currency) {
    return res.status(400).json({ error: 'clientName, clientEmail, service, amount, and currency are required.' });
  }

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(clientEmail)) {
    return res.status(400).json({ error: 'Invalid client email address.' });
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount < 1000) {
    return res.status(400).json({ error: 'Amount must be at least ₦1,000 or $1.' });
  }

  if (!['NGN', 'USD'].includes(currency)) {
    return res.status(400).json({ error: 'Currency must be NGN or USD.' });
  }

  const secret = process.env.QUOTE_SECRET;
  if (!secret) {
    console.error('[generate-quote] QUOTE_SECRET env var is not set.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  // ── Build payload ──────────────────────────────────────────────────────────
  const issuedAt  = Date.now();
  const expiresAt = expiryDays && parseInt(expiryDays, 10) > 0
    ? issuedAt + (parseInt(expiryDays, 10) * 24 * 60 * 60 * 1000)
    : 0; // 0 = never expires

  const payload = {
    clientName:     clientName.trim(),
    clientEmail:    clientEmail.toLowerCase().trim(),
    manuscriptTitle:(manuscriptTitle || '').trim(),
    service:        service.trim(),
    amount:         numAmount,
    currency,
    notes:          (notes || '').trim(),
    generatedBy:    (generatedBy || 'Greywright').trim(),
    issuedAt,
    expiresAt,
  };

  // ── Sign the payload ───────────────────────────────────────────────────────
  const payloadStr = JSON.stringify(payload);
  const signature  = crypto
    .createHmac('sha256', secret)
    .update(payloadStr)
    .digest('hex');

  // Encode as base64url: payload + . + signature
  const token = Buffer.from(payloadStr).toString('base64url') + '.' + signature;

  // ── Log to Supabase (quote audit trail) ───────────────────────────────────
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    await supabase.from('quotes').insert({
      client_name:      payload.clientName,
      client_email:     payload.clientEmail,
      manuscript_title: payload.manuscriptTitle,
      service:          payload.service,
      amount:           payload.amount,
      currency:         payload.currency,
      notes:            payload.notes,
      generated_by:     payload.generatedBy,
      issued_at:        new Date(issuedAt).toISOString(),
      expires_at:       expiresAt ? new Date(expiresAt).toISOString() : null,
      token_preview:    token.slice(0, 16) + '…', // never store full token
    });
  } catch (dbErr) {
    // Log failure but don't block — token is still valid
    console.error('[generate-quote] Supabase log failed:', dbErr);
  }

  return res.status(200).json({ token });
}
