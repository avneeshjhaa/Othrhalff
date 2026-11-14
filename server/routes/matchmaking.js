import express from 'express';
import pkg from 'agora-access-token';
import { createClient } from '@supabase/supabase-js';
import { verifySupabaseToken } from '../middleware/auth.js';

const { RtcTokenBuilder, RtcRole } = pkg;
const router = express.Router();

const TOKEN_TTL_SECONDS = 3600;

// Deterministic, stable numeric Agora UID for an authenticated user id
// (FNV-1a 32-bit hash, never 0). Each participant gets their own token bound
// to their own UID — never the shared UID 0. See server/routes/agora.js.
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

function buildAgoraToken(channelName, userId) {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    return { appId: '', token: '', uid: null };
  }

  const uid = agoraUidForUserId(userId);
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + TOKEN_TTL_SECONDS;
  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    RtcRole.PUBLISHER,
    privilegeExpiredTs
  );

  return { appId, token, uid };
}

// In-memory atomic matchmaking queue
const queue = new Map();
// Matched pairings ready for pickup
const matches = new Map();

// Lazy Supabase realtime broadcast client
let supabaseClient = null;
let realtimeChannel = null;

// Normalize university strings so 'IIIT NRR' / 'iiit nrr, chhattisgarh' compare equal.
function normalizeUniversity(univ) {
  return String(univ || '').trim().toLowerCase().split(',')[0].trim();
}

// Blocked-user cache (60s TTL) so we don't hammer Supabase on every pairing check.
let blockedCache = null;

async function getBlockedPairs() {
  if (blockedCache && Date.now() - blockedCache.fetchedAt < 60000) {
    return blockedCache.data;
  }
  const map = new Map();
  try {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (url && key) {
      const client = supabaseClient || createClient(url, key);
      // Fetch all blocks (small table); build blocker -> set(blocked) adjacency both ways.
      const { data, error } = await client.from('blocked_users').select('blocker_id, blocked_id');
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          if (!map.has(row.blocker_id)) map.set(row.blocker_id, new Set());
          if (!map.has(row.blocked_id)) map.set(row.blocked_id, new Set());
          map.get(row.blocker_id).add(row.blocked_id);
          map.get(row.blocked_id).add(row.blocker_id);
        }
      }
    }
  } catch (err) {
    console.warn('[Matchmaking] blocked_users fetch failed (pairing without block filter):', err?.message || err);
  }
  blockedCache = { data: map, fetchedAt: Date.now() };
  return map;
}


// Service-role Supabase client, following the pattern in
// server/routes/agora.js: service-role key only (never the anon key), so
// this lookup bypasses RLS and reads the caller's own profile row.
// Returns null when the service-role key is not configured; callers then
// fail closed (see getCallerProfile / effectiveScope below).
let supabaseAdmin = null;
function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  supabaseAdmin = createClient(supabaseUrl, supabaseKey);
  return supabaseAdmin;
}

// Per-user profile cache (60s TTL, like the blocked-user cache) so every
// queue poll doesn't re-query Supabase for the same caller.
const profileCache = new Map(); // userId -> { data, fetchedAt }

// Server-side profile lookup for the VERIFIED user id (req.userId /
// req.user.id). Returns { university, anonymous_id } or null when the
// lookup is unavailable (no service-role key, no profile row, or a query
// error). Never throws — callers treat null as "unknown" and fail closed.
async function getCallerProfile(userId) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < 60000) return cached.data;
  let data = null;
  try {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const { data: row, error } = await supabase
        .from('profiles')
        .select('university, anonymous_id')
        .eq('id', userId)
        .maybeSingle();
      if (!error && row) {
        data = row;
      } else if (error) {
        console.warn('[Matchmaking] profiles lookup failed (treating university as unknown):', error.message);
      }
    }
  } catch (err) {
    console.warn('[Matchmaking] profiles lookup failed (treating university as unknown):', err?.message || err);
  }
  profileCache.set(userId, { data, fetchedAt: Date.now() });
  return data;
}

