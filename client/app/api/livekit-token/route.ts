import { AccessToken } from 'livekit-server-sdk';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit } from '../_lib/rateLimit';

export const dynamic = 'force-dynamic';

const SAFE_ROOM_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Verify the caller's Supabase JWT. Returns the authenticated user, or null
 * when there is no token, the token is invalid/expired, or auth is not
 * configured. A bare `Authorization` header is never trusted on its own.
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
  // 1. Rate Limiting: Max 20 token requests per minute per IP
  const rateLimit = checkRateLimit(req, 20, 60, 'livekit');
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Too many token requests. Please wait a moment.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.resetInSeconds) },
      }
    );
  }

  try {
    // 2. Require a verified Supabase JWT. Identity is derived server-side
    // from auth.uid() — any client-supplied `identity` query param is
    // ignored entirely, so callers can no longer mint tokens as someone else.
    //
    // BREAKING CHANGE (callers must be updated): the playground page
    // (client/app/playground/page.tsx) currently calls this endpoint with
    // `identity=<currentUser.id>` and NO Authorization header. That call
    // will now receive 401. The page must send its Supabase session token
    // (`Authorization: Bearer <session.access_token>`, obtainable via
    // `supabase.auth.getSession()`) so the server can verify the caller.
    // Anonymous visitors with no Supabase session can no longer join the
    // playground voice room; if anonymous access is a product requirement,
    // it needs a separate, deliberately anonymous token flow — do not
    // re-open this endpoint to unauthenticated callers.
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const identity = user.id;

    const { searchParams } = new URL(req.url);
    const rawRoom = searchParams.get('room') || 'playground-global-voice';
    const rawName = searchParams.get('name') || 'Campus Student';

    // Room validation: non-empty, pattern-checked, max 64 chars.
    if (!SAFE_ROOM_REGEX.test(rawRoom)) {
      return NextResponse.json({ error: 'Invalid room identifier format' }, { status: 400 });
    }

    const room = rawRoom.substring(0, 64);
    const name = rawName.replace(/[\r\n]/g, '').trim().substring(0, 50) || 'Campus Student';

    // LIMITATION: no participant check is performed here. This file has no
    // match/room lookup available, so any authenticated user can request a
    // token for any pattern-valid room name (e.g. by guessing another pair's
    // call room). Room membership/authorization should be enforced by a
    // match or call-room lookup before minting; until that exists, treat
    // room names as non-secret and do not rely on this endpoint alone to
    // keep private call rooms private.

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL;

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: 'Voice service temporarily unavailable' },
        { status: 500 }
      );
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name,
      ttl: '1h', // 1-hour secure TTL
    });

    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    return NextResponse.json({
      token,
      url: livekitUrl,
      identity,
      room,
    });
  } catch (error: any) {
    console.error('[LiveKit Token Error]:', error);
    return NextResponse.json({ error: 'Internal server error while generating voice token' }, { status: 500 });
  }
}
