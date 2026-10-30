#!/usr/bin/env node
/**
 * Local-development fetch relay.
 *
 * `wrangler dev` runs the worker inside `workerd`, which resolves DNS itself
 * and ignores HTTP proxy environment variables. In a sandboxed container with
 * no direct egress, that makes every upstream fetch fail with a DNS error,
 * even though the same request succeeds from Node.
 *
 * This relay closes that gap for local work only: it accepts
 * `GET /?url=<encoded>`, performs the fetch from Node (where the proxy and CA
 * bundle apply), and streams the response back. The worker uses it when
 * FETCH_BRIDGE is set in .dev.vars, and never in production.
 *
 *   node scripts/dev-fetch-bridge.mjs [port]
 *
 * It only ever relays GET requests to http(s) URLs, and refuses private and
 * loopback addresses so it cannot be used to reach the host's own services.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { env, argv } from 'node:process';

const PORT = Number(argv[2] ?? env.BRIDGE_PORT ?? 8788);

/** Mirrors the proxy and CA setup the verification harness uses. */
async function configureEgress() {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  let ca;
  try {
    ca = readFileSync(env.NODE_EXTRA_CA_CERTS ?? '/root/.ccr/ca-bundle.crt');
  } catch {
    ca = undefined;
  }
  if (!proxy && !ca) return null;
  try {
    const { ProxyAgent, Agent, setGlobalDispatcher } = await import('undici');
    const tls = ca ? { ca } : undefined;
    setGlobalDispatcher(
      proxy ? new ProxyAgent({ uri: proxy, requestTls: tls, proxyTls: tls }) : new Agent({ connect: tls }),
    );
    return proxy ?? 'system CA override';
  } catch {
    return null;
  }
}

/** Blocks loopback, link-local and private ranges. */
function isPublicHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return false;
  if (/^\[?::1\]?$/.test(h)) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

const egress = await configureEgress();

const server = createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'user-agent, accept, x-ucdp-access-token',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { ...cors, 'content-type': 'text/plain' }).end('bridge relays GET only');
    return;
  }

  let target;
  try {
    const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (parsed.pathname === '/health') {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, egress }));
      return;
    }
    const raw = parsed.searchParams.get('url');
    if (!raw) throw new Error('missing ?url=');
    target = new URL(raw);
    if (!/^https?:$/.test(target.protocol)) throw new Error('only http(s) URLs are relayed');
    if (!isPublicHost(target.hostname)) throw new Error('refusing a private or loopback address');
  } catch (err) {
    res.writeHead(400, { ...cors, 'content-type': 'text/plain' }).end(`bridge: ${err.message}`);
    return;
  }

  // Pass through only the headers an upstream legitimately needs.
  const forward = {};
  for (const name of ['user-agent', 'accept', 'x-ucdp-access-token']) {
    const value = req.headers[name];
    if (typeof value === 'string') forward[name] = value;
  }

  try {
    const upstream = await fetch(target, { headers: forward, redirect: 'follow' });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      ...cors,
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
    const mark = upstream.ok ? 'ok ' : 'ERR';
    console.log(`${mark} ${upstream.status} ${body.length.toString().padStart(8)}B  ${target.host}${target.pathname}`);
  } catch (err) {
    res.writeHead(502, { ...cors, 'content-type': 'text/plain' }).end(`bridge upstream error: ${err.message}`);
    console.log(`ERR   -        -  ${target.host}${target.pathname}  (${err.message})`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev fetch bridge on http://127.0.0.1:${PORT}`);
  console.log(egress ? `relaying via ${egress}` : 'relaying directly (no proxy configured)');
  console.log(`set FETCH_BRIDGE=http://127.0.0.1:${PORT} in .dev.vars`);
});
