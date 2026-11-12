/**
 * Tests for lib/request-guard.ts (2026-11-11 review): the Host allowlist that stops DNS
 * rebinding, and the cross-site rule that stops a web page on a LAN/tailnet device from blindly
 * POSTing to the control routes. Each "must keep working" case is a real caller.
 */
import { describe, it, expect } from 'vitest';
import {
  allowedHostsFromEnv,
  checkRequest,
  normalizeHost,
  type GuardInput,
} from '@/lib/request-guard';

// The export ships an empty default list; these cases run against a configured one.
const ALLOWED = allowedHostsFromEnv({
  SOLINTEG_ALLOWED_HOSTS: 'localhost:3000,127.0.0.1:3000,[::1]:3000,192.168.1.50:3000,nuc.example.net',
});

function req(over: Partial<GuardInput>): GuardInput {
  return { method: 'GET', pathname: '/', host: 'localhost:3000', origin: null, secFetchSite: null, ...over };
}
const ok = (over: Partial<GuardInput>) => expect(checkRequest(req(over), ALLOWED)).toBeNull();
const refused = (over: Partial<GuardInput>) => expect(checkRequest(req(over), ALLOWED)).not.toBeNull();

describe('request-guard: callers that must keep working', () => {
  it("dispatch_loop.py's bodiless POST /api/replan from localhost", () =>
    ok({ method: 'POST', pathname: '/api/replan', host: 'localhost:3000' }));
  it('systemd curl GET /api/oracle?force=1 from localhost', () =>
    ok({ pathname: '/api/oracle', host: 'localhost:3000' }));
  it("healthcheck's GET /api/weather-fallback-check", () =>
    ok({ pathname: '/api/weather-fallback-check', host: 'localhost:3000' }));
  it('the dashboard page over the LAN IP, opened from a link elsewhere', () =>
    ok({ pathname: '/', host: '192.168.1.50:3000', secFetchSite: 'cross-site' }));
  it('the dashboard page over Tailscale (Host passed through, :443 or bare)', () => {
    ok({ pathname: '/', host: 'nuc.example.net' });
    ok({ pathname: '/', host: 'NUC.example.net:443' });
  });
  it("the dashboard's own POST over the LAN", () =>
    ok({
      method: 'POST', pathname: '/api/replan', host: '192.168.1.50:3000',
      origin: 'http://192.168.1.50:3000', secFetchSite: 'same-origin',
    }));
  it("the dashboard's own POST over Tailscale even if serve rewrites Host to localhost", () =>
    ok({
      method: 'POST', pathname: '/api/replan', host: '127.0.0.1:3000',
      origin: 'https://nuc.example.net', secFetchSite: 'same-origin',
    }));
  it("the dashboard's same-origin GET fetches of /api/*", () =>
    ok({ pathname: '/api/replan', host: '192.168.1.50:3000', secFetchSite: 'same-origin' }));
  it('a typed /api URL in the address bar (Sec-Fetch-Site: none)', () =>
    ok({ pathname: '/api/prices', host: '192.168.1.50:3000', secFetchSite: 'none' }));
});

describe('request-guard: what it refuses', () => {
  it('a blind cross-site POST to /api/replan', () =>
    refused({
      method: 'POST', pathname: '/api/replan', host: '192.168.1.50:3000',
      origin: 'https://evil.example', secFetchSite: 'cross-site',
    }));
  it('a cross-site POST from an old browser that sends Origin but no Sec-Fetch-Site', () =>
    refused({ method: 'POST', pathname: '/api/replan', host: '192.168.1.50:3000', origin: 'https://evil.example' }));
  it('a cross-site DELETE to an /api route', () =>
    refused({ method: 'DELETE', pathname: '/api/replan', host: '192.168.1.50:3000', secFetchSite: 'cross-site' }));
  it('an <img> GET of /api/oracle?force=1 from another site', () =>
    refused({ pathname: '/api/oracle', host: '192.168.1.50:3000', secFetchSite: 'cross-site' }));
  it('another service on another NUC port (same-site, not same-origin)', () =>
    refused({
      method: 'POST', pathname: '/api/replan', host: '192.168.1.50:3000',
      origin: 'http://192.168.1.50:3001', secFetchSite: 'same-site',
    }));
  it('Origin: null (sandboxed iframe or file:)', () =>
    refused({ method: 'POST', pathname: '/api/replan', host: 'localhost:3000', origin: 'null' }));
  it('DNS rebinding: an attacker hostname in Host, even for a plain page GET', () => {
    refused({ pathname: '/', host: 'rebind.evil.example:3000' });
    refused({ pathname: '/api/replan', host: 'rebind.evil.example:3000', secFetchSite: 'same-origin' });
  });
  it('the right IP on the wrong port, and a missing Host', () => {
    refused({ pathname: '/', host: '192.168.1.50:8080' });
    refused({ pathname: '/', host: null });
  });
});

describe('request-guard: configuration', () => {
  it('ships with no default hosts (same-origin mode)', () => {
    expect(allowedHostsFromEnv({}).size).toBe(0);
  });
  it('SOLINTEG_ALLOWED_HOSTS replaces the default list', () => {
    const custom = allowedHostsFromEnv({ SOLINTEG_ALLOWED_HOSTS: 'box.lan:3000, Other.Example ' });
    expect([...custom]).toEqual(['box.lan:3000', 'other.example']);
    expect(checkRequest(req({ host: 'localhost:3000' }), custom)).not.toBeNull();
    expect(checkRequest(req({ host: 'box.lan:3000' }), custom)).toBeNull();
  });
  it('an empty list (no hosts configured) skips the Host rule but still refuses cross-site writes', () => {
    const none = new Set<string>();
    const lanPost = { method: 'POST', pathname: '/api/replan', host: '192.168.99.2:3000' };
    expect(checkRequest(req({ pathname: '/', host: '192.168.99.2:3000' }), none)).toBeNull();
    expect(checkRequest(req({ ...lanPost, origin: 'http://192.168.99.2:3000', secFetchSite: 'same-origin' }), none)).toBeNull();
    expect(checkRequest(req({ ...lanPost }), none)).toBeNull(); // curl / dispatch_loop: no Origin
    expect(checkRequest(req({ ...lanPost, origin: 'https://evil.example' }), none)).not.toBeNull();
    expect(checkRequest(req({ ...lanPost, secFetchSite: 'cross-site' }), none)).not.toBeNull();
    expect(checkRequest(req({ pathname: '/', host: null }), none)).not.toBeNull();
  });
  it('normalizeHost drops default ports and case only', () => {
    expect(normalizeHost('Host.Example:443')).toBe('host.example');
    expect(normalizeHost('host.example:80')).toBe('host.example');
    expect(normalizeHost('host.example:3000')).toBe('host.example:3000');
    expect(normalizeHost('')).toBeNull();
  });
});
