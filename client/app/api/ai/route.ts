import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit } from '../_lib/rateLimit';

export const dynamic = 'force-dynamic';

function getAiClient() {
  // Server-only key. NEXT_PUBLIC_/VITE_ fallbacks are deliberately removed:
  // a public-prefixed key would be bundled into the client and is not a secret.
  const apiKey = process.env.GEMINI_API_KEY || '';

  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return null;
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Verify the caller's Supabase JWT. Returns the authenticated user, or null
 * when there is no token, the token is invalid/expired, or auth is not
 * configured. Never trusts a client-supplied id or an unverified header.
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

function sanitizeText(input: unknown, maxLen = 100): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[^\w\s.,!?-]/gi, '').trim().substring(0, maxLen);
}

function sanitizeInterests(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(i => sanitizeText(i, 40))
    .filter(Boolean)
    .slice(0, 10);
}

export async function POST(req: NextRequest) {
  // 1. Rate Limiting: 15 AI requests per minute per IP
  const rateLimit = checkRateLimit(req, 15, 60, 'ai');
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: 'Too many AI requests. Please slow down.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.resetInSeconds) },
      }
    );
  }

  try {
    // 2. Require a verified Supabase JWT — this was an unauthenticated free
    // Gemini proxy. Callers (client/src/services/geminiService.ts) must now
    // send `Authorization: Bearer <session.access_token>`; unauthenticated
    // calls get 401 and the client falls back to its canned text.
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await req.json();
    const { type, myInterests, theirProfile } = body;

    const sanitizedMyInterests = sanitizeInterests(myInterests);
    const sanitizedTheirBranch = sanitizeText(theirProfile?.branch || 'General', 50);
    const sanitizedTheirInterests = sanitizeInterests(theirProfile?.interests);
    const sanitizedTheirAnonId = sanitizeText(theirProfile?.anonymousId || 'User', 30);

    const ai = getAiClient();
    if (!ai) {
      // Server-only GEMINI_API_KEY is missing/unset — fail closed with a
      // generic 503 instead of silently returning canned text as success.
      return NextResponse.json(
        { error: 'AI service temporarily unavailable' },
        { status: 503 }
      );
    }

    if (type === 'icebreaker') {
      const prompt = `
        I am an anonymous student (Interests: ${sanitizedMyInterests.join(', ')}).
        I just matched with another student (ID: ${sanitizedTheirAnonId}, Branch: ${sanitizedTheirBranch}, Interests: ${sanitizedTheirInterests.join(', ')}).
        
        Generate a short, fun, and safe ice breaker message I could send to start the conversation.
        Keep it under 30 words. No hashtags.
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const text = response.text?.trim() || "Hey! What's your favorite thing about your campus?";
      return NextResponse.json({ text });
    }

    if (type === 'compatibility') {
      const prompt = `
        Analyze the compatibility between two students based on interests.
        Student A: ${sanitizedMyInterests.join(', ')}
        Student B (${sanitizedTheirBranch}): ${sanitizedTheirInterests.join(', ')}
        
        Give a 1-sentence fun summary of why they might get along.
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const text = response.text?.trim() || 'You both seem to have unique tastes and vibrant hobbies!';
      return NextResponse.json({ text });
    }

    return NextResponse.json({ error: 'Invalid AI request type' }, { status: 400 });
  } catch (error: any) {
    // Never leak provider error details, and never report failure as HTTP 200.
    console.error('[AI Route Error]:', error);
    return NextResponse.json(
      { error: 'AI service temporarily unavailable' },
      { status: 502 }
    );
  }
}
