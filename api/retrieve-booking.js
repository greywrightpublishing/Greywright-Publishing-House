// api/retrieve-booking.js
// ─────────────────────────────────────────────────────────────────────────────
// Looks up a confirmed booking by email address in Supabase.
// Called by retrieve-booking.html when a customer was not redirected after payment.
//
// Security notes:
//   - Only returns bookings with status 'success' from Paystack (set by verify/webhook).
//   - Returns the most recent booking if a customer has paid multiple times.
//   - Does NOT expose the full Supabase row — only what the frontend needs.
//   - Rate limiting should be added at the Vercel/edge level to prevent enumeration.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required.' });
  }

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  // ── Query Supabase ──────────────────────────────────────────────────────────
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } = await supabase
      .from('bookings')
      .select('reference, name, email, service, paid_at')
      .eq('email', email.toLowerCase().trim())
      // Only return verified successful payments
      // (your verify-payment.js and webhook both only write on success)
      .order('paid_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      // No record found — could be wrong email or payment not yet recorded
      return res.status(404).json({
        found: false,
        error: 'No confirmed booking found for that email address. Please double-check the email you used at checkout, or contact us.',
      });
    }

    // ── Return only what the frontend needs ─────────────────────────────────
    return res.status(200).json({
      found: true,
      booking: {
        reference: data.reference,
        name:      data.name,
        email:     data.email,
        service:   data.service,
        paid_at:   data.paid_at,
      },
    });

  } catch (err) {
    console.error('[retrieve-booking] Crash:', err);
    return res.status(500).json({
      error: 'Server error while looking up your booking. Please try again or contact us.',
    });
  }
}
