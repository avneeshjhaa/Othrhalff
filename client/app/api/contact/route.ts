import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit } from '../_lib/rateLimit';

export const dynamic = 'force-dynamic';

const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    '';
const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    '';

// Never create a client with empty-string credentials: a missing URL/key
// must fail closed with 503 instead of producing a broken client.
const supabaseAdmin = supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    })
    : null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Best-effort auth for an anonymous-allowed form: if the caller sends a
 * valid Supabase JWT, return its user id; otherwise return null (anonymous).
 * A client-supplied user_id is NEVER accepted — anonymous tickets store null.
 */
async function getOptionalAuthenticatedUserId(req: NextRequest): Promise<string | null> {
    const header = req.headers.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;

    const authUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
    if (!authUrl || !anonKey) return null;

    try {
        const authClient = createClient(authUrl, anonKey, { auth: { persistSession: false } });
        const { data, error } = await authClient.auth.getUser(token);
        if (error || !data?.user) return null;
        return data.user.id;
    } catch (err) {
        console.error('Optional auth check failed in /api/contact:', err);
        return null;
    }
}

export async function POST(req: NextRequest) {
    // 1. Rate Limiting: Max 5 tickets per 15 minutes per IP
    const rateLimit = checkRateLimit(req, 5, 15 * 60, 'contact');
    if (!rateLimit.success) {
        return NextResponse.json(
            { error: 'Too many submissions. Please wait before submitting another ticket.' },
            {
                status: 429,
                headers: { 'Retry-After': String(rateLimit.resetInSeconds) },
            }
        );
    }

    try {
        if (!supabaseAdmin) {
            return NextResponse.json(
                { error: 'Support service temporarily unavailable. Please try again later.' },
                { status: 503 }
            );
        }

        const body = await req.json();
        // NOTE: any client-supplied `user_id` is ignored entirely. Logged-in
        // users are identified from their verified JWT (see below); everyone
        // else is stored as anonymous (null). Auth is NOT required — the
        // contact form may be submitted anonymously.
        const { email, category, message } = body;

        const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
        if (
            !cleanEmail ||
            cleanEmail.length < 3 ||
            cleanEmail.length > 150 ||
            !EMAIL_RE.test(cleanEmail)
        ) {
            return NextResponse.json(
                { error: 'Please provide a valid email address.' },
                { status: 400 }
            );
        }

        if (!message || typeof message !== 'string' || !message.trim()) {
            return NextResponse.json(
                { error: 'Please provide a message.' },
                { status: 400 }
            );
        }

        if (message.trim().length > 3000) {
            return NextResponse.json(
                { error: 'Message cannot exceed 3000 characters.' },
                { status: 400 }
            );
        }

        const sanitizedCategory = typeof category === 'string'
            ? category.replace(/[\r\n]/g, '').trim().substring(0, 60) || 'General Inquiry'
            : 'General Inquiry';

        const userId = await getOptionalAuthenticatedUserId(req);

        const { data, error } = await supabaseAdmin
            .from('support_tickets')
            .insert({
                user_id: userId,
                email: cleanEmail,
                category: sanitizedCategory,
                message: message.trim(),
                status: 'open', // Always forced to open - cannot be forged by client
            })
            .select('id, category, status, created_at')
            .single();

        if (error) {
            console.error('Server error inserting support ticket:', error);
            return NextResponse.json(
                { error: 'Failed to submit support ticket. Please try again later.' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            ticket: data,
        });
    } catch (err: any) {
        console.error('Unexpected error in /api/contact:', err);
        return NextResponse.json(
            { error: 'Internal server error.' },
            { status: 500 }
        );
    }
}
