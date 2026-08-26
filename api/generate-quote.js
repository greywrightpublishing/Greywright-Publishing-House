// api/generate-quote.js
// ─────────────────────────────────────────────────────────────────────────────
// Called by admin/dashboard.html to generate a signed, tamper-proof token
// that encodes the quote details. The token is appended to quote-checkout.html
// as a URL parameter. quote-checkout.html sends the token to initialize-quote.js
// which verifies the signature before creating the Paystack transaction.
//
// Security model:
//   - Token is signed with QUOTE_SECRET using HMAC-SHA256
//   - Amount, currency, service, expiry are all encoded IN the token
//   - Client cannot change the amount — any tamper breaks the signature
//   - Caller must be a signed-in Supabase user with profiles.role = 'admin'
//     (previously this checked a plaintext ADMIN_PASSWORD sent from the
//     browser — that password lived in client-side JS and was readable via
//     view-source, so it verified nothing. Now the caller sends a Supabase
//     access token in the Authorization header, and we verify that token
//     server-side against the user's real role.)
//   - Tokens expire after the configured number of days
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Verify the caller is a signed-in admin ─────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!accessToken) {
    return res.status(401).json({ error: 'Missing authorization token.' });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError || !profile || profile.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
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
  } = req.body || {};

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (!clientName || !clientEmail || !service || !amount || !currency) {
    return res.status(400).json({ error: 'clientName, clientEmail, service, amount, and currency are required.' });
  }

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(clientEmail)) {
    return res.status(400).json({ error: 'Invalid client email address.' });
  }

  // Currency must be validated BEFORE the amount check below, since the
  // minimum amount depends on which currency was selected.
  if (!['NGN', 'USD'].includes(currency)) {
    return res.status(400).json({ error: 'Currency must be NGN or USD.' });
  }

  const numAmount = parseFloat(amount);
  const minAmount = currency === 'NGN' ? 1000 : 1;
  if (isNaN(numAmount) || numAmount < minAmount) {
    return res.status(400).json({
      error: currency === 'NGN'
        ? 'Amount must be at least ₦1,000.'
        : 'Amount must be at least $1.'
    });
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
      created_by:       userData.user.id,
    });
  } catch (dbErr) {
    // Log failure but don't block — token is still valid
    console.error('[generate-quote] Supabase log failed:', dbErr);
  }

  return res.status(200).json({ token });
}
