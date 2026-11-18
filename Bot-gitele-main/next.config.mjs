// Browsers PUT ZIP chunks straight to Supabase Storage, so that origin must be allowed in connect-src.
let supabaseOrigin = "https://*.supabase.co";
try {
  if (process.env.SUPABASE_URL) supabaseOrigin = new URL(process.env.SUPABASE_URL).origin;
} catch {}
/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value:
              `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${supabaseOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default nextConfig;
