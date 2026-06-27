// api/initialize-quote.js
// ─────────────────────────────────────────────────────────────────────────────
// Called by quote-checkout.html when the client clicks Pay.
// Decodes and verifies the signed token, then creates a Paystack transaction
// with the amount encoded in the token — the client cannot change the amount.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'A valid quote token is required.' });
  }

  const secret = process.env.QUOTE_SECRET;
  if (!secret) {
    console.error('[initialize-quote] QUOTE_SECRET is not set.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  // ── Decode and verify token ────────────────────────────────────────────────
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) {
    return res.status(400).json({ error: 'Invalid token format.' });
  }

  const encodedPayload = token.slice(0, lastDot);
  const receivedSig    = token.slice(lastDot + 1);

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Token could not be decoded.' });
  }

  // Verify signature
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  if (receivedSig !== expectedSig) {
    console.warn('[initialize-quote] Signature mismatch — possible tamper attempt.');
    return res.status(401).json({ error: 'This payment link is invalid or has been tampered with.' });
  }

  // ── Check expiry ───────────────────────────────────────────────────────────
  if (payload.expiresAt && payload.expiresAt > 0 && Date.now() > payload.expiresAt) {
    return res.status(400).json({
      error: 'This payment link has expired. Please contact Greywright Publishing House for a new quote.',
    });
  }

  // ── Convert amount to kobo / cents ────────────────────────────────────────
  // Paystack always wants the smallest currency unit
  const amountInSmallestUnit = Math.round(payload.amount * 100);

  // Sanity check — min ₦1,000 (100000 kobo) or $1 (100 cents)
  const minAmount = payload.currency === 'NGN' ? 100000 : 100;
  if (amountInSmallestUnit < minAmount) {
    return res.status(400).json({ error: 'Quote amount is below the minimum allowed.' });
  }

  // ── Initialize Paystack transaction ───────────────────────────────────────
  try {
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email:        payload.clientEmail,
        amount:       amountInSmallestUnit,
        currency:     payload.currency,
        callback_url: 'https://www.greywrightpublishing.com/book-confirmed.html',
        metadata: {
          name:             payload.clientName,
          service:          payload.service,
          manuscript_title: payload.manuscriptTitle,
          notes:            payload.notes,
          quote_type:       'custom',
          custom_fields: [
            { display_name: 'Customer Name',     variable_name: 'name',             value: payload.clientName },
            { display_name: 'Service',           variable_name: 'service',          value: payload.service },
            { display_name: 'Manuscript Title',  variable_name: 'manuscript_title', value: payload.manuscriptTitle },
          ],
        },
      }),
    });

    const data = await paystackRes.json();

    if (!paystackRes.ok || !data.status) {
      console.error('[initialize-quote] Paystack error:', data);
      return res.status(502).json({ error: data.message || 'Payment initialization failed.' });
    }

    return res.status(200).json({
      authorization_url: data.data.authorization_url,
      reference:         data.data.reference,
    });

  } catch (err) {
    console.error('[initialize-quote] Crash:', err);
    return res.status(500).json({ error: 'Server error while initializing payment.' });
  }
}
