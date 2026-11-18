import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { consumeRateLimit } from "@/lib/rate-limit";
import { consumeLoginStateWithMessage } from "@/lib/auth/oauth-state";
import { exchangeCode, fetchGithubProfile } from "@/lib/github/oauth";
import { linkGithubAccount } from "@/lib/github/linking";
import { listAccessibleRepos } from "@/lib/github/repos";
import { logActivity } from "@/lib/activity";
import { markLoginResult, sendProfileCard } from "@/lib/telegram/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONNECT_CSS = `
*{box-sizing:border-box}html{background:#000}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:20px;background:#000;color:#f5f6f8;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;position:relative}
body::before,body::after{content:"";position:fixed;border-radius:50%;filter:blur(70px);pointer-events:none;z-index:0}
body::before{width:70vmax;height:70vmax;top:-35vmax;left:-25vmax;background:radial-gradient(circle,rgba(47,111,232,.38),transparent 66%);animation:da 20s ease-in-out infinite alternate}
body::after{width:60vmax;height:60vmax;right:-28vmax;bottom:-30vmax;background:radial-gradient(circle,var(--glow),transparent 66%);animation:db 24s ease-in-out infinite alternate}
.ok{--glow:rgba(70,220,140,.26);--c:#5fdc95}.bad{--glow:rgba(255,100,100,.26);--c:#ff7b7b}
@keyframes da{to{transform:translate(12vmax,9vmax) scale(1.15)}}@keyframes db{to{transform:translate(-10vmax,-8vmax) scale(1.1)}}
.card{position:relative;z-index:1;width:min(100%,380px);padding:34px 24px 28px;text-align:center;border:1px solid rgba(255,255,255,.1);border-radius:30px;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.022));-webkit-backdrop-filter:blur(24px) saturate(1.5);backdrop-filter:blur(24px) saturate(1.5);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 30px 80px -20px #000;animation:in .8s cubic-bezier(.2,.8,.2,1) both}
@keyframes in{from{opacity:0;transform:translateY(24px) scale(.96)}}
.stage{position:relative;height:120px;margin:0 auto 22px;width:100%;max-width:300px}
.node{position:absolute;top:30px;width:60px;height:60px;border-radius:20px;display:grid;place-items:center;background:linear-gradient(145deg,rgba(255,255,255,.14),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 10px 30px -8px rgba(0,0,0,.9);animation:pop .8s cubic-bezier(.34,1.56,.64,1) both}
.node svg{width:28px;height:28px}
.l{left:0;color:#5ab4ff;animation-delay:.15s}.r{right:0;color:#e8eefc;animation-delay:.3s}
@keyframes pop{from{opacity:0;transform:scale(.3) rotate(-18deg)}}
.ok .l{animation:pop .8s .15s cubic-bezier(.34,1.56,.64,1) both,squish .7s 2.3s cubic-bezier(.34,1.56,.64,1)}
.ok .r{animation:pop .8s .3s cubic-bezier(.34,1.56,.64,1) both,squish .7s 2.3s cubic-bezier(.34,1.56,.64,1)}
@keyframes squish{30%{transform:scale(1.18,.86)}60%{transform:scale(.92,1.1)}}
.bad .l{animation:pop .8s .15s both,shake .6s 1.9s}.bad .r{animation:pop .8s .3s both,shake .6s 1.9s reverse}
@keyframes shake{20%{transform:translateX(-7px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(2px)}}
.wire{position:absolute;left:62px;right:62px;top:59px;height:2px}
.wire i{position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(255,255,255,.35) 0 6px,transparent 6px 12px);transform-origin:left;animation:draw .7s .6s ease-out both,march .7s linear infinite}
.ok .wire i{animation:draw .7s .6s ease-out both,march .7s linear 1.3s 2,solid .5s 2.1s forwards}
.bad .wire i{animation:draw .7s .6s ease-out both,march .7s linear 1.3s 1,snap .3s 1.9s forwards}
@keyframes draw{from{transform:scaleX(0)}}@keyframes march{to{background-position:12px 0}}
@keyframes solid{to{background:var(--c);box-shadow:0 0 16px var(--c);height:3px;top:-.5px}}
@keyframes snap{to{opacity:.12}}
.wire b{position:absolute;top:-4px;width:10px;height:10px;border-radius:50%;background:#5ab4ff;box-shadow:0 0 14px #5ab4ff;opacity:0}
.wire b:nth-child(2){animation:go 1s 1.3s ease-in-out 2}
.wire b:nth-child(3){background:#fff;box-shadow:0 0 14px #fff;animation:back 1s 1.3s ease-in-out 2}
.bad .wire b:nth-child(2),.bad .wire b:nth-child(3){animation-iteration-count:1}
@keyframes go{0%{left:0;opacity:0}15%,85%{opacity:1}100%{left:calc(100% - 10px);opacity:0}}
@keyframes back{0%{left:calc(100% - 10px);opacity:0}15%,85%{opacity:1}100%{left:0;opacity:0}}
.badge{position:absolute;left:50%;top:44px;width:32px;height:32px;margin-left:-16px;border-radius:50%;display:grid;place-items:center;background:var(--c);color:#04110a;box-shadow:0 0 0 0 var(--c),0 8px 24px -4px var(--c);transform:scale(0);animation:badge .7s 2.2s cubic-bezier(.34,1.56,.64,1) forwards}
.bad .badge{animation-delay:2s;color:#1a0505}
.badge svg{width:18px;height:18px}
.badge::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--c);opacity:0;animation:ring 1s 2.3s ease-out}
.bad .badge::after{animation-delay:2.1s}
@keyframes badge{to{transform:scale(1)}}@keyframes ring{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(3.4)}}
.sp{position:absolute;left:50%;top:60px;width:6px;height:6px;margin:-3px;border-radius:50%;background:var(--c);opacity:0;animation:fly .9s 2.3s ease-out}
.sp:nth-of-type(1){--x:-70px;--y:-44px}.sp:nth-of-type(2){--x:72px;--y:-40px}.sp:nth-of-type(3){--x:-52px;--y:46px}.sp:nth-of-type(4){--x:58px;--y:44px}.sp:nth-of-type(5){--x:0;--y:-56px}.sp:nth-of-type(6){--x:0;--y:54px}
@keyframes fly{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--x),var(--y)) scale(.3)}}
.bad .sp{display:none}
h1{margin:0 0 8px;font-size:22px;letter-spacing:-.02em;animation:up .7s 2.4s cubic-bezier(.2,.8,.2,1) both}
p{margin:0;color:#a4aab5;animation:up .7s 2.55s cubic-bezier(.2,.8,.2,1) both}
.hint{margin-top:18px;font-size:12.5px;color:#6b717c;animation:up .7s 2.7s cubic-bezier(.2,.8,.2,1) both}
@keyframes up{from{opacity:0;transform:translateY(10px)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01s!important;animation-delay:0s!important;animation-iteration-count:1!important}}
`;

const ICON_TG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.4 3.6 2.9 10.8c-1 .4-1 1.100.2 1.400l4.700 1.500 1.800 5.600c.2.600.4.800.9.800s.7-.2 1-.5l2.300-2.200 4.700 3.500c.9.500 1.500.2 1.700-.8L22.700 5c.3-1.300-.5-1.900-1.300-1.400ZM9.400 13.200l9-5.700c.4-.3.800-.1.500.2l-7.300 6.600-.3 3.100-1.900-4.200Z"/></svg>';
const ICON_GIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5.500" r="2.200"/><circle cx="6" cy="18.500" r="2.200"/><circle cx="18" cy="8.500" r="2.200"/><path d="M6 7.700v8.600M18 10.700c0 4-6 3-11 6.200"/></svg>';
const ICON_OK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.500l4.500 4.500L19 7.500"/></svg>';
const ICON_BAD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

function page(message: string, status = 200): NextResponse {
  // Only static strings are passed here, never request input.
  const good = status < 400;
  const title = good ? "Terhubung!" : "Gagal terhubung";
  const hint = good ? "Kamu bisa kembali ke Telegram." : "Kembali ke Telegram dan kirim /login untuk mencoba lagi.";
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#000000"><title>GitHub Manager</title><style>${CONNECT_CSS}</style></head><body class="${good ? "ok" : "bad"}"><main class="card" role="status"><div class="stage" aria-hidden="true"><span class="node l">${ICON_TG}</span><span class="wire"><i></i><b></b><b></b></span><span class="node r">${ICON_GIT}</span><span class="badge">${good ? ICON_OK : ICON_BAD}</span><span class="sp"></span><span class="sp"></span><span class="sp"></span><span class="sp"></span><span class="sp"></span><span class="sp"></span></div><h1>${title}</h1><p>${message}</p><p class="hint">${hint}</p></main></body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code"),
    state = req.nextUrl.searchParams.get("state");
  if (!code || !state || code.length > 512 || state.length > 256)
    return page("Permintaan tidak valid.", 400);
  let env;
  try {
    env = loadEnv();
  } catch {
    return page("Konfigurasi layanan belum tersedia.", 503);
  }
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (!(await consumeRateLimit(`cb:${ip}`, 20, 60)))
    return page("Terlalu banyak percobaan. Coba lagi nanti.", 429);

  const consumed = await consumeLoginStateWithMessage(state);
  const telegramUserId = consumed?.telegramUserId ?? null;
  const loginMessageId = consumed?.messageId ?? null;
  if (telegramUserId === null) {
    return page("Tautan ini tidak valid, kedaluwarsa, atau sudah dipakai.", 400);
  }

  try {
    const token = await exchangeCode(env, code);
    const profile = await fetchGithubProfile(token.accessToken);
    const result = await linkGithubAccount(env, telegramUserId, profile, token);

    if (result === "owned_by_another_user") {
      await logActivity(
        telegramUserId,
        "github_connect",
        "failure",
        "account linked to another Telegram user",
      ).catch(() => undefined);
      await markLoginResult(
        env,
        telegramUserId,
        loginMessageId,
        false,
        "This GitHub account is already connected to another Telegram user.",
      );
      return page("Akun GitHub ini sudah terhubung ke pengguna Telegram lain.", 409);
    }

    await logActivity(telegramUserId, "github_connect", "success").catch(
      () => undefined,
    );
    await markLoginResult(
      env,
      telegramUserId,
      loginMessageId,
      true,
      `GitHub account @${profile.login} connected.`,
    );
    const accessible = await listAccessibleRepos(token.accessToken)
      .then((r) => r.length)
      .catch(() => null);
    await sendProfileCard(env, telegramUserId, profile, accessible).catch(() =>
      console.error("github connection notification unavailable"),
    );
    return page("Akun GitHub kamu sudah terhubung dengan bot.");
  } catch (err) {
    await logActivity(
      telegramUserId,
      "github_connect",
      "failure",
      err instanceof Error ? err.name : "unknown error",
    ).catch(() => undefined);
    await markLoginResult(
      env,
      telegramUserId,
      loginMessageId,
      false,
      "Could not complete GitHub authorization.",
    );
    return page("Otorisasi GitHub tidak bisa diselesaikan.", 502);
  }
}
