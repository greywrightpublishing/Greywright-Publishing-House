// api/link-client.js
// ─────────────────────────────────────────────────────────────────────────────
// Called right after a client completes Supabase Auth sign-up.
// Creates their profile row, and links them to an existing clients row
// (matched by email, created earlier by admin) — or creates a new one
// if no admin-created record exists yet.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { user_id, email, name } = req.body || {};

    if (!user_id || !email || !name) {
      return res.status(400).json({ error: 'user_id, email, and name are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ── 1. Create the profile row (role: client) ────────────────────────────
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert(
        { id: user_id, role: 'client', full_name: name, email: normalizedEmail },
        { onConflict: 'id' }
      );

    if (profileError) {
      console.error('[link-client] profile upsert failed:', profileError);
      return res.status(500).json({ error: 'Could not create profile.' });
    }

    // ── 2. Look for an existing client record with this email, not yet linked ──
    const { data: existingClient } = await supabase
      .from('clients')
      .select('id, profile_id')
      .eq('email', normalizedEmail)
      .is('profile_id', null)
      .limit(1)
      .maybeSingle();

    if (existingClient) {
      // Link the admin-created client record to this new auth user
      const { error: linkError } = await supabase
        .from('clients')
        .update({ profile_id: user_id })
        .eq('id', existingClient.id);

      if (linkError) {
        console.error('[link-client] linking failed:', linkError);
        return res.status(500).json({ error: 'Could not link existing client record.' });
      }
    } else {
      // No admin-created record — create a fresh client row for this person
      const { error: createError } = await supabase
        .from('clients')
        .insert({ profile_id: user_id, name, email: normalizedEmail });

      if (createError) {
        console.error('[link-client] client creation failed:', createError);
        return res.status(500).json({ error: 'Could not create client record.' });
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[link-client] Crash:', err);
    return res.status(500).json({ error: 'Server error while linking client.' });
  }
}
