#!/usr/bin/env node
/**
 * bridge.js — Vault API local stdio bridge
 *
 * Connects Claude Desktop (stdio MCP) to the Obsidian vault-api plugin (HTTP/SSE).
 * All traffic is local — no external connections, no mcp-remote dependency.
 *
 * Usage: node bridge.js <port> <apiKey>
 * Claude Desktop spawns this automatically via claude_desktop_config.json.
 */
'use strict';

const http     = require('http');
const readline = require('readline');

const PORT    = parseInt(process.argv[2] ?? '2768', 10);
const API_KEY = process.env.VAULT_API_KEY ?? process.argv[3] ?? '';
const AUTH    = API_KEY ? { 'x-api-key': API_KEY } : {};

let sessionId  = null;
const msgQueue = [];   // buffer lines that arrive before sessionId is known

// ── SSE client — connect to /sse and listen for server messages ───────────
function connectSse() {
  const ssePath = '/sse' + (API_KEY ? `?key=${encodeURIComponent(API_KEY)}` : '');

  const req = http.get(
    {
      hostname : '127.0.0.1',
      port     : PORT,
      path     : ssePath,
      headers  : { ...AUTH, Accept: 'text/event-stream' },
    },
    (res) => {
      if (res.statusCode !== 200) {
        stderr(`SSE connect failed: HTTP ${res.statusCode}` +
          (res.statusCode === 401 ? ' — wrong API key. Regenerate in Obsidian and click Connect Claude again.' : ''));
        process.exit(1);
      }

      res.setEncoding('utf8');
      let buf = '', eventType = '';

      res.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const raw of lines) {
          const line = raw.trimEnd();

          // blank line = end of SSE event block
          if (!line) { eventType = ''; continue; }

          // "event: endpoint" or "event: message"
          if (line.startsWith('event:')) { eventType = line.slice(6).trim(); continue; }

          // ignore SSE comments (": ping")
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();

          if (eventType === 'endpoint') {
            // Server sends the POST endpoint: "/message?sessionId=XYZ"
            const m = data.match(/sessionId=([^&\s]+)/);
            if (m) {
              sessionId = m[1];
              stderr(`Connected — sessionId=${sessionId}`);
              // flush any messages that arrived before the session was ready
              while (msgQueue.length) postToServer(msgQueue.shift());
            }
          } else {
            // MCP JSON-RPC from Obsidian → forward to Claude Desktop via stdout
            process.stdout.write(data + '\n');
          }
        }
      });

      res.on('end',   () => { stderr('SSE stream ended — is Obsidian open?'); process.exit(0); });
      res.on('error', e  => { stderr(`SSE read error: ${e.message}`);          process.exit(1); });
    }
  );

  req.on('error', e => {
    stderr(`Cannot reach Obsidian plugin at port ${PORT}: ${e.message}`);
    stderr('Make sure Obsidian is open and the Vault API plugin is enabled and running.');
    process.exit(1);
  });
}

// ── POST a JSON-RPC line to /message?sessionId= ───────────────────────────
function postToServer(line) {
  const buf = Buffer.from(line, 'utf8');
  const req = http.request(
    {
      hostname : '127.0.0.1',
      port     : PORT,
      path     : `/message?sessionId=${sessionId}`,
      method   : 'POST',
      headers  : {
        ...AUTH,
        'Content-Type'  : 'application/json',
        'Content-Length': buf.length,
      },
    },
    res => {
      res.resume();   // MCP responses arrive via SSE stream, not here
      // Log non-200 responses for debugging
      if (res.statusCode && res.statusCode >= 400) {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          stderr(`POST /message returned ${res.statusCode}: ${body.slice(0, 200)}`);
        });
      }
    }
  );
  req.on('error', e => stderr(`POST error: ${e.message}`));
  req.end(buf);
}

// ── stdin → server ────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', line => {
  if (!line.trim()) return;
  if (sessionId) postToServer(line);
  else           msgQueue.push(line);   // buffer until session is ready
});

rl.on('close', () => process.exit(0));

// ── helpers ───────────────────────────────────────────────────────────────
function stderr(msg) { process.stderr.write(`[vault-bridge] ${msg}\n`); }

// ── start ─────────────────────────────────────────────────────────────────
stderr(`Starting — connecting to port ${PORT}…`);
connectSse();
