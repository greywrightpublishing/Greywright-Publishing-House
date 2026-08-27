// api/link-client.js
// ─────────────────────────────────────────────────────────────────────────────
// Securely links a newly registered Supabase Auth user to the correct
// Greywright client record.
//
// Flow:
// 1. Client signs up through Supabase Auth.
// 2. Browser sends the user's access token to this endpoint.
// 3. Server verifies the token and gets the real authenticated user ID.
// 4. Creates/updates the client's profile.
// 5. Finds an existing admin-created clients row by email.
// 6. Links that client row to the authenticated user.
// 7. If no existing client exists, creates one.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    const accessToken = authHeader.replace('Bearer ', '').trim();

    if (!accessToken) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    const { email, name } = req.body || {};

    if (!email || !name) {
      return res.status(400).json({
        error: 'email and name are required.'
      });
    }

    const normalizedEmail = String(email)
      .toLowerCase()
      .trim();

    const normalizedName = String(name)
      .trim();

    if (!normalizedName || !normalizedEmail) {
      return res.status(400).json({
        error: 'Valid name and email are required.'
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 1. Create the normal server-side Supabase client
    // ─────────────────────────────────────────────────────────────────────

    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ─────────────────────────────────────────────────────────────────────
    // 2. Verify the access token
    // ─────────────────────────────────────────────────────────────────────

    const {
      data: {
        user
      },
      error: userError
    } = await supabaseAdmin.auth.getUser(accessToken);

    if (userError || !user) {
      console.error(
        '[link-client] Invalid session:',
        userError
      );

      return res.status(401).json({
        error: 'Invalid or expired session.'
      });
    }

    // NEVER trust user_id supplied by the browser.
    // We use the ID returned by Supabase after verifying the token.
    const userId = user.id;

    // Make sure the email being linked actually belongs to the
    // authenticated Supabase account.
    const authenticatedEmail =
      String(user.email || '')
        .toLowerCase()
        .trim();

    if (
      !authenticatedEmail ||
      authenticatedEmail !== normalizedEmail
    ) {
      return res.status(403).json({
        error: 'The supplied email does not match your account.'
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 3. Create/update profile
    // ─────────────────────────────────────────────────────────────────────

    const {
      error: profileError
    } = await supabaseAdmin
      .from('profiles')
      .upsert(
        {
          id: userId,
          role: 'client',
          full_name: normalizedName,
          email: authenticatedEmail
        },
        {
          onConflict: 'id'
        }
      );

    if (profileError) {
      console.error(
        '[link-client] profile upsert failed:',
        profileError
      );

      return res.status(500).json({
        error: 'Could not create your client profile.'
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 4. Check whether this user is already linked
    // ─────────────────────────────────────────────────────────────────────

    const {
      data: alreadyLinked,
      error: alreadyLinkedError
    } = await supabaseAdmin
      .from('clients')
      .select('id, profile_id, name, email')
      .eq('profile_id', userId)
      .maybeSingle();

    if (alreadyLinkedError) {
      console.error(
        '[link-client] existing client lookup failed:',
        alreadyLinkedError
      );

      return res.status(500).json({
        error: 'Could not verify your client account.'
      });
    }

    if (alreadyLinked) {
      return res.status(200).json({
        success: true,
        linked: true,
        client_id: alreadyLinked.id
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 5. Look for an admin-created client with the same email
    // ─────────────────────────────────────────────────────────────────────

    const {
      data: existingClient,
      error: clientLookupError
    } = await supabaseAdmin
      .from('clients')
      .select('id, profile_id, name, email')
      .eq('email', authenticatedEmail)
      .is('profile_id', null)
      .limit(1)
      .maybeSingle();

    if (clientLookupError) {
      console.error(
        '[link-client] client lookup failed:',
        clientLookupError
      );

      return res.status(500).json({
        error: 'Could not find your client record.'
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 6. Link existing admin-created client
    // ─────────────────────────────────────────────────────────────────────

    if (existingClient) {
      const {
        error: linkError
      } = await supabaseAdmin
        .from('clients')
        .update({
          profile_id: userId
        })
        .eq('id', existingClient.id)
        .is('profile_id', null);

      if (linkError) {
        console.error(
          '[link-client] linking failed:',
          linkError
        );

        return res.status(500).json({
          error: 'Could not link your client account.'
        });
      }

      return res.status(200).json({
        success: true,
        linked: true,
        client_id: existingClient.id
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 7. No admin-created client exists — create one
    // ─────────────────────────────────────────────────────────────────────

    const {
      data: newClient,
      error: createError
    } = await supabaseAdmin
      .from('clients')
      .insert({
        profile_id: userId,
        name: normalizedName,
        email: authenticatedEmail
      })
      .select('id')
      .single();

    if (createError) {
      console.error(
        '[link-client] client creation failed:',
        createError
      );

      return res.status(500).json({
        error: 'Could not create your client record.'
      });
    }

    return res.status(200).json({
      success: true,
      linked: true,
      client_id: newClient.id
    });

  } catch (err) {
    console.error(
      '[link-client] Crash:',
      err
    );

    return res.status(500).json({
      error: 'Server error while linking client.'
    });
  }
}
