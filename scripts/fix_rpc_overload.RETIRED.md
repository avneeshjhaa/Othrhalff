# RETIRED — scripts/fix_rpc_overload.sql

**Status: retired on 2026-11-14 (branch `fix/security-audit-2026-11-14`). Do not re-apply it.**

## Why it was retired

`fix_rpc_overload.sql` dropped and recreated the canonical matching RPCs
`get_potential_matches` and `get_skipped_profiles` **without any auth check**
(no `auth.uid()` guard) and then granted `EXECUTE` on both to `anon`:

```sql
GRANT EXECUTE ON FUNCTION public.get_potential_matches(uuid, text, text, integer, integer)
  TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_skipped_profiles(uuid, text, text, integer, integer)
  TO authenticated, anon, service_role;
```

Applied after `security_hardening_v2.sql`, it silently **re-opened the hardened
RPCs**: anyone — authenticated as any user, or anonymous — could query another
user's potential-match deck / skipped profiles (BOLA / IDOR, the same leak the
hardening migration closed). It also lacked `SET search_path = public, pg_temp`.

## What to use instead

Use `scripts/security_hardening_v2.sql` only. It defines the same two functions
with:

- `IF auth.uid() IS NULL OR auth.uid() != <user-id param> THEN RAISE EXCEPTION ...`
- `SECURITY DEFINER` with `SET search_path = public, pg_temp`
- `REVOKE EXECUTE ... FROM public, anon; GRANT EXECUTE ... TO authenticated;`

## If the overload error comes back

PostgreSQL error `42P13` ("cannot change return type of existing function")
means an old overload is still present. Fix it by dropping the stale overload
signatures explicitly (as `security_hardening_v2.sql` already does with
`DROP FUNCTION IF EXISTS ...` per signature) — never by re-running a
no-auth-check recreation of these functions.
