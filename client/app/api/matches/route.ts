import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit } from '../_lib/rateLimit';

export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
}) : null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Verify the caller's Supabase JWT. Returns the authenticated user, or null
 * when there is no token, the token is invalid/expired, or auth is not
 * configured. Never trusts a client-supplied userId or an unverified header.
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

export async function GET(req: NextRequest) {
  // Rate limiting: max 30 match-list requests per minute per IP.
  const rateLimit = checkRateLimit(req, 30, 60, 'matches');
  if (!rateLimit.success) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.resetInSeconds) } }
    );
  }

  try {
    // 0. Require a verified Supabase JWT.
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const userId = searchParams.get('userId');

    if (!userId || !UUID_RE.test(userId)) {
      return NextResponse.json({ success: false, error: 'Valid userId required' }, { status: 400 });
    }

    // A caller may only list their own matches — never anyone else's.
    if (userId !== user.id) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Database service unavailable' }, { status: 503 });
    }

    // 1. Fetch matches where user is participant
    const { data: matchRows, error: matchError } = await supabase
      .from('matches')
      .select('id, user_a, user_b, created_at')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (matchError) {
      console.error('API /api/matches fetch error:', matchError);
      return NextResponse.json({ success: false, error: 'Unable to load matches. Please try again later.' }, { status: 500 });
    }

    if (!matchRows || matchRows.length === 0) {
      return NextResponse.json({ success: true, matches: [] });
    }

    // 2. Fetch profiles of matched partners.
    // NOTE: real_name and dob are deliberately NOT selected or returned.
    // The matches table has no mutual-status column, so this route cannot
    // distinguish a confirmed mutual match from any other row; per the
    // security audit, both fields are therefore omitted for every partner.
    // Chat previews only need the anonymous identity. If the product later
    // confirms matches rows are always mutual, realName may be re-added —
    // dob should stay omitted (a chat preview has no need for it).
    const partnerIds = Array.from(new Set(matchRows.map(m => m.user_a === userId ? m.user_b : m.user_a)));
    const matchIds = matchRows.map(m => m.id);

    const { data: profiles, error: profError } = await supabase
      .from('profiles')
      .select('id, anonymous_id, avatar, university, branch, year, bio, gender, interests, is_verified, is_premium')
      .in('id', partnerIds);

    if (profError) {
      console.warn('API /api/matches profile fetch warning:', profError);
    }

    const profilesMap = new Map((profiles || []).map(p => [p.id, p]));

    // 3. Fetch latest messages for these matches
    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select('id, match_id, sender_id, text, created_at, is_read')
      .in('match_id', matchIds)
      .order('created_at', { ascending: false });

    if (msgError) {
      console.warn('API /api/matches messages fetch warning:', msgError);
    }

    // Build latest message and unread count per match
    const lastMsgMap = new Map<string, { text: string; time: number }>();
    const unreadMap = new Map<string, number>();

    (messages || []).forEach(msg => {
      if (!lastMsgMap.has(msg.match_id)) {
        lastMsgMap.set(msg.match_id, {
          text: msg.text || '',
          time: msg.created_at ? new Date(msg.created_at).getTime() : Date.now()
        });
      }
      if (msg.sender_id !== userId && !msg.is_read) {
        unreadMap.set(msg.match_id, (unreadMap.get(msg.match_id) || 0) + 1);
      }
    });

    // 4. Construct ChatPreview response
    const formatted = matchRows.map(m => {
      const partnerId = m.user_a === userId ? m.user_b : m.user_a;
      const p = (profilesMap.get(partnerId) || {}) as any;
      const last = lastMsgMap.get(m.id);

      return {
        id: m.id,
        partner: {
          id: partnerId,
          anonymousId: p.anonymous_id || 'Unknown',
          avatar: p.avatar,
          university: p.university,
          branch: p.branch,
          year: p.year,
          isVerified: !!p.is_verified,
          gender: p.gender || '',
          bio: p.bio || '',
          interests: p.interests || [],
          matchPercentage: 0,
          distance: 'Connected'
        },
        lastMessage: last?.text || null,
        lastMessageTime: last?.time || (m.created_at ? new Date(m.created_at).getTime() : null),
        unreadCount: unreadMap.get(m.id) || 0
      };
    });

    // Deduplicate partners (one conversation preview per partner)
    const uniqueChats: typeof formatted = [];
    const seenPartners = new Set<string>();
    for (const chat of formatted) {
      if (!seenPartners.has(chat.partner.id)) {
        seenPartners.add(chat.partner.id);
        uniqueChats.push(chat);
      }
    }

    uniqueChats.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

    return NextResponse.json({ success: true, matches: uniqueChats });
  } catch (err: any) {
    console.error('API /api/matches fatal error:', err);
    return NextResponse.json({ success: false, error: 'Unable to load matches. Please try again later.' }, { status: 500 });
  }
}
