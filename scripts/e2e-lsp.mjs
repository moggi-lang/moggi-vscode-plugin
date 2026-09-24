#!/usr/bin/env node
/**
 * Protocol-level E2E test for the Moggi language server.
 *
 * Speaks raw LSP (Content-Length framing) over stdio with the real server
 * process — the same transport vscode-languageclient uses — and asserts on
 * the initialize capabilities, publishDiagnostics flow, and the main feature
 * handlers (hover/definition/references/documentSymbol/folding/inlay hints/
 * semantic tokens/completion/moniker/call hierarchy).
 *
 * The language server is the compiler, which is a separate repository and is
 * installed as a distribution. This is the plugin's end-to-end contract test
 * against it, so it drives exactly what a user drives — the `bin/moggi`
 * launcher, with no PHP of its own — and downloads the release the plugin
 * targets when no local distribution is around.
 *
 * The test brings its own fixtures instead of reading the compiler's: a
 * distribution ships no test data.
 *
 * Usage: bun scripts/e2e-lsp.mjs [path/to/bin/moggi]
 *        MOGGI_LAUNCHER=<dist>/bin/moggi MOGGI_COMPILER_VERSION=... bun run e2e
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { COMPILER_VERSION, LAUNCHER_NAME, fetchDistribution } from './fetch-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');

const candidates = [
  process.argv[2],
  process.env.MOGGI_LAUNCHER,
  path.join(pluginRoot, 'compiler', 'bin', LAUNCHER_NAME),
  path.resolve(pluginRoot, '..', 'moggi', 'bin', LAUNCHER_NAME),
].filter(Boolean);

const local = candidates.map((c) => path.resolve(c)).find((c) => fs.existsSync(c));

// No local distribution: fetch the release this plugin targets, which is what CI
// and a fresh checkout do.
const launcher = local ?? (await fetchDistribution({
  version: process.env.MOGGI_COMPILER_VERSION || COMPILER_VERSION,
  url: process.env.MOGGI_DIST_URL || '',
  log: (message) => console.log('dist ' + message),
}));
console.log('launcher: ' + launcher);

// ---------------------------------------------------------------- framing
let child;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
const notifications = []; // all received notifications, in order
let buffer = Buffer.alloc(0);
let serverDead = null;

const children = []; // every spawned server, killed in `finally`

function startServer() {
  // The launcher resolves the compiler and its bundled runtime from its own
  // location, so the working directory is the workspace under test.
  child = spawn(launcher, ['lsp'], { cwd: workspace });
  children.push(child);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  child.stderr.on('data', (d) => process.stderr.write('[server-stderr] ' + d.toString()));
  child.on('exit', (code, sig) => {
    serverDead = { code, sig };
    for (const p of pending.values()) p.reject(new Error(`server exited (${code}/${sig})`));
    pending.clear();
  });
}

function drain() {
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const m = /Content-Length: (\d+)/i.exec(header);
    if (!m) throw new Error('bad LSP header: ' + header);
    const len = parseInt(m[1], 10);
    if (buffer.length < headerEnd + 4 + len) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + len);
    const msg = JSON.parse(body);
    if (msg.id !== undefined && (msg.method === undefined || msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      notifications.push(msg);
      if (msg.id !== undefined) {
        // Server->client requests (window/workDoneProgress/create): answer so the loop never blocks.
        send({ jsonrpc: '2.0', id: msg.id, result: null });
      }
    }
  }
}

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

/** Send a raw (possibly invalid) JSON body frame. */
function sendRaw(body) {
  const b = Buffer.from(body, 'utf8');
  child.stdin.write(`Content-Length: ${b.length}\r\n\r\n`);
  child.stdin.write(b);
}

async function waitFor(pred, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let idx = 0;
  while (Date.now() < deadline) {
    while (idx < notifications.length) {
      if (pred(notifications[idx])) return notifications[idx];
      idx++;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers
const uriFor = (p) => 'file://' + path.resolve(p);

/** 0-based line containing `needle` (or its `nth` occurrence). */
function lineOf(text, needle, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`fixture missing ${JSON.stringify(needle)} (#${nth})`);
  }
  return text.slice(0, at).split('\n').length - 1;
}

/** Position of the end of `needle` occurrence. */
function posAt(text, needle, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`fixture missing ${JSON.stringify(needle)} (#${nth})`);
  }
  const before = text.slice(0, at);
  const line = before.split('\n').length - 1;
  const col = at - (before.lastIndexOf('\n') + 1);
  return { line, character: col };
}

