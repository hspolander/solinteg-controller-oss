// Next 16 proxy (formerly middleware). The rules and their rationale live in
// lib/request-guard.ts, where they are unit-tested.
import type { NextRequest } from 'next/server';
import { allowedHostsFromEnv, checkRequest } from '@/lib/request-guard';

const ALLOWED = allowedHostsFromEnv();

export function proxy(request: NextRequest) {
  const reason = checkRequest(
    {
      method: request.method,
      pathname: request.nextUrl.pathname,
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      secFetchSite: request.headers.get('sec-fetch-site'),
    },
    ALLOWED,
  );
  if (reason) {
    console.warn(`request-guard: 403 ${request.method} ${request.nextUrl.pathname}: ${reason}`);
    return new Response(`Forbidden: ${reason}\n`, { status: 403, headers: { 'content-type': 'text/plain' } });
  }
}

export const config = {
  // Static assets carry nothing worth guarding; everything else, pages included, is checked
  // (the Host rule is what stops DNS rebinding from reading the dashboard).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
