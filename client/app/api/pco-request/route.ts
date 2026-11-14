import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit } from '../_lib/rateLimit';

export const dynamic = 'force-dynamic';

// Initialize Supabase with available environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
}) : null;

const KNOWN_ADMIN_EMAILS = [
  'nikhilyadav200530@gmail.com',
  'avneeshkumarjha1506@gmail.com',
  'avneeshjha1506@gmail.com',
  'dpursuit14@gmail.com',
  'lachavzo11@gmail.com'
];

/**
 * Verify the caller's Supabase JWT. Returns the authenticated user, or null
 * when there is no token, the token is invalid/expired, or auth is not
 * configured. Never trusts a client-supplied user id or an unverified header.
 */
async function getAuthenticatedUser(req: NextRequest) {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  const authUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!authUrl || !anonKey) return null;

  const authClient = createClient(authUrl, anonKey, { auth: { persistSession: false } });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function sanitizeStr(input: unknown, maxLen: number, fallback = ''): string {
  if (typeof input !== 'string') return fallback;
  return input.replace(/[\r\n]/g, '').trim().substring(0, maxLen) || fallback;
}

export async function POST(req: NextRequest) {
  // Rate limiting: max 10 song requests per minute per IP.
  const rateLimit = checkRateLimit(req, 10, 60, 'pco-request');
  if (!rateLimit.success) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.resetInSeconds) } }
    );
  }

  try {
    // Require a verified Supabase JWT. The caller in pcoAdmin.ts currently
    // sends no Authorization header — it must be updated to send
    // `Authorization: Bearer <session.access_token>` or requests will 401.
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 });
    }

    const body = await req.json();
    // NOTE: any client-supplied `currentUser` / requester id is ignored.
    // requester_id is always the verified auth.uid() below.
    const { track, displayName } = body;

    if (!track || !track.id || !track.song) {
      return NextResponse.json({ success: false, error: 'Invalid track data' }, { status: 400 });
    }

    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Database service unavailable' }, { status: 503 });
    }

    const requesterId = user.id;
    const requesterName = sanitizeStr(displayName, 80, 'Campus Listener');

    const payload = {
      requester_id: requesterId,
      requester_name: requesterName,
      track_id: String(track.id).substring(0, 128),
      track_name: sanitizeStr(track.song, 200, 'Unknown Track'),
      track_artist: sanitizeStr(track.singers, 200, 'Unknown Artist'),
      track_image: typeof track.image === 'string' ? track.image.substring(0, 2048) : null,
      track_url: typeof track.media_url === 'string' ? track.media_url.substring(0, 2048) : null,
      track_duration: track.duration ? String(track.duration).substring(0, 32) : '240',
      status: 'pending',
      requested_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('pco_song_requests')
      .insert(payload)
      .select()
      .maybeSingle();

    if (error) {
      console.warn('[PCO Request API] DB insert error:', error);
      return NextResponse.json({ success: false, error: 'Could not submit song request. Please try again later.' }, { status: 500 });
    }

    // Attempt to notify admins via notifications table
    try {
      const { data: adminProfiles } = await supabase
        .from('profiles')
        .select('id')
        .or(`is_admin.eq.true,university_email.in.(${KNOWN_ADMIN_EMAILS.map(e => `"${e}"`).join(',')})`);

      if (adminProfiles && adminProfiles.length > 0) {
        const notifs = adminProfiles.map((adm: any) => ({
          user_id: adm.id,
          from_user_id: requesterId,
          type: 'song_request',
          title: '🎵 New Song Request!',
          message: `${requesterName} requested "${payload.track_name}" by ${payload.track_artist}`,
          action_url: '/sparx/music?room=Campus_PCO_247',
          data: {
            type: 'song_request',
            track_name: payload.track_name,
            track_artist: payload.track_artist,
            track_image: payload.track_image,
            requester: requesterName
          },
          read: false,
          created_at: new Date().toISOString()
        }));
        await supabase.from('notifications').insert(notifs);
      }
    } catch (nErr) {
      console.debug('[PCO Request API] Admin notification insert error (non-fatal):', nErr);
    }

    // Broadcast Realtime events to live DJ console
    try {
      supabase.channel('pco_quick_panel_requests').send({
        type: 'broadcast',
        event: 'PCO_SONG_REQUEST',
        payload: data
      });
      supabase.channel('pco_quick_panel_requests').send({
        type: 'broadcast',
        event: 'PCO_REQUEST_NOTIFICATION',
        payload: {
          requester: requesterName,
          track,
          requestId: data?.id
        }
      });
      supabase.channel('campus_pco_live_chat').send({
        type: 'broadcast',
        event: 'PCO_SONG_REQUEST',
        payload: data
      });
    } catch (_) {}

    return NextResponse.json({ success: true, data });

  } catch (err: any) {
    console.error('[PCO Request API] Unexpected error:', err);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