// ---------------------------------------------------------------- checks
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function rangeOn(r, line, needleLen) {
  return r && r.start.line === line && r.start.character + needleLen === r.end.character;
}

// ---------------------------------------------------------------- main
// A throwaway workspace holding this repository's own fixtures, so the server
// sees exactly the project under test and nothing else.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moggi-e2e-'));
const fixtureDir = path.join(pluginRoot, 'fixtures', 'lsp');
for (const name of fs.readdirSync(fixtureDir)) {
  fs.copyFileSync(path.join(fixtureDir, name), path.join(workspace, name));
}

const basicPath = path.join(workspace, 'Basic.mog');
const diagPath = path.join(workspace, 'Diagnostics.mog');
const compPath = path.join(workspace, 'Completion.mog');
const basicUri = uriFor(basicPath);
const diagUri = uriFor(diagPath);
const compUri = uriFor(compPath);
const basic = fs.readFileSync(basicPath, 'utf8');
const diags = fs.readFileSync(diagPath, 'utf8');
const comp = fs.readFileSync(compPath, 'utf8');

startServer();

try {
  // 3.18: any request before `initialize` must fail with ServerNotInitialized.
  let preInit = null;
  try {
    await request('textDocument/hover', { textDocument: { uri: basicUri }, position: { line: 0, character: 0 } });
  } catch (e) {
    preInit = e;
  }
  check('request before initialize errors ServerNotInitialized (-32002)', preInit !== null && /-32002|not initialized/i.test(preInit.message), String(preInit));

  // ---- initialize / initialized
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: uriFor(workspace),
    capabilities: {
      window: { workDoneProgress: true },
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        publishDiagnostics: { versionSupport: true },
      },
    },
  });
  const caps = init?.capabilities ?? {};
  console.log('initialize: server name=' + JSON.stringify(init?.serverInfo?.name ?? '(none)'));
  check('documentSymbolProvider is hierarchical object (Phase 1 fix)',
    typeof caps.documentSymbolProvider === 'object' && caps.documentSymbolProvider?.hierarchicalDocumentSymbolSupport === true,
    JSON.stringify(caps.documentSymbolProvider));
  check('hoverProvider advertised', caps.hoverProvider !== undefined);
  check('declarationProvider advertised', caps.declarationProvider !== undefined);
  check('monikerProvider advertised', caps.monikerProvider !== undefined);
  check('colorProvider advertised', caps.colorProvider === true || typeof caps.colorProvider === 'object');
  check('inlayHintProvider advertised', caps.inlayHintProvider !== undefined);
  check('diagnosticProvider (pull) advertised', caps.diagnosticProvider !== undefined);
  check('incremental text sync', caps.textDocumentSync?.change === 2);
  check('positionEncoding echoes utf-16', caps.positionEncoding === 'utf-16', String(caps.positionEncoding));
  check('willDelete fileOperation advertised', typeof caps.workspace?.fileOperations?.willDelete === 'object', JSON.stringify(caps.workspace?.fileOperations));
  notify('initialized', {});
  // Inlay hints are off by default (moggi.inlayHints=false); opt in for the
  // feature assertions below.
  notify('workspace/didChangeConfiguration', { settings: { moggi: { inlayHints: true } } });

  // 3.18: a second `initialize` on a live server is InvalidRequest.
  let doubleInit = null;
  try {
    await request('initialize', { capabilities: {} });
  } catch (e) {
    doubleInit = e;
  }
  check('second initialize errors InvalidRequest (-32600)', doubleInit !== null && /-32600|already initialized/i.test(doubleInit.message), String(doubleInit));

  // ---- didOpen Basic.mog → eventually clean diagnostics
  notify('textDocument/didOpen', {
    textDocument: { uri: basicUri, languageId: 'moggi', version: 1, text: basic },
  });
  const basicPub = await waitFor(
    (n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === basicUri && n.params.diagnostics.length === 0,
    'clean diagnostics for Basic.mog',
  );
  check('Basic.mog publishes 0 diagnostics', true);

  // ---- didOpen Diagnostics.mog → exactly one type error
  notify('textDocument/didOpen', {
    textDocument: { uri: diagUri, languageId: 'moggi', version: 1, text: diags },
  });
  const diagPub = await waitFor(
    (n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === diagUri && n.params.diagnostics.length > 0,
    'error diagnostics for Diagnostics.mog',
  );
  const d0 = diagPub.params.diagnostics[0];
  check('Diagnostics.mog reports exactly 1 diagnostic (fail-fast)', diagPub.params.diagnostics.length === 1,
    JSON.stringify(diagPub.params.diagnostics.map((d) => d.message)));
  check('diagnostic is an error', d0.severity === 1, 'severity=' + d0.severity);
  check('diagnostic range covers wrongReturn', /wrongReturn/i.test(d0.message) || d0.range?.start?.line >= 0, d0.message);

  // ---- hover with mogdoc
  const hoverDoc = await request('textDocument/hover', {
    textDocument: { uri: basicUri },
    position: posAt(basic, 'documentedFunction ::'),
  });
  const hoverText = hoverDoc?.contents?.value ?? '';
  check('hover on documentedFunction shows mogdoc', /Documented function/.test(hoverText), JSON.stringify(hoverText.slice(0, 80)));
  check('hover shows function type signature', /Int\s*->\s*Int/.test(hoverText), JSON.stringify(hoverText.slice(0, 80)));

  // ---- definition on a cross-reference target
  const useTargetPos = posAt(basic, 'targetValue', 1); // second occurrence (inside useTarget)
  const def = await request('textDocument/definition', {
    textDocument: { uri: basicUri },
    position: useTargetPos,
  });
  const defLoc = Array.isArray(def) ? def[0] : def;
  check('definition of targetValue lands on its declaration',
    defLoc && path.basename(defLoc.uri) === 'Basic.mog' && rangeOn(defLoc.range, lineOf(basic, 'targetValue = 123'), 11),
    JSON.stringify(defLoc));

  // ---- references include the declaration
  const refs = await request('textDocument/references', {
    textDocument: { uri: basicUri },
    position: useTargetPos,
    context: { includeDeclaration: true },
  });
  check('references to targetValue >= 4 (decl + uses)', Array.isArray(refs) && refs.length >= 4,
    'got ' + (refs?.length ?? 'null'));

  // ---- documentSymbol: hierarchical (crashes VS Code if mis-shaped)
  const symbols = await request('textDocument/documentSymbol', { textDocument: { uri: basicUri } });
  check('documentSymbol returns non-empty array', Array.isArray(symbols) && symbols.length > 0,
    'got ' + (symbols?.length ?? 'null'));
  // Hierarchical DocumentSymbol shape: every entry has name + ranges and no
  // `location` (which would make it a flat SymbolInformation).
  const malformed = symbols.filter((s) => !s.name || !s.range || !s.selectionRange || s.location !== undefined);
  check('documentSymbol entries are DocumentSymbols (not SymbolInformation)', malformed.length === 0,
    JSON.stringify(malformed[0] ?? null));
  const withChildren = symbols.filter((s) => Array.isArray(s.children));
  check('data decls nest their constructors', withChildren.length >= 2, `${withChildren.length} with children`);
  const named = symbols.find((s) => s.name === 'targetFunction');
  check('documentSymbol includes targetFunction with selectionRange', !!named && !!named.selectionRange);
  const nested = symbols.flatMap((s) => s.children ?? []);
  check('constructors nested under data decl (e.g. Color)', nested.some((s) => s.name === 'Red'));

  // ---- folding ranges cover declaration bodies
  const folds = await request('textDocument/foldingRange', { textDocument: { uri: basicUri } });
  const describeLine = lineOf(basic, 'describeColor color =');
  const describeFold = folds.find((f) => f.startLine === describeLine);
  check('foldingRange for describeColor spans its body', !!describeFold && describeFold.endLine >= describeLine + 3,
    JSON.stringify(describeFold));
  check('folding ranges plentiful (one per top-level decl group)', folds.length > 40, 'got ' + folds.length);

  // ---- inlay hints
  const hints = await request('textDocument/inlayHint', {
    textDocument: { uri: basicUri },
    range: { start: { line: 0, character: 0 }, end: { line: 10_000, character: 0 } },
  });
  check('inlay hints non-empty', Array.isArray(hints) && hints.length > 0, 'got ' + (hints?.length ?? 'null'));
  const hintWithLabel = (hints ?? []).find((h) => typeof h.label === 'string' && h.label.length > 0);
  check('inlay hint carries a type label', !!hintWithLabel, JSON.stringify((hints ?? [])[0]));

  // ---- semantic tokens (full)
  const toks = await request('textDocument/semanticTokens/full', { textDocument: { uri: basicUri } });
  check('semantic tokens non-empty, multiple of 5', Array.isArray(toks?.data) && toks.data.length > 0 && toks.data.length % 5 === 0,
    'len=' + (toks?.data?.length ?? 'null'));

  // ---- pull diagnostics
  const pull = await request('textDocument/diagnostic', { textDocument: { uri: basicUri } });
  check('pull diagnostics (textDocument/diagnostic) works', pull && Array.isArray(pull.items) && pull.items.length === 0,
    JSON.stringify(pull?.items?.length));
  check('pull diagnostics carries a resultId', typeof pull?.resultId === 'string' && pull.resultId.length > 0, JSON.stringify(pull?.resultId));
  const pullUnchanged = await request('textDocument/diagnostic', {
    textDocument: { uri: basicUri },
    previousResultId: pull?.resultId,
  });
  check('pull diagnostics unchanged on same resultId', pullUnchanged?.kind === 'unchanged' && pullUnchanged?.resultId === pull?.resultId,
    JSON.stringify(pullUnchanged));

  // ---- declaration: cross-module via imported symbol
  const fromJustPos = posAt(basic, 'fromJust justValue');
  const decl = await request('textDocument/declaration', {
    textDocument: { uri: basicUri },
    position: fromJustPos,
  });
  const declLoc = Array.isArray(decl) ? decl[0] : decl;
  check('declaration of fromJust points into Data.Maybe.mog',
    declLoc && /Data\/Maybe\.mog$/.test(declLoc.uri), JSON.stringify(declLoc?.uri));

  // ---- typeDefinition: constructor use → data Color
  const redUse = posAt(basic, 'red = Red');
  redUse.character += 6; // land on `Red`
  const tdef = await request('textDocument/typeDefinition', {
    textDocument: { uri: basicUri },
    position: redUse,
  });
  const tdefLoc = Array.isArray(tdef) ? tdef[0] : tdef;
  check('typeDefinition of Red points at data Color (its name token)',
    tdefLoc && tdefLoc.range.start.line === lineOf(basic, 'data Color'), JSON.stringify(tdefLoc));

  // ---- completion on the incomplete fixture
  notify('textDocument/didOpen', {
    textDocument: { uri: compUri, languageId: 'moggi', version: 1, text: comp },
  });
  const compEnd = posAt(comp, '  map');
  compEnd.character += 5;
  const completion = await request('textDocument/completion', {
    textDocument: { uri: compUri },
    position: compEnd,
  });
  const items = Array.isArray(completion) ? completion : completion?.items;
  check('completion returns items on incomplete code', Array.isArray(items) && items.length > 0, 'got ' + (items?.length ?? 'null'));

  // ---- workspace symbols
  const wsSyms = await request('workspace/symbol', { query: 'target' });
  check('workspace/symbol finds targetValue', Array.isArray(wsSyms) && wsSyms.some((s) => s.name === 'targetValue'),
    'got ' + (wsSyms?.length ?? 'null'));

  // ---- moniker (exported symbol identity)
  const moniker = await request('textDocument/moniker', {
    textDocument: { uri: basicUri },
    position: posAt(basic, 'targetValue = 123'),
  });
  check('moniker on exported decl has identifier', Array.isArray(moniker) && moniker.length > 0 && !!moniker[0].identifier,
    JSON.stringify(moniker?.[0]));

  // ---- call hierarchy
  const chItem = await request('textDocument/prepareCallHierarchy', {
    textDocument: { uri: basicUri },
    position: posAt(basic, 'targetFunction x ='),
  });
  check('prepareCallHierarchy returns an item', Array.isArray(chItem) && chItem.length > 0 && chItem[0].name === 'targetFunction',
    JSON.stringify(chItem?.[0]?.name));

  // ---- code lens
  const lenses = await request('textDocument/codeLens', { textDocument: { uri: basicUri } });
  check('code lens non-empty', Array.isArray(lenses) && lenses.length > 0, 'got ' + (lenses?.length ?? 'null'));

  // ---- signature help on a call site (cursor just after the callee name)
  const sigPos = posAt(basic, 'compose double bump 20');
  sigPos.character += 7; // end of `compose`
  const sig = await request('textDocument/signatureHelp', {
    textDocument: { uri: basicUri },
    position: sigPos,
  });
  check('signatureHelp returns signatures for compose',
    sig && Array.isArray(sig.signatures) && sig.signatures.length > 0 && /compose/.test(sig.signatures[0].label),
    JSON.stringify(sig?.signatures?.[0]?.label ?? null));
  check('signatureHelp activeParameter in range',
    sig && typeof sig.activeParameter === 'number' && sig.activeParameter >= 0, JSON.stringify(sig?.activeParameter));

  // ---- document highlight
  const highlight = await request('textDocument/documentHighlight', {
    textDocument: { uri: basicUri },
    position: useTargetPos,
  });
  check('documentHighlight returns same-document ranges with kind',
    Array.isArray(highlight) && highlight.length >= 3 && highlight.every((h) => h.range && h.kind === 1),
    'got ' + (highlight?.length ?? 'null'));

  // ---- formatting + range formatting
  const fmt = await request('textDocument/formatting', { textDocument: { uri: basicUri } });
  check('formatting returns TextEdit[] (empty ok when already formatted)', Array.isArray(fmt), 'got ' + typeof fmt);
  const docLine = lineOf(basic, 'describeColor color =');
  const rfmt = await request('textDocument/rangeFormatting', {
    textDocument: { uri: basicUri },
    range: { start: { line: docLine, character: 0 }, end: { line: docLine + 4, character: 0 } },
  });
  check('rangeFormatting returns TextEdit[]', Array.isArray(rfmt), 'got ' + typeof rfmt);

  // ---- rename + prepareRename round-trip
  const rename = await request('textDocument/rename', {
    textDocument: { uri: basicUri },
    position: useTargetPos,
    newName: 'targetValueRenamed',
  });
  const renEdits = (rename?.documentChanges ?? []).find((c) => c.textDocument?.uri === basicUri)?.edits ?? [];
  check('rename produces WorkspaceEdit with documentChanges for the doc',
    rename && Array.isArray(rename.documentChanges) && renEdits.length >= 3
      && renEdits.every((e) => e.newText === 'targetValueRenamed'),
    JSON.stringify(renEdits?.length));
  const renameInvalid = await request('textDocument/rename', {
    textDocument: { uri: basicUri },
    position: useTargetPos,
    newName: 'not a valid name!',
  });
  check('rename with invalid identifier returns null (not an error)', renameInvalid === null, JSON.stringify(renameInvalid));

  // ---- document links + color endpoints on Basic.mog (empty is fine)
  const links = await request('textDocument/documentLink', { textDocument: { uri: basicUri } });
  check('documentLink returns array', Array.isArray(links), 'got ' + typeof links);
  const colors = await request('textDocument/documentColor', { textDocument: { uri: basicUri } });
  check('documentColor returns array', Array.isArray(colors), 'got ' + typeof colors);
  const colorPres = await request('textDocument/colorPresentation', {
    textDocument: { uri: basicUri },
    color: { red: 1, green: 0, blue: 0, alpha: 1 },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  });
  check('colorPresentation returns array of TextEdits', Array.isArray(colorPres) && colorPres.every((p) => p.textEdit),
    'got ' + (colorPres?.length ?? 'null'));

  // ---- inline values (spec shape: InlineValueText {range, text})
  const inlineVals = await request('textDocument/inlineValue', {
    textDocument: { uri: basicUri },
    range: { start: { line: 0, character: 0 }, end: { line: 10000, character: 0 } },
    context: { frameId: 0, stoppedLocation: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  });
  check('inlineValue returns InlineValueText entries {range, text}',
    Array.isArray(inlineVals) && inlineVals.length > 0
      && inlineVals.every((v) => v.range && typeof v.text === 'string'),
    'got ' + (inlineVals?.length ?? 'null'));

  // ---- type hierarchy
  // posAt lands on `d` of `data`; the handler reads the word under the cursor,
  // so offset onto the type name itself (char 5).
  const thPos = posAt(basic, 'data Color');
  thPos.character = 5;
  const thItem = await request('textDocument/prepareTypeHierarchy', {
    textDocument: { uri: basicUri },
    position: thPos,
  });
  check('prepareTypeHierarchy resolves data Color', Array.isArray(thItem) && thItem.length > 0 && thItem[0].name === 'Color',
    JSON.stringify(thItem?.[0]?.name ?? null));
  if (Array.isArray(thItem) && thItem.length > 0) {
    const supers = await request('typeHierarchy/supertypes', { item: thItem[0] });
    const subs = await request('typeHierarchy/subtypes', { item: thItem[0] });
    check('typeHierarchy supertypes/subtypes return arrays', Array.isArray(supers) && Array.isArray(subs));
  }

  // ---- selection range
  const selRange = await request('textDocument/selectionRange', {
    textDocument: { uri: basicUri },
    positions: [posAt(basic, 'targetValue + targetValue')],
  });
  check('selectionRange returns nested parent chain',
    Array.isArray(selRange) && selRange.length === 1 && !!selRange[0].range, JSON.stringify(selRange?.[0]?.range ?? null));

  // ---- linked editing range (null acceptable when not applicable)
  const linked = await request('textDocument/linkedEditingRange', {
    textDocument: { uri: basicUri },
    position: useTargetPos,
  });
  check('linkedEditingRange returns {ranges} or null', linked === null || (linked && Array.isArray(linked.ranges)),
    JSON.stringify(linked?.ranges?.length ?? null));

  // ---- workspace diagnostics (unadvertised: workspaceDiagnostics: false, handler still live)
  const wsDiag = await request('workspace/diagnostic', {});
  check('workspace/diagnostic returns a report with items', wsDiag && Array.isArray(wsDiag.items), JSON.stringify(wsDiag?.items?.length));
  const wsDiagEntry = (wsDiag?.items ?? []).find((e) => e.uri === basicUri);
  check('workspace/diagnostic covers open document with version',
    wsDiagEntry && wsDiagEntry.kind === 'full' && Array.isArray(wsDiagEntry.items) && typeof wsDiagEntry.version === 'number',
    JSON.stringify(wsDiagEntry ?? wsDiag));
  const wsDiagUnchanged = await request('workspace/diagnostic', {
    previousResultIds: [{ uri: basicUri, value: wsDiagEntry?.resultId }],
  });
  const wsDiagUnchangedEntry = (wsDiagUnchanged?.items ?? []).find((e) => e.uri === basicUri);
  check('workspace/diagnostic reports unchanged documents as kind=unchanged',
    wsDiagUnchangedEntry?.kind === 'unchanged' && wsDiagUnchangedEntry?.resultId === wsDiagEntry?.resultId,
    JSON.stringify(wsDiagUnchanged?.items?.map((e) => `${e.kind}:${e.uri}`)));

  // ---- workspace/executeCommand is a negotiated no-op
  const exec = await request('workspace/executeCommand', { command: 'moggi.nonexistent', arguments: [] });
  check('workspace/executeCommand accepts unknown command (null result)', exec === null, JSON.stringify(exec));

  // ---- willRenameFiles (fileOperations capability) — rename a module fixture
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moggi-rename-'));
  const oldModPath = path.join(tmpDir, 'OldMod.mog');
  const newModPath = path.join(tmpDir, 'NewMod.mog');
  const impPath = path.join(tmpDir, 'Imp.mog');
  fs.writeFileSync(oldModPath, 'module OldMod where\nx = 1\n');
  fs.writeFileSync(impPath, 'module Imp where\nimport OldMod\ny = OldMod.x\n');
  notify('textDocument/didOpen', { textDocument: { uri: uriFor(impPath), languageId: 'moggi', version: 1, text: fs.readFileSync(impPath, 'utf8') } });
  const willRen = await request('workspace/willRenameFiles', {
    files: [{ oldUri: uriFor(oldModPath), newUri: uriFor(newModPath) }],
  });
  const impEditEntry = (willRen?.documentChanges ?? []).find((c) => c.textDocument?.uri === uriFor(impPath));
  const impEdits = impEditEntry?.edits ?? [];
  check('willRenameFiles rewrites imports in open documents (documentChanges)',
    willRen && Array.isArray(willRen.documentChanges) && impEdits.some((e) => /NewMod/.test(e.newText)),
    JSON.stringify(impEdits ?? willRen));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ---- didSave flow
  notify('textDocument/didSave', { textDocument: { uri: basicUri } });
  await sleep(150);
  const afterSave = await request('textDocument/hover', {
    textDocument: { uri: basicUri },
    position: posAt(basic, 'documentedValue ::'),
  });
  check('server responsive after didSave', !!afterSave && !!afterSave.contents);

  // ---- didChange (incremental) keeps the doc healthy
  // Append at EOF so earlier line numbers are unaffected.
  const lastLine = basic.split('\n').length - 1;
  notify('textDocument/didChange', {
    textDocument: { uri: basicUri, version: 2 },
    contentChanges: [{
      range: {
        start: { line: lastLine, character: 0 },
        end: { line: lastLine, character: 0 },
      },
      text: '-- appended via LSP\n',
    }],
  });
  await sleep(300);
  const afterEdit = await request('textDocument/hover', {
    textDocument: { uri: basicUri },
    position: posAt(basic, 'documentedValue ::'),
  });
  check('hover still works after incremental didChange', !!afterEdit && !!afterEdit.contents);

  // ---- didClose clears diagnostics
  notify('textDocument/didClose', { textDocument: { uri: diagUri } });
  const cleared = await waitFor(
    (n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === diagUri && n.params.diagnostics.length === 0,
    'diagnostics cleared after didClose',
  );
  check('didClose publishes empty diagnostics', true);

  // ---- 3.18 protocol edge cases
  // Malformed JSON body must not kill the server; it must keep serving.
  sendRaw('{oops-not-json');
  await sleep(200);
  const afterBad = await request('textDocument/hover', {
    textDocument: { uri: basicUri },
    position: posAt(basic, 'documentedValue ::'),
  });
  check('server survives malformed JSON frame', !!afterBad && !!afterBad.contents);
  const badFrameNoted = notifications.some(
    (n) => n.method === 'window/showMessage' && /malformed/i.test(n.params?.message ?? ''),
  );
  check('malformed frame is reported via window/showMessage', badFrameNoted);

  // Unknown $/ request must error MethodNotFound.
  let mnf = null;
  try {
    await request('$/unknownCustomRequest', {});
  } catch (e) {
    mnf = e;
  }
  check('unknown $/ request errors MethodNotFound (-32601)', mnf !== null && /-32601|Method not found/i.test(mnf.message), String(mnf));

  // $/cancelRequest for an in-flight/completed request must be a no-op (no error, no hang).
  notify('$/cancelRequest', { id: 999999 });
  const afterCancel = await request('textDocument/documentSymbol', { textDocument: { uri: basicUri } });
  check('server responsive after $/cancelRequest', Array.isArray(afterCancel) && afterCancel.length > 0);

  // prepareRename must return { range, placeholder } (3.18 PrepareRenameResult).
  const prep = await request('textDocument/prepareRename', {
    textDocument: { uri: basicUri },
    position: posAt(basic, 'targetValue = 123'),
  });
  check('prepareRename returns {range, placeholder}',
    !!prep && typeof prep === 'object' && !Array.isArray(prep) && !!prep.range && typeof prep.placeholder === 'string'
      && prep.placeholder === 'targetValue', JSON.stringify(prep));

  // ---- willDeleteFiles: dangling import cleanup (server-initiated config pull is answered automatically)
  const delDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moggi-del-'));
  const gonePath = path.join(delDir, 'Goner.mog');
  const user2Path = path.join(delDir, 'User2.mog');
  fs.writeFileSync(gonePath, 'module Goner where\ng = 1\n');
  fs.writeFileSync(user2Path, 'module User2 where\nimport Goner\nimport Data.Maybe\nu = 1\n');
  const user2Uri = uriFor(user2Path);
  notify('textDocument/didOpen', { textDocument: { uri: user2Uri, languageId: 'moggi', version: 1, text: fs.readFileSync(user2Path, 'utf8') } });
  const willDel = await request('workspace/willDeleteFiles', {
    files: [{ uri: uriFor(gonePath) }],
  });
  const delEdits = (willDel?.documentChanges ?? []).find((c) => c.textDocument?.uri === user2Uri)?.edits ?? [];
  check('willDeleteFiles removes dangling import (documentChanges)',
    willDel && Array.isArray(willDel.documentChanges) && delEdits.some((e) => !/import Goner/.test(e.newText) && /import Data.Maybe/.test(e.newText)),
    JSON.stringify(delEdits ?? willDel));
  fs.rmSync(delDir, { recursive: true, force: true });

  // ---- dynamic registration round-trip (server stores/drops registrations)
  await request('client/registerCapability', {
    registrations: [{ id: 'e2e-reg-1', method: 'workspace/didChangeWatchedFiles', registerOptions: {} }],
  });
  check('client/registerCapability acknowledged', true);
  await request('client/unregisterCapability', {
    // 3.18 key is `unregistrations` — a misspelled key must not be honored.
    unregistrations: [{ id: 'e2e-reg-1', method: 'workspace/didChangeWatchedFiles' }],
  });
  check('client/unregisterCapability acknowledged (3.18 `unregistrations` key)', true);

  // ---- workspace/symbol/resolve echoes the item (no resultId → no server state)
  const wsSymbols = await request('workspace/symbol', { query: 'targetValue' });
  const wsItem = Array.isArray(wsSymbols) ? wsSymbols[0] : null;
  check('workspace/symbol finds targetValue', !!wsItem && wsItem.name === 'targetValue', JSON.stringify(wsSymbols));
  if (wsItem) {
    // Spec method name (3.17+): workspaceSymbol/resolve — no second slash.
    const echoed = await request('workspaceSymbol/resolve', wsItem);
    check('workspaceSymbol/resolve echoes the item', JSON.stringify(echoed) === JSON.stringify(wsItem), JSON.stringify(echoed));
  }

  // ---- exit without shutdown must exit 1 (3.18) — needs a fresh server
  const mainChild = child;
  startServer();
  await request('initialize', { capabilities: {} });
  notify('exit', {});
  const exitCode1 = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 5000);
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  check('server exits 1 on exit without shutdown', exitCode1 === 1, 'exit=' + exitCode1);
  child = mainChild;

  // ---- $/logTrace: set trace to messages, expect a logTrace notification
  const logTraces = () => notifications.filter((n) => n.method === '$/logTrace');
  notify('$/setTrace', { value: 'messages' });
  await request('textDocument/documentSymbol', { textDocument: { uri: basicUri } });
  await sleep(100);
  check('$/logTrace emitted after $/setTrace messages', logTraces().some((n) => /documentSymbol/.test(n.params?.message ?? '')), JSON.stringify(logTraces().slice(-2)));
  notify('$/setTrace', { value: 'off' });
  await request('textDocument/documentSymbol', { textDocument: { uri: basicUri } });
  await sleep(100);
  const before = logTraces().length;
  await request('textDocument/documentSymbol', { textDocument: { uri: basicUri } });
  await sleep(100);
  check('$/logTrace stops after $/setTrace off', logTraces().length === before, `${logTraces().length} vs ${before}`);

  // ---- shutdown / exit
  await request('shutdown', null);
  check('shutdown returns null result', true);

  // 3.18: after shutdown, requests error with InvalidRequest (-32600).
  let postShutdown = null;
  try {
    await request('textDocument/hover', { textDocument: { uri: basicUri }, position: { line: 0, character: 0 } });
  } catch (e) {
    postShutdown = e;
  }
  check('request after shutdown errors InvalidRequest (-32600)', postShutdown !== null && /-32600|Invalid Request/i.test(postShutdown.message), String(postShutdown));

  // 3.18: repeated shutdown is invalid.
  let secondShutdown = null;
  try {
    await request('shutdown', null);
  } catch (e) {
    secondShutdown = e;
  }
  check('second shutdown errors InvalidRequest (-32600)', secondShutdown !== null && /-32600|Invalid Request/i.test(secondShutdown.message), String(secondShutdown));

  notify('exit', {});
  const exitCode = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 5000);
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  check('server exits 0 after shutdown+exit', exitCode === 0, 'exit=' + exitCode);
} catch (e) {
  failed++;
  console.log('FATAL  ' + (e?.stack || e));
} finally {
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  fs.rmSync(workspace, { recursive: true, force: true });
}

console.log(`\nE2E: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
