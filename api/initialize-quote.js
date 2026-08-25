// api/initialize-quote.js
// ─────────────────────────────────────────────────────────────────────────────
// Verifies the signed quote token and initializes the Paystack transaction.
//
// USD quotes are converted to NGN BEFORE reaching Paystack.
// Paystack therefore receives an NGN transaction even when the original quote
// was created in USD.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed',
    });
  }

  const { token } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({
      error: 'A valid quote token is required.',
    });
  }

  const secret = process.env.QUOTE_SECRET;

  if (!secret) {
    console.error(
      '[initialize-quote] QUOTE_SECRET is not set.'
    );

    return res.status(500).json({
      error: 'Server configuration error.',
    });
  }

  // ── Split token ────────────────────────────────────────────────────────────

  const lastDot = token.lastIndexOf('.');

  if (lastDot === -1) {
    return res.status(400).json({
      error: 'Invalid token format.',
    });
  }

  const encodedPayload = token.slice(0, lastDot);
  const receivedSig = token.slice(lastDot + 1);

  // ── Decode payload ─────────────────────────────────────────────────────────

  let payload;

  try {
    payload = JSON.parse(
      Buffer.from(
        encodedPayload,
        'base64url'
      ).toString('utf8')
    );
  } catch {
    return res.status(400).json({
      error: 'Token could not be decoded.',
    });
  }

  // ── Verify signature ──────────────────────────────────────────────────────

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  const signaturesMatch =
    receivedSig.length === expectedSig.length &&
    crypto.timingSafeEqual(
      Buffer.from(receivedSig),
      Buffer.from(expectedSig)
    );

  if (!signaturesMatch) {
    console.warn(
      '[initialize-quote] Signature mismatch — possible tamper attempt.'
    );

    return res.status(401).json({
      error:
        'This payment link is invalid or has been tampered with.',
    });
  }

  // ── Check expiry ──────────────────────────────────────────────────────────

  if (
    payload.expiresAt &&
    payload.expiresAt > 0 &&
    Date.now() > payload.expiresAt
  ) {
    return res.status(400).json({
      error:
        'This payment link has expired. Please contact Greywright Publishing House for a new quote.',
    });
  }

  // ── Validate payment data ─────────────────────────────────────────────────

  if (
    !Number.isFinite(Number(payload.paymentAmount)) ||
    Number(payload.paymentAmount) <= 0
  ) {
    return res.status(400).json({
      error: 'Invalid payment amount in quote.',
    });
  }

  if (!['NGN'].includes(payload.paymentCurrency)) {
    return res.status(400).json({
      error:
        'This quote is not configured for an NGN Paystack transaction.',
    });
  }

  const paymentAmount = Math.round(
    Number(payload.paymentAmount)
  );

  // Paystack amount is in kobo.
  const amountInKobo = paymentAmount * 100;

  if (amountInKobo < 100000) {
    return res.status(400).json({
      error: 'Quote amount is below the minimum allowed.',
    });
  }

  // ── Paystack secret ───────────────────────────────────────────────────────

  const paystackSecret =
    process.env.PAYSTACK_SECRET_KEY;

  if (!paystackSecret) {
    console.error(
      '[initialize-quote] PAYSTACK_SECRET_KEY is not set.'
    );

    return res.status(500).json({
      error: 'Payment configuration error.',
    });
  }

  // ── Initialize Paystack transaction ───────────────────────────────────────

  try {
    const paystackRes = await fetch(
      'https://api.paystack.co/transaction/initialize',
      {
        method: 'POST',

        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          'Content-Type': 'application/json',
        },

        body: JSON.stringify({
          email: payload.clientEmail,

          // IMPORTANT:
          // Always NGN here.
          amount: amountInKobo,
          currency: 'NGN',

          callback_url:
            'https://www.greywrightpublishing.com/book-confirmed.html',

          metadata: {
            name: payload.clientName,

            service: payload.service,

            manuscript_title:
              payload.manuscriptTitle,

            notes: payload.notes,

            quote_type: 'custom',

            // Original quote information.
            quoted_amount: payload.amount,
            quoted_currency: payload.currency,

            // Actual Paystack payment.
            payment_amount: paymentAmount,
            payment_currency: 'NGN',

            exchange_rate:
              payload.exchangeRate || null,

            custom_fields: [
              {
                display_name: 'Customer Name',
                variable_name: 'name',
                value: payload.clientName,
              },

              {
                display_name: 'Service',
                variable_name: 'service',
                value: payload.service,
              },

              {
                display_name: 'Manuscript Title',
                variable_name: 'manuscript_title',
                value:
                  payload.manuscriptTitle || '',
              },

              {
                display_name: 'Original Quote',
                variable_name: 'original_quote',
                value: `${payload.currency} ${payload.amount}`,
              },

              {
                display_name: 'Payment Amount',
                variable_name: 'payment_amount',
                value: `NGN ${paymentAmount.toLocaleString(
                  'en-NG'
                )}`,
              },
            ],
          },
        }),
      }
    );

    const data = await paystackRes.json();

    if (!paystackRes.ok || !data.status) {
      console.error(
        '[initialize-quote] Paystack error:',
        data
      );

      return res.status(502).json({
        error:
          data.message ||
          'Payment initialization failed.',
      });
    }

    return res.status(200).json({
      authorization_url:
        data.data.authorization_url,

      reference:
        data.data.reference,
    });
  } catch (err) {
    console.error(
      '[initialize-quote] Crash:',
      err
    );

    return res.status(500).json({
      error:
        'Server error while initializing payment.',
    });
  }
}