function getRealtimeChannel() {
  if (realtimeChannel) return realtimeChannel;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Matchmaking] Supabase credentials not found; realtime broadcast unavailable, relying on polling fallback');
    return null;
  }

  try {
    if (!supabaseClient) {
      supabaseClient = createClient(supabaseUrl, supabaseKey);
    }
    realtimeChannel = supabaseClient.channel('discover-pool', {
      config: {
        broadcast: { ack: false }
      }
    });
    realtimeChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[Matchmaking] Realtime discover-pool broadcast channel active on server');
      }
    });
    return realtimeChannel;
  } catch (err) {
    console.warn('[Matchmaking] Failed to init realtime broadcast channel:', err);
    return null;
  }
}

// Warm up realtime connection
setTimeout(() => {
  getRealtimeChannel();
}, 1000);

// Periodic cleanup of stale waiting users (>45s)
setInterval(() => {
  const now = Date.now();
  for (const [userId, item] of queue.entries()) {
    if (now - item.joinedAt > 45000) {
      queue.delete(userId);
    }
  }
  for (const [userId, match] of matches.entries()) {
    if (now - match.createdAt > 30000) {
      matches.delete(userId);
    }
  }
}, 10000);

/**
 * POST /api/matchmaking/queue
 * Server-authoritative atomic matchmaking queue
 *
 * ANONYMITY (audit finding #6): the server NEVER accepts, stores, or
 * echoes a real name, avatar photo, or university to a match partner.
 * req.body carries only anonymousId (the anonymous label), mode, scope
 * and recentPartners. Any name/avatar/university a client sends is
 * ignored outright. The university used for CAMPUS matching comes from
 * the profiles table via the verified JWT user id, and both match
 * payloads carry only the partner's anonymous label as partnerName.
 */
