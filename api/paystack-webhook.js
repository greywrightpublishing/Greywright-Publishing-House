// api/paystack-webhook.js
// Vercel serverless function.
//
// Backup record-keeper: if a visitor pays and closes the tab before the
// verify-payment step finishes, this webhook still logs the payment.
//
// Configure this URL in Paystack Dashboard → Settings → API Keys & Webhooks
// → Webhook URL: https://YOUR-VERCEL-DOMAIN/api/paystack-webhook

import crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET_KEY) {
    console.error('PAYSTACK_SECRET_KEY is not set');
    return res.status(500).end();
  }

  const rawBody = await readRawBody(req);

  const signature = req.headers['x-paystack-signature'];
  const expectedSignature = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (!signature || signature !== expectedSignature) {
    console.warn('Webhook signature mismatch — rejecting');
    return res.status(401).end();
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).end();
  }

  if (event.event === 'charge.success') {
    const tx = event.data;
    const amountNgn = tx.amount / 100;
    const metadata = tx.metadata || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            reference: tx.reference,
            service: metadata.service || 'Unknown service',
            customer_name: metadata.name || tx.customer?.first_name || '',
            customer_email: tx.customer?.email || '',
            amount_ngn: amountNgn,
            paystack_status: tx.status,
            verified_at: new Date().toISOString(),
            source: 'webhook',
          }),
        });
      } catch (err) {
        console.error('Webhook Supabase logging failed:', err);
      }
    }
  }

  return res.status(200).json({ received: true });
}
