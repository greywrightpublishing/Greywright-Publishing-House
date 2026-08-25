// api/generate-quote.js
// ─────────────────────────────────────────────────────────────────────────────
// Generates a signed quote.
// For USD quotes:
//   1. Fetches the current CBN USD/NGN exchange rate.
//   2. Converts the USD quote to NGN.
//   3. Locks the NGN amount and exchange rate into the signed token.
//   4. Paystack later processes the locked NGN amount.
//
// Example:
//   Client quote: $500
//   CBN rate:     ₦1,590.25 / USD
//   Paystack:     ₦795,125
//
// The client sees $500.
// Paystack processes ₦795,125.
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
    return res.status(400).json({
      error: 'clientName, clientEmail, service, amount, and currency are required.',
    });
  }

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRx.test(clientEmail)) {
    return res.status(400).json({
      error: 'Invalid client email address.',
    });
  }

  if (!['NGN', 'USD'].includes(currency)) {
    return res.status(400).json({
      error: 'Currency must be NGN or USD.',
    });
  }

  const numAmount = Number(amount);

  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return res.status(400).json({
      error: 'Amount must be a valid positive number.',
    });
  }

  const minAmount = currency === 'NGN' ? 1000 : 1;

  if (numAmount < minAmount) {
    return res.status(400).json({
      error:
        currency === 'NGN'
          ? 'Amount must be at least ₦1,000.'
          : 'Amount must be at least $1.',
    });
  }

  // ── Secret ─────────────────────────────────────────────────────────────────
  const secret = process.env.QUOTE_SECRET;

  if (!secret) {
    console.error('[generate-quote] QUOTE_SECRET is not set.');
    return res.status(500).json({
      error: 'Server configuration error.',
    });
  }

  // ── Calculate payment amount ───────────────────────────────────────────────
  let paymentAmountNGN;
  let exchangeRate = null;
  let exchangeRateDate = null;
  let exchangeRateProvider = null;

  if (currency === 'USD') {
    try {
      // CBN official USD/NGN rate through Frankfurter.
      const rateResponse = await fetch(
        'https://api.frankfurter.dev/v2/rate/USD/NGN?providers=CBN'
      );

      if (!rateResponse.ok) {
        throw new Error(
          `Exchange-rate API returned HTTP ${rateResponse.status}`
        );
      }

      const rateData = await rateResponse.json();

      if (!rateData.rate || !Number.isFinite(Number(rateData.rate))) {
        throw new Error('Invalid exchange rate received.');
      }

      exchangeRate = Number(rateData.rate);
      exchangeRateDate = rateData.date || null;
      exchangeRateProvider = 'CBN';

      // Convert USD quote to NGN.
      paymentAmountNGN = Math.round(numAmount * exchangeRate);

      // Safety check.
      if (paymentAmountNGN < 1000) {
        return res.status(400).json({
          error: 'Calculated NGN payment amount is below the minimum allowed.',
        });
      }

    } catch (rateError) {
      console.error(
        '[generate-quote] Exchange-rate lookup failed:',
        rateError
      );

      return res.status(502).json({
        error:
          'We could not retrieve the current USD/NGN exchange rate. Please try again shortly.',
      });
    }

  } else {
    // NGN quote — no conversion required.
    paymentAmountNGN = Math.round(numAmount);
  }

  // ── Build expiry ───────────────────────────────────────────────────────────
  const issuedAt = Date.now();

  const expiry =
    expiryDays && parseInt(expiryDays, 10) > 0
      ? parseInt(expiryDays, 10) * 24 * 60 * 60 * 1000
      : 0;

  const expiresAt = expiry ? issuedAt + expiry : 0;

  // ── Build signed payload ───────────────────────────────────────────────────
  const payload = {
    clientName: (clientName || '').trim(),
    clientEmail: clientEmail.toLowerCase().trim(),
    manuscriptTitle: (manuscriptTitle || '').trim(),
    service: service.trim(),

    // What the client was quoted.
    amount: numAmount,
    currency,

    // What Paystack will actually process.
    paymentAmountNGN,

    // Exchange-rate information.
    exchangeRate,
    exchangeRateDate,
    exchangeRateProvider,

    notes: (notes || '').trim(),
    generatedBy: (generatedBy || 'Greywright').trim(),

    issuedAt,
    expiresAt,
  };

  // ── Sign payload ───────────────────────────────────────────────────────────
  const payloadStr = JSON.stringify(payload);

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadStr)
    .digest('hex');

  const token =
    Buffer.from(payloadStr).toString('base64url') +
    '.' +
    signature;

  // ── Log quote to Supabase ──────────────────────────────────────────────────
  try {
    const { createClient } = await import('@supabase/supabase-js');

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    await supabase.from('quotes').insert({
      client_name: payload.clientName,
      client_email: payload.clientEmail,
      manuscript_title: payload.manuscriptTitle,
      service: payload.service,

      // Original quoted amount.
      amount: payload.amount,
      currency: payload.currency,

      // Actual NGN Paystack amount.
      payment_amount_ngn: payload.paymentAmountNGN,

      // Exchange-rate audit information.
      exchange_rate: payload.exchangeRate,
      exchange_rate_date: payload.exchangeRateDate,
      exchange_rate_provider: payload.exchangeRateProvider,

      notes: payload.notes,
      generated_by: payload.generatedBy,

      issued_at: new Date(issuedAt).toISOString(),
      expires_at: expiresAt
        ? new Date(expiresAt).toISOString()
        : null,

      token_preview: token.slice(0, 16) + '…',
    });

  } catch (dbErr) {
    // Do not invalidate an otherwise valid quote.
    console.error('[generate-quote] Supabase log failed:', dbErr);
  }

  // ── Return token ───────────────────────────────────────────────────────────
  return res.status(200).json({
    token,

    // These are useful for your admin interface.
    quotedAmount: numAmount,
    quotedCurrency: currency,
    paymentAmountNGN,
    exchangeRate,
    exchangeRateDate,
    exchangeRateProvider,
  });
}