router.post('/matchmaking/queue', verifySupabaseToken, async (req, res) => {
  try {
    // SECURITY: the UID a token is bound to must come from the verified
    // JWT (req.userId / req.user.id), never from req.body.userId, which any
    // caller could forge to mint a token as someone else.
    const userId = req.userId || req.user?.id;
    // SECURITY (audit #6): accept ONLY anonymousId (+ mode, scope,
    // recentPartners) from req.body. name / avatar / university are never
    // read here — an old or malicious client could inject a real name and
    // have it delivered to a stranger.
    const { anonymousId, mode = 'VIDEO', scope = 'GLOBAL', recentPartners = [] } = req.body || {};
    const safeRecentPartners = Array.isArray(recentPartners) ? recentPartners : [];

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // University + anonymous label, looked up server-side from the
    // profiles table for the VERIFIED user id — never from the client.
    const profile = await getCallerProfile(userId);
    let myUnivNorm = normalizeUniversity(profile?.university);
    if (myUnivNorm === 'global' || myUnivNorm === 'unspecified') myUnivNorm = '';

    // Anonymous label: prefer the DB-backed anonymous_id (a client cannot
    // forge it); fall back to the client-supplied anonymousId, sanitised
    // to a short plain label, and finally to the generic fallback.
    // Residual note: when the profiles lookup is unavailable the label is
    // unverified client input, so it is length-capped and never a photo,
    // real name field, or university — nothing else identifying is sent.
    const rawAnonymousId = typeof anonymousId === 'string' ? anonymousId.trim().slice(0, 64) : '';
    const myAnonymousId =
      (profile?.anonymous_id && String(profile.anonymous_id).trim()) ||
      rawAnonymousId ||
      'Anonymous Student';

    // FAIL CLOSED on CAMPUS scope: campus matching requires the caller's
    // university from the server-side lookup above. If the lookup is
    // unavailable (no service-role key, no profile row, or no university
    // on file) the request is treated as GLOBAL — never accept a
    // client-supplied university, and never campus-match on an empty one.
    const effectiveScope = scope === 'CAMPUS' && myUnivNorm ? 'CAMPUS' : 'GLOBAL';

    const blockedPairs = await getBlockedPairs();
    const myBlocks = blockedPairs.get(userId) || new Set();

    // 1. Check if user already has a pending matched result
    if (matches.has(userId)) {
      const match = matches.get(userId);
      matches.delete(userId);
      return res.json({ status: 'MATCHED', ...match });
    }

    const now = Date.now();

    // 2. Search queue for a compatible partner atomically
    let matchedPartner = null;

    for (const [otherId, other] of queue.entries()) {
      if (otherId === userId) continue;
      if (other.mode !== mode) continue;
      if (myBlocks.has(otherId)) continue;                       // never pair blocked users
      const otherBlocks = blockedPairs.get(otherId);
      if (otherBlocks && otherBlocks.has(userId)) continue;

      // Scope validation on NORMALIZED, server-side universities.
      // effectiveScope is CAMPUS only when the caller's university was
      // verified via the profiles lookup; otherwise this is GLOBAL.
      // A CAMPUS-only partner (other.scope === 'CAMPUS', stored only when
      // their own university was verified) is skipped when the caller has
      // no verified university or a different one.
      if (effectiveScope === 'CAMPUS' && other.univNorm !== myUnivNorm) continue;
      if (other.scope === 'CAMPUS' && other.univNorm && other.univNorm !== myUnivNorm) continue;

      // Recent partner avoid list
      if (safeRecentPartners.includes(otherId)) continue;
      if (other.recentPartners && other.recentPartners.includes(userId)) continue;

      // TEXT PRIORITY: prefer partners already waiting longest so text chats pair fast,
      // and within same mode prefer earlier joinedAt (FIFO). Video keeps same FIFO.
      if (!matchedPartner || other.joinedAt < matchedPartner.joinedAt) {
        matchedPartner = other;
      }
    }

    if (matchedPartner) {
      queue.delete(matchedPartner.userId);
      const channelName = `discover_${mode.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      let appId = '';
      let token = '';
      let uid = null;
      let partnerToken = '';
      let partnerUid = null;

      if (mode === 'VIDEO') {
        // Per-participant tokens: each side's token is bound to its own UID.
        // A single shared token (previously UID 0 for both) must not be
        // handed to both participants.
        const callerCreds = buildAgoraToken(channelName, userId);
        const partnerCreds = buildAgoraToken(channelName, matchedPartner.userId);
        appId = callerCreds.appId;
        token = callerCreds.token;
        uid = callerCreds.uid;
        partnerToken = partnerCreds.token;
        partnerUid = partnerCreds.uid;
      }

      // ANONYMITY (audit #6): both payloads carry ONLY the partner's
      // anonymous label as partnerName. No partnerAvatar / partnerUniversity
      // fields exist anymore, so no real name, photo, or university can be
      // echoed to a stranger — including via the Realtime broadcast below,
      // which spreads matchPayloadForPartner verbatim.
      const matchPayloadForUser = {
        partnerId: matchedPartner.userId,
        partnerName: matchedPartner.anonymousId || 'Anonymous Student',
        channelName,
        appId,
        token,
        uid: uid === null ? undefined : uid.toString(),
        mode,
        createdAt: now
      };

      const matchPayloadForPartner = {
        partnerId: userId,
        partnerName: myAnonymousId,
        channelName,
        appId,
        token: partnerToken,
        uid: partnerUid === null ? undefined : partnerUid.toString(),
        mode,
        createdAt: now
      };

      // 1. Save match for partner to pick up on their next poll (guaranteed fallback)
      matches.set(matchedPartner.userId, matchPayloadForPartner);

      // 2. Instant Realtime Notification to partner via Supabase Realtime broadcast (<50ms latency)
      const channel = getRealtimeChannel();
      if (channel) {
        channel.send({
          type: 'broadcast',
          event: 'MATCH_FOUND',
          payload: {
            targetId: matchedPartner.userId,
            ...matchPayloadForPartner
          }
        }).catch(err => {
          console.warn('[Matchmaking] Realtime broadcast error (falling back to poll):', err?.message || err);
        });
      }

      return res.json({
        status: 'MATCHED',
        ...matchPayloadForUser
      });
    }

    // 3. No immediate match; register into queue. Only the anonymous
    // label and the server-verified NORMALIZED university are stored —
    // no name, avatar, or raw university string ever enters the queue.
    queue.set(userId, {
      userId,
      anonymousId: myAnonymousId,
      univNorm: myUnivNorm,
      mode,
      scope: effectiveScope,
      recentPartners: safeRecentPartners,
      joinedAt: now
    });

    return res.json({ status: 'SEARCHING' });
  } catch (error) {
    console.error('[Matchmaking Queue Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/matchmaking/leave
 * Cancel searching or leave queue
 */
router.post('/matchmaking/leave', verifySupabaseToken, async (req, res) => {
  try {
    // Authenticated id only (see /matchmaking/queue above).
    const userId = req.userId || req.user?.id;
    if (userId) {
      queue.delete(userId);
      matches.delete(userId);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
