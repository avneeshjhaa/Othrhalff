/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  optimizeFonts: false,
  poweredByHeader: false, // Prevents X-Powered-By: Next.js tech fingerprinting
  // SEO-03: /vs/omegle is the single canonical Omegle comparison page.
  // The old /vs-omegle URL permanently redirects to it.
  async redirects() {
    return [
      {
        source: '/vs-omegle',
        destination: '/vs/omegle',
        permanent: true,
      },
    ];
  },
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || process.env.VITE_API_URL,
  },
  async headers() {
    // Strict CSP. Notes on the allowances below (kept as narrow as the app allows):
    // - script-src 'unsafe-inline' is required: app/layout.tsx ships an inline
    //   Google Analytics snippet, and Next.js itself emits inline scripts.
    //   No 'unsafe-eval' anywhere.
    // - www.googletagmanager.com: the GA4 tag loaded in app/layout.tsx.
    // - connect-src covers the backends the app actually talks to: Supabase
    //   (REST + Realtime), the Render API (testing-of.onrender.com), Agora and
    //   LiveKit realtime media, Google Analytics, and the music/lyrics APIs
    //   (Saavn, lrclib). Supabase/LiveKit hosts are env-dependent, hence the
    //   *.supabase.co / *.livekit.cloud wildcards.
    // - img-src / media-src stay broad (https:) because user and catalogue
    //   media comes from many hosts (DiceBear, Unsplash, Saavn CDN, Supabase
    //   Storage, placeholder images); tightening those needs an allow-list of
    //   media hosts first.
    // - frame-src allows YouTube embeds used by react-player.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net https://fonts.cdnfonts.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://testing-of.onrender.com https://*.agora.io wss://*.agora.io https://*.livekit.cloud wss://*.livekit.cloud https://www.google-analytics.com https://www.googletagmanager.com https://api.dicebear.com https://saavnapi-nine.vercel.app https://lrclib.net https://*.youtube.com https://*.googlevideo.com",
      "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'upgrade-insecure-requests',
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: csp,
          },
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
