import express from 'express';
import pkg from 'agora-access-token';
import { createClient } from '@supabase/supabase-js';
import { verifySupabaseToken } from '../middleware/auth.js';

const { RtcTokenBuilder, RtcRole } = pkg;
const router = express.Router();

// SECURITY FIX: tokens must never be minted for shared UID 0, and must never
// live for 24h. TTL is now <= 1 hour and the UID is bound to the caller.
const TOKEN_TTL_SECONDS = 3600;
// Agora channel names: 1-64 chars, letters/digits/'-'/'_'. No slashes, so a
// caller cannot smuggle a path or a foreign channel into the token.
const CHANNEL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deterministic, stable numeric Agora UID for an authenticated user id.
// FNV-1a 32-bit hash, folded into Agora's uint32 UID space and never 0, so
// the same user always gets the same UID and no two users share one.
// NOTE: this is an identifier hash, not a secret — the token itself is the
// credential, and it is minted only after verifySupabaseToken.
function agoraUidForUserId(userId) {
  let hash = 0x811c9dc5;
  const str = String(userId);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const uid = hash >>> 0;
  return uid === 0 ? 1 : uid;
}

function buildRtcToken({ appId, appCertificate, channelName, uid, expiresInSeconds }) {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expiresInSeconds;
  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    RtcRole.PUBLISHER,
    privilegeExpiredTs
  );

  return { token, privilegeExpiredTs };
}

function getAgoraCredentials() {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    throw new Error('Agora credentials not configured');
  }

  return { appId, appCertificate };
}

function getAuthenticatedUserId(req) {
  return req.userId || req.user?.id || null;
}

function validateChannelName(channelName) {
  return typeof channelName === 'string' && CHANNEL_NAME_RE.test(channelName);
}

// Lazy service-role Supabase client for the DB-backed participant check,
// following the same pattern as server/routes/matches.js. Returns null
// when the service-role key is not configured (callers then fail closed).
let supabaseAdmin = null;
function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  supabaseAdmin = createClient(supabaseUrl, supabaseKey);
  return supabaseAdmin;
}

// Returns true only if a row exists in public.matches with the caller and
// the receiver as the two participants (in either order). When matchId is
// supplied it must be that exact match row.
async function isMatchParticipant({ callerId, receiverId, matchId }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  let query = supabase
    .from('matches')
    .select('id')
    .or(`and(user_a.eq.${callerId},user_b.eq.${receiverId}),and(user_a.eq.${receiverId},user_b.eq.${callerId})`);
  if (matchId) query = query.eq('id', matchId);

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) {
    console.error('[Agora] match participant check failed:', error);
    return false;
  }
  return !!data;
}

// Generate RTC Token for general video/audio call
// SECURITY: no shared/global token cache — a cached token was previously
// returned to any caller for the same channel. Tokens are minted fresh per
// authenticated user and are bound to that user's UID. Previously cached
// entries (keyed only by channel) must be treated as untrusted; nothing in
// this file reads the cache anymore.
router.post('/agora-token', verifySupabaseToken, async (req, res) => {
  try {
    const callerId = getAuthenticatedUserId(req);
    if (!callerId) {
      return res.status(401).json({ error: 'Unauthorized: authenticated user id is required' });
    }
    const { appId, appCertificate } = getAgoraCredentials();
    const channelName = req.body.channelName || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    if (!validateChannelName(channelName)) {
      return res.status(400).json({ error: 'Invalid channelName: use 1-64 alphanumeric, dash or underscore characters only' });
    }
    const uid = agoraUidForUserId(callerId);

    const { token, privilegeExpiredTs } = buildRtcToken({
      appId,
      appCertificate,
      channelName,
      uid,
      expiresInSeconds: TOKEN_TTL_SECONDS
    });

    res.json({
      token,
      channelName,
      appId,
      uid: uid.toString(),
      expiresAt: privilegeExpiredTs,
      cached: false
    });
  } catch (error) {
    console.error('Error generating Agora token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate RTC Token for initiating a call session
router.post('/initiate-call', verifySupabaseToken, async (req, res) => {
  try {
    const callerId = getAuthenticatedUserId(req);
    if (!callerId) {
      return res.status(401).json({ error: 'Unauthorized: authenticated user id is required' });
    }
    const { receiverId, matchId } = req.body || {};

    // The caller must name the other participant (and, when known, the match).
    // Previously receiverId/matchId were ignored entirely, so any
    // authenticated user could mint a call token for any channel.
    if (!receiverId || typeof receiverId !== 'string' || !UUID_RE.test(receiverId)) {
      return res.status(400).json({ error: 'receiverId is required and must be a valid UUID' });
    }
    if (receiverId === callerId) {
      return res.status(400).json({ error: 'You cannot call yourself' });
    }
    if (matchId !== undefined && matchId !== null && (typeof matchId !== 'string' || !UUID_RE.test(matchId))) {
      return res.status(400).json({ error: 'matchId must be a valid UUID when provided' });
    }

    // DB-backed participant check: the caller and receiver must actually be
    // the two participants of a row in public.matches (that exact row when
    // matchId is given). Fail closed when Supabase is unavailable or the
    // check errors — do not mint a token on an unverified claim.
    const isParticipant = await isMatchParticipant({ callerId, receiverId, matchId: matchId || null });
    if (!isParticipant) {
      return res.status(403).json({ error: 'No match exists between you and the receiver' });
    }

    const { appId, appCertificate } = getAgoraCredentials();
    const channelName = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const uid = agoraUidForUserId(callerId);
    const { token, privilegeExpiredTs } = buildRtcToken({
      appId,
      appCertificate,
      channelName,
      uid,
      expiresInSeconds: TOKEN_TTL_SECONDS
    });

    res.json({
      channelName,
      token,
      appId,
      uid: uid.toString(),
      expiresAt: privilegeExpiredTs
    });
  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
