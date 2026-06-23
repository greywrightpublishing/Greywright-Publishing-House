// api/verify-payment.js
// Vercel serverless function.
//
// Called from book.html AFTER the Paystack popup reports success.
// This is the AUTHORITATIVE check — the popup's "success" callback alone
// can be spoofed client-side, so we never trust it without this step.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ verified: false, error: 'Method not allowed' });
  }

  const { reference } = req.body || {};

  if (!reference || typeof reference !== 'string') {
    return res.status(400).json({ verified: false, error: 'Missing payment reference' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET_KEY) {
    console.error('PAYSTACK_SECRET_KEY is not set in environment variables');
    return res.status(500).json({ verified: false, error: 'Server misconfigured. Please contact us directly.' });
  }

  try {
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      return res.status(400).json({
        verified: false,
        error: 'Could not reach Paystack to verify this payment. Please try again or contact us.',
      });
    }

    const tx = paystackData.data;

    if (!tx || tx.status !== 'success') {
      return res.status(400).json({
        verified: false,
        error: 'This payment was not successful. No charge has been confirmed.',
      });
    }

    const amountNgn = tx.amount / 100;
    const customerEmail = tx.customer?.email || '';
    const metadata = tx.metadata || {};
    const customerName = metadata.name || tx.customer?.first_name || '';
    const service = metadata.service || 'Unknown service';

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
            service,
            customer_name: customerName,
            customer_email: customerEmail,
            amount_ngn: amountNgn,
            paystack_status: tx.status,
            verified_at: new Date().toISOString(),
          }),
        });
      } catch (dbErr) {
        console.error('Supabase logging failed (non-fatal):', dbErr);
      }
    }

    return res.status(200).json({
      verified: true,
      customer: { name: customerName, email: customerEmail },
      service,
      amountNgn,
      reference: tx.reference,
    });
  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({
      verified: false,
      error: 'Something went wrong while verifying your payment. Please contact us directly.',
    });
  }
}
