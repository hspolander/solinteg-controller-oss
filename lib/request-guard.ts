/**
 * Cross-site and DNS-rebinding guard for the web app (2026-11-11 review), applied to every
 * request by proxy.ts.
 *
 * The control routes (POST /api/replan, GET /api/oracle?force=1) have no auth: LAN/tailnet
 * membership stands in for it. That does not stop a web page open on a LAN or tailnet device
 * from sending requests here. Route handlers
 * parse a text/plain body with request.json(), so a blind cross-site POST needs no preflight.
 * DNS rebinding (attacker hostname re-pointed at the NUC) would also let such a page READ the
 * dashboard. Two rules close both:
 *
 * 1. Host must be one of the names the app is really reached by. A rebinding attack carries
 *    the attacker's hostname in Host, so it fails here. Applies to every request.
 * 2. Requests that can change state (any method other than GET/HEAD/OPTIONS) and every /api/
 *    request must not come from another site: Sec-Fetch-Site must be same-origin or none (a
 *    typed URL), or absent (curl, the Python services, old browsers), and an Origin header, when
 *    present, must name an allowed host. Checking the Origin's host against the allowlist,
 *    rather than requiring Origin == Host, keeps working whether `tailscale serve` passes the
 *    browser's Host through or rewrites it to localhost. `same-site` is refused on purpose:
 *    another service on another port of the NUC is same-site.
 *
 * Callers that must keep working: dispatch_loop.py's bodiless POST to
 * http://localhost:3000/api/replan, the systemd curl units (localhost:3000), healthcheck's GET,
 * the dashboard over the LAN IP and over Tailscale.
 *
 * In this export the built-in list is EMPTY, so out of the box the guard runs in same-origin
 * mode (see checkRequest): cross-site writes are refused, but any Host is accepted. Set
 * SOLINTEG_ALLOWED_HOSTS to the names you reach the dashboard by to also close DNS rebinding.
 */

/** The names the app is reached by. `SOLINTEG_ALLOWED_HOSTS` (comma-separated host[:port])
 *  replaces this list when set. */
export const DEFAULT_ALLOWED_HOSTS: string[] = [];

export function allowedHostsFromEnv(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = env.SOLINTEG_ALLOWED_HOSTS?.trim();
  const list = raw ? raw.split(',') : DEFAULT_ALLOWED_HOSTS;
  return new Set(list.map(normalizeHost).filter((h): h is string => h !== null));
}

/** Lower-case, and drop a default port so `name:443` and `name` compare equal. */
export function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;
  return h.replace(/:(80|443)$/, '');
}

export interface GuardInput {
  method: string;
  pathname: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
}

/** null = allow; otherwise a short reason for the 403.
 *
 *  An EMPTY allowlist (the export's default, until an adopter sets SOLINTEG_ALLOWED_HOSTS) means
 *  "no host list configured": the Host rule is skipped (no DNS-rebinding protection) and an
 *  Origin, when present, must equal Host instead. That still refuses cross-site writes with zero
 *  configuration, without 403-ing a LAN dashboard nobody has listed yet. */
export function checkRequest(req: GuardInput, allowed: Set<string>): string | null {
  const host = normalizeHost(req.host);
  const listed = allowed.size > 0;
  if (!host || (listed && !allowed.has(host))) return `host not allowed: ${req.host ?? '(none)'}`;

  const method = req.method.toUpperCase();
  const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const isApi = req.pathname === '/api' || req.pathname.startsWith('/api/');
  if (safeMethod && !isApi) return null;

  const site = req.secFetchSite?.toLowerCase() ?? null;
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return `cross-site request refused (Sec-Fetch-Site: ${site})`;
  }
  if (req.origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = normalizeHost(new URL(req.origin).host);
    } catch {
      originHost = null; // "null" (sandboxed iframe, file:) or garbage
    }
    const originOk = originHost !== null && (listed ? allowed.has(originHost) : originHost === host);
    if (!originOk) return `origin not allowed: ${req.origin}`;
  }
  return null;
}
