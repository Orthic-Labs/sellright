#!/usr/bin/env node
// Code-shape enforcement (plan A14), TypeScript compiler API only. Rejects, in EVERY overlay-origin file (L3 files and
// L2 ejects alike), anything that would reintroduce platform logic outside the platform API:
//   definition-call     routeLoader$, routeAction$, globalAction$, server$ (and their Qrl forms), under any alias
//   global-network      global fetch, XMLHttpRequest, WebSocket, navigator.sendBeacon (also via window/globalThis/self)
//   orchestration-call  refreshCartStock, placeOrder, stock refresh helpers, gateway names as call targets
//   import-forbidden    @sellright/storefront-client, ~/sellright/client
//   inject-html         dangerouslySetInnerHTML, innerHTML, outerHTML, srcdoc (JSX attribute, member, property key)        (r7)
//   inject-tag          <script>, <iframe>, <object>, <embed>, <base>, <frame>, <meta>, <link> as JSX tags                 (r7)
//   inject-call         insertAdjacentHTML, createContextualFragment, write(ln), eval, Function, importScripts, parseFromString (r7)
//   inject-element      createElement(NS) outside the literal allow list, aliased or destructured; non-literal or on*/srcdoc
//                       setAttribute; .src/.href writes on a non-allowed element; javascript: literals; string timers      (r8)
//   qrl-introspection   getCaptured, getSymbol, getHash, resolve, $captureRef$, $capture$, $chunk$, $symbol$ members       (r9)
//   worker-register     .register(...), Worker, SharedWorker                                                              (r10)
//   brand-stock-flag    a declared name such as stockLoaded or cacheStock (brand-controlled stock state)                  (r12)
// Re-exports of platform loaders and actions (export { useX } from '~/platform/...') are allowed (plan A12).
//
//   node scripts/check-code-shape.mjs [--root DIR] [--layers FILE] [--overlay-list FILE] [FILE...]
//       Overlay mode: FILE... or the overlay list (default <root>/.compose-overlay-files.txt). Exit 1 on any finding.
//   node scripts/check-code-shape.mjs --base [--root DIR] [--layers FILE] [--overlay-list FILE]
//       Base L2 files (classified L2, not overlay) with the same rules. Base-reviewed code that still calls
//       orchestration directly is exempt until plan A13 lands: with layers.json codeShape.baseL2Enforcement = "report"
//       the findings are listed and the exit code is 0; "block" makes them fail.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  PACKAGE_ROOT,
  classify,
  collectModuleSpecifiers,
  formatFinding,
  isCodeFile,
  listProjectFiles,
  loadLayers,
  normalizeRel,
  parseArgs,
  parseSource,
  position,
  readOverlayList,
  resolveOverlayFiles,
  walk,
} from './check-imports.mjs';

function compile(layers) {
  const cs = layers.codeShape;
  return {
    definitions: new Set(cs.definitionCalls),
    networkGlobals: new Set(cs.networkGlobals),
    networkMethods: new Set(cs.networkMethods),
    globalObjects: new Set(cs.globalObjects),
    orchestrationNames: new Set(cs.orchestrationCalls),
    orchestrationPatterns: (cs.orchestrationPatterns ?? []).map((p) => new RegExp(p)),
    gateway: new RegExp(cs.gatewayNamePattern, 'i'),
    injectionProps: new Set(cs.injectionProps ?? []),
    injectionCalls: new Set(cs.injectionCalls ?? []),
    createElementAllow: new Set(cs.createElementAllow ?? []),
    qrlIntrospection: new Set(cs.qrlIntrospection ?? []),
    workerCalls: new Set(cs.workerCalls ?? []),
    forbiddenJsxTags: new Set(cs.forbiddenJsxTags ?? []),
    stockFlags: (cs.brandStockFlags ?? []).map((p) => new RegExp(p, 'i')),
  };
}

/** Strips wrappers that do not change the value: `(x)`, `x!`, `x as T`, `<T>x`, `x satisfies T`. */
function unwrap(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** True when a receiver is one of the global objects (window, globalThis, self, global), however it is wrapped. */
function isGlobalReceiver(rules, expr) {
  const e = unwrap(expr);
  return ts.isIdentifier(e) && rules.globalObjects.has(e.text);
}

/** Names along a callee: `a.b['c']()` gives ['a', 'b', 'c']. */
function calleeChain(expr) {
  const names = [];
  let e = expr;
  for (;;) {
    e = unwrap(e);
    if (ts.isPropertyAccessExpression(e)) { names.unshift(e.name.text); e = e.expression; }
    else if (ts.isElementAccessExpression(e)) {
      if (ts.isStringLiteralLike(e.argumentExpression)) names.unshift(e.argumentExpression.text);
      e = e.expression;
    } else if (ts.isIdentifier(e)) { names.unshift(e.text); return names; }
    else return names;
  }
}

/** True when an identifier is a name position, not a reference (a.NAME, { NAME: 1 }, NAME() {}, <X NAME="">). */
function isNamePosition(id) {
  const p = id.parent;
  if (!p) return false;
  return (ts.isPropertyAccessExpression(p) && p.name === id)
    || (ts.isPropertyAssignment(p) && p.name === id)
    || (ts.isPropertyDeclaration(p) && p.name === id)
    || (ts.isPropertySignature(p) && p.name === id)
    || (ts.isMethodDeclaration(p) && p.name === id)
    || (ts.isMethodSignature(p) && p.name === id)
    || (ts.isJsxAttribute(p) && p.name === id)
    || (ts.isQualifiedName(p) && p.right === id)
    || ts.isTypeReferenceNode(p);
}

const CREATE_ELEMENT = new Set(['createElement', 'createElementNS']);
const SET_ATTRIBUTE = new Set(['setAttribute', 'setAttributeNS', 'setAttributeNode', 'setAttributeNodeNS']);
const URL_PROPS = new Set(['src', 'href', 'srcset', 'action', 'formAction']);
const TIMERS = new Set(['setTimeout', 'setInterval']);
const DOCUMENT_LIKE = new Set(['document', 'window', 'globalThis', 'self', 'global', 'Reflect']);

/** The static name of a member access (`a.b` or `a['b']`), or null. */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

const isStringy = (e) => {
  const x = unwrap(e);
  return ts.isStringLiteralLike(x) || ts.isTemplateExpression(x) || (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken && (isStringy(x.left) || isStringy(x.right)));
};

/** Local identifiers declared as `const x = <anything>.createElement('<allowed literal>')`. */
function allowedElementBindings(rules, sf) {
  const names = new Set();
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const init = unwrap(node.initializer);
    if (!ts.isCallExpression(init) || memberName(unwrap(init.expression)) !== 'createElement') return;
    const arg = init.arguments[0];
    if (arg && ts.isStringLiteralLike(arg) && rules.createElementAllow.has(arg.text.toLowerCase())) names.add(node.name.text);
  });
  return names;
}


/**
 * Bounded provenance for member rules (.src/.href writes, .resolve, .register): which local identifiers are plain file-local data?
 * Returns Map<name, Set<member names it defines>> for names declared once in this file with an object literal (also as the argument of
 * useStore/useSignal) or `new C(...)` of a class declared in this file, and never reassigned. A receiver that is anything else
 * (a DOM node, a QRL, `navigator.serviceWorker`, a member chain, a parameter) is not in the map, so the dangerous-receiver
 * negatives keep failing. Also: `this` inside a class declared in this file (its own method names).
 */
function localDataBindings(sf) {
  const declCount = new Map();
  const reassigned = new Set();
  const memberWrites = new Map(); // root name -> member names written with a non-literal value (`s.image = el`, `sig.value = el`)
  const classes = new Map();
  const bump = (n) => declCount.set(n, (declCount.get(n) ?? 0) + 1);
  walk(sf, (node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      classes.set(node.name.text, new Set(node.members.filter((m) => m.name && (ts.isIdentifier(m.name) || ts.isStringLiteralLike(m.name))).map((m) => m.name.text)));
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) bump(node.name.text);
    else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) bump(node.name.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const l = unwrap(node.left);
      if (ts.isIdentifier(l)) reassigned.add(l.text);
      if ((ts.isPropertyAccessExpression(l) || ts.isElementAccessExpression(l)) && !ts.isObjectLiteralExpression(unwrap(node.right))) {
        let r = l;
        while (ts.isPropertyAccessExpression(r) || ts.isElementAccessExpression(r)) r = unwrap(r.expression);
        if (ts.isIdentifier(r)) {
          const names = memberWrites.get(r.text) ?? new Set();
          names.add(ts.isPropertyAccessExpression(l) ? l.name.text : ts.isStringLiteralLike(l.argumentExpression) ? l.argumentExpression.text : '*');
          memberWrites.set(r.text, names);
        }
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(unwrap(node.operand))) reassigned.add(unwrap(node.operand).text);
  });
  const objectMembers = (lit) => new Set(lit.properties.filter((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))).map((p) => p.name.text));
  const out = new Map();
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const name = node.name.text;
    if (declCount.get(name) !== 1 || reassigned.has(name)) return;
    let init = unwrap(node.initializer);
    let viaSignal = false;
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && /^use(Store|Signal)$/.test(init.expression.text) && init.arguments[0]) {
      viaSignal = init.expression.text === 'useSignal';
      init = unwrap(init.arguments[0]);
    }
    if (ts.isObjectLiteralExpression(init)) {
      const members = objectMembers(init);
      Object.assign(members, { literal: init, viaSignal, writes: memberWrites.get(name) ?? new Set() }); // for member chains (isLocalData)
      out.set(name, members);
    }
    else if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && classes.has(init.expression.text)) out.set(name, classes.get(init.expression.text));
  });
  return out;
}

/** True when `recv.member` is a file-local property or method: a local data binding that defines `member`, or `this` inside a class that declares it. */
function isLocalMember(local, recv, member) {
  const r = unwrap(recv);
  if (ts.isIdentifier(r)) return local.get(r.text)?.has(member) === true;
  if (r.kind === ts.SyntaxKind.ThisKeyword) {
    for (let p = r.parent; p; p = p.parent) {
      if (ts.isClassLike(p)) return p.members.some((m) => m.name && (ts.isIdentifier(m.name) || ts.isStringLiteralLike(m.name)) && m.name.text === member);
    }
  }
  return false;
}

/**
 * True when `recv` (the object of a .src/.href write) is a plain local data binding, whatever its fields are, or a bounded member chain
 * inside one: `sig.value` / `sig.value.a.b` for a `useSignal({...})` (the first hop is `.value`), `store.a.b` for a `useStore({...})` or
 * object literal, every hop an object literal member of the initializer and never written with a non-literal value. A hop onto anything
 * else (a DOM node, a call, an unknown member, a parameter root) is not local data.
 */
function isLocalData(local, recv) {
  let r = unwrap(recv);
  const hops = [];
  while ((ts.isPropertyAccessExpression(r) || ts.isElementAccessExpression(r)) && hops.length < 6) {
    hops.unshift(ts.isPropertyAccessExpression(r) ? r.name.text : ts.isStringLiteralLike(r.argumentExpression) ? r.argumentExpression.text : null);
    r = unwrap(r.expression);
  }
  if (!ts.isIdentifier(r) || !local.has(r.text)) return false;
  if (hops.length === 0) return true;
  const entry = local.get(r.text);
  let lit = entry.literal;
  if (!lit || hops.includes(null) || hops.some((h) => entry.writes.has(h) || entry.writes.has('*'))) return false;
  let i = 0;
  if (entry.viaSignal) {
    if (hops[0] !== 'value') return false;
    i = 1;
  }
  for (; i < hops.length; i++) {
    const prop = lit.properties.find((p) => ts.isPropertyAssignment(p) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === hops[i]);
    const v = prop && unwrap(prop.initializer);
    if (!v || !ts.isObjectLiteralExpression(v)) return false;
    lit = v;
  }
  return true;
}

/** r7-r10 and r12: HTML and script insertion, element creation, QRL introspection, workers, stock flags. */
function injectionFindings(rules, sf, add) {
  const okElements = allowedElementBindings(rules, sf);
  const local = localDataBindings(sf);
  const isCalleeOf = (node) => node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
  walk(sf, (node) => {
    // r7: JSX
    if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.name.text;
      if (rules.injectionProps.has(name)) add(node, 'inject-html', `${name}: HTML insertion is not allowed in brand code; render rich content through RichContent`);
      if (rules.stockFlags.some((re) => re.test(name))) add(node, 'brand-stock-flag', `${name}: brand code may not carry stock loaded/checked/cached state`);
      if (/^on[a-z]/.test(name) && node.initializer && ts.isStringLiteral(node.initializer)) add(node, 'inject-element', `${name}: string event-handler attributes are not allowed`);
      if (node.initializer && ts.isStringLiteral(node.initializer) && /^\s*javascript:/i.test(node.initializer.text)) add(node.initializer, 'inject-element', 'javascript: URLs are not allowed');
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text) && rules.forbiddenJsxTags.has(tag.text)) add(tag, 'inject-tag', `<${tag.text}>: this tag is not allowed in brand code`);
    }
    if (ts.isJsxSpreadAttribute(node)) {
      const e = unwrap(node.expression);
      if (ts.isObjectLiteralExpression(e)) for (const p of e.properties) if (p.name && ts.isIdentifier(p.name) && rules.injectionProps.has(p.name.text)) add(p, 'inject-html', `${p.name.text}: HTML insertion is not allowed in brand code`);
    }
    // property keys and members
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isMethodDeclaration(node)) && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
      const name = node.name.text;
      if (rules.injectionProps.has(name)) add(node.name, 'inject-html', `${name}: HTML insertion is not allowed in brand code`);
      if (rules.stockFlags.some((re) => re.test(name))) add(node.name, 'brand-stock-flag', `${name}: brand code may not carry stock loaded/checked/cached state`);
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      const names = [];
      const collect = (n) => { if (ts.isIdentifier(n)) names.push(n); else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n.elements.forEach((el) => { if (ts.isBindingElement(el)) collect(el.name); }); };
      collect(node.name);
      for (const id of names) if (rules.stockFlags.some((re) => re.test(id.text))) add(id, 'brand-stock-flag', `${id.text}: brand code may not carry stock loaded/checked/cached state`);
      if (ts.isBindingElement(node)) {
        const key = node.propertyName ? (ts.isIdentifier(node.propertyName) || ts.isStringLiteralLike(node.propertyName) ? node.propertyName.text : null) : (ts.isIdentifier(node.name) ? node.name.text : null);
        if (key) {
          if (rules.injectionProps.has(key) || (rules.injectionCalls.has(key))) add(node, 'inject-call', `${key}: destructuring an HTML or code insertion API is not allowed`);
          if (rules.qrlIntrospection.has(key) && key !== 'resolve') add(node, 'qrl-introspection', `${key}: reading a QRL's internals is not allowed`);
          if (CREATE_ELEMENT.has(key)) add(node, 'inject-element', `${key}: destructuring createElement is not allowed`);
          if (rules.workerCalls.has(key) && key !== 'register') add(node, 'worker-register', `${key}: workers are not allowed in brand code`);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))) {
      const name = memberName(node);
      const nameNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      if (name !== null) {
        if (rules.injectionProps.has(name)) add(nameNode, 'inject-html', `${name}: HTML insertion is not allowed in brand code`);
        if (rules.injectionCalls.has(name)) add(nameNode, 'inject-call', `${name} inserts or evaluates markup or code and is not allowed in brand code`);
        if (rules.qrlIntrospection.has(name)) {
          const recv = unwrap(node.expression);
          if (!(name === 'resolve' && ts.isIdentifier(recv) && recv.text === 'Promise') && !isLocalMember(local, recv, name)) add(nameNode, 'qrl-introspection', `.${name}: reading a QRL's internals is not allowed`);
        }
        if (name === 'register' && !isLocalMember(local, node.expression, 'register')) add(nameNode, 'worker-register', '.register: service-worker and worker registration is not allowed in brand code');
        if (rules.workerCalls.has(name) && name !== 'register') add(nameNode, 'worker-register', `${name}: workers are not allowed in brand code`);
        if (CREATE_ELEMENT.has(name)) {
          const call = node.parent;
          if (!(call && ts.isCallExpression(call) && call.expression === node)) add(nameNode, 'inject-element', `${name} must be called directly with a literal tag from the allow list; aliases and bind are not allowed`);
        }
      }
    }
    if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)) {
      const recv = unwrap(node.expression);
      if (ts.isIdentifier(recv) && DOCUMENT_LIKE.has(recv.text)) add(node, 'inject-element', `${recv.text}[<computed>]: computed member access on a global object is not allowed`);
    }
    if (ts.isIdentifier(node) && !isNamePosition(node) && !(node.parent && (ts.isBindingElement(node.parent) || ts.isParameter(node.parent) || ts.isVariableDeclaration(node.parent) && node.parent.name === node))) {
      const t = node.text;
      if (t === 'eval' || t === 'Function' || t === 'importScripts') add(node, 'inject-call', `${t} evaluates code and is not allowed in brand code`);
      if (t === 'Worker' || t === 'SharedWorker') add(node, 'worker-register', `${t} is not allowed in brand code`);
      if (CREATE_ELEMENT.has(t) && !isCalleeOf(node)) add(node, 'inject-element', `${t} must be called directly with a literal tag from the allow list`);
    }
    // calls
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      const name = ts.isIdentifier(callee) ? callee.text : memberName(callee);
      const args = node.arguments ?? [];
      if (name !== null && CREATE_ELEMENT.has(name)) {
        const tagArg = name === 'createElementNS' ? args[1] : args[0];
        if (!tagArg || !ts.isStringLiteralLike(tagArg) || !rules.createElementAllow.has(tagArg.text.toLowerCase())) add(node, 'inject-element', `${name} must be called with a literal tag from the allow list (${[...rules.createElementAllow].join(', ')})`);
      }
      if (name !== null && SET_ATTRIBUTE.has(name)) {
        const nameArg = name === 'setAttributeNS' ? args[1] : args[0];
        if (!nameArg || !ts.isStringLiteralLike(nameArg)) add(node, 'inject-element', `${name} needs a literal attribute name`);
        else if (/^on/i.test(nameArg.text) || nameArg.text.toLowerCase() === 'srcdoc') add(node, 'inject-element', `${name}('${nameArg.text}') sets an executable attribute`);
      }
      if (name !== null && TIMERS.has(name) && args[0] && isStringy(args[0])) add(node, 'inject-element', `${name} with a string runs code from a string`);
      if (name === 'Worker' || name === 'SharedWorker') add(node, 'worker-register', `${name} is not allowed in brand code`);
    }
    // .src / .href writes
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(node.left);
      const n = memberName(left);
      if (n !== null && URL_PROPS.has(n)) {
        const recv = unwrap(left.expression);
        const ok = ((ts.isIdentifier(recv) && okElements.has(recv.text)) || isLocalData(local, recv)) && !(isStringy(node.right) && /^\s*javascript:/i.test(unwrap(node.right).text ?? ''));
        if (!ok) add(left, 'inject-element', `.${n} may only be set on an element created with a literal allowed tag or on a local data object`);
      }
    }
    // javascript: literals
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && /^\s*javascript:/i.test(node.text)) add(node, 'inject-element', 'javascript: URLs are not allowed');
  });
}

/** Code-shape findings of one source file. */
export function shapeFindings(layers, relFile, text) {
  const rules = compile(layers);
  const sf = parseSource(relFile, text);
  const out = [];
  const seen = new Set();
  const add = (node, rule, message) => {
    const pos = position(sf, node);
    const key = `${pos.line}:${pos.col}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: relFile, ...pos, rule, message });
  };

  // Local names that alias a forbidden definer or an exact orchestration entry point.
  const aliasDef = new Set();
  const aliasOrch = new Set();
  walk(sf, (node) => {
    if (!ts.isImportSpecifier(node)) return;
    const imported = (node.propertyName ?? node.name).text;
    if (rules.definitions.has(imported)) aliasDef.add(node.name.text);
    if (rules.orchestrationNames.has(imported)) aliasOrch.add(node.name.text);
  });

  for (const { node, spec } of collectModuleSpecifiers(sf)) {
    if (spec === null) continue;
    const clean = spec.replace(/[?#].*$/, '');
    if ((layers.imports.forbidden ?? []).some((f) => clean === f || clean.startsWith(`${f}/`))) {
      add(node, 'import-forbidden', `'${spec}' is forbidden in overlay files (use the platform API)`);
    }
  }

  walk(sf, (node) => {
    if (ts.isIdentifier(node) && !isNamePosition(node)) {
      const t = node.text;
      if (rules.definitions.has(t) || aliasDef.has(t)) add(node, 'definition-call', `${t}: loaders, actions and server functions are defined only in the platform; re-export them from ~/platform/*`);
      else if (rules.networkGlobals.has(t)) add(node, 'global-network', `global ${t} is not allowed in overlay files; call a platform hook`);
      else if (rules.orchestrationNames.has(t) || aliasOrch.has(t)) add(node, 'orchestration-call', `${t} is platform orchestration; overlay files may not call or reference it`);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      const onGlobal = isGlobalReceiver(rules, node.expression);
      if (rules.definitions.has(name)) add(node.name, 'definition-call', `.${name}: loaders, actions and server functions are defined only in the platform`);
      if (rules.networkMethods.has(name)) add(node.name, 'global-network', `.${name} is not allowed in overlay files`);
      if (onGlobal && rules.networkGlobals.has(name)) add(node.name, 'global-network', `${unwrap(node.expression).text}.${name} is not allowed in overlay files`);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const name = node.argumentExpression.text;
      const onGlobal = isGlobalReceiver(rules, node.expression);
      if (rules.definitions.has(name)) add(node.argumentExpression, 'definition-call', `['${name}'] is a platform-only definer`);
      if (rules.networkMethods.has(name) || (onGlobal && rules.networkGlobals.has(name))) add(node.argumentExpression, 'global-network', `['${name}'] is not allowed in overlay files`);
    }
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      const last = chain[chain.length - 1];
      if (last !== undefined) {
        const byName = rules.orchestrationNames.has(last) || aliasOrch.has(last) || rules.orchestrationPatterns.some((re) => re.test(last));
        const byGateway = chain.some((n) => rules.gateway.test(n));
        if (byName || byGateway) add(node, 'orchestration-call', `call target ${chain.join('.')} is payment or stock orchestration; use a ~/platform/* hook`);
      }
    }
  });
  injectionFindings(rules, sf, add);
  return out;
}

export function checkOverlayShape({ root, layers, files }) {
  const rootReal = fs.realpathSync(root);
  const findings = [];
  let checked = 0;
  for (const raw of files) {
    const rel = normalizeRel(raw);
    if (!isCodeFile(layers, rel)) continue;
    const abs = path.join(rootReal, rel);
    if (!fs.existsSync(abs)) { findings.push({ file: rel, line: 1, col: 1, rule: 'file-missing', message: `${rel} is listed but does not exist` }); continue; }
    checked++;
    findings.push(...shapeFindings(layers, rel, fs.readFileSync(abs, 'utf8')));
  }
  return { findings, checked };
}

/** Base L2 code files (classified L2, not overlay-origin) run through the same rules. */
export function checkBaseL2Shape({ root, layers, overlay = [] }) {
  const rootReal = fs.realpathSync(root);
  const skip = new Set(overlay);
  const files = listProjectFiles(rootReal).filter((rel) => {
    if (skip.has(rel) || !isCodeFile(layers, rel)) return false;
    try { return classify(layers, rel)?.layer === 'L2'; } catch { return false; }
  });
  const findings = [];
  for (const rel of files) findings.push(...shapeFindings(layers, rel, fs.readFileSync(path.join(rootReal, rel), 'utf8')));
  return { findings, checked: files.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2), ['--base']);
  const root = path.resolve(opts.root ?? PACKAGE_ROOT);
  const layers = loadLayers(opts.layers ? path.resolve(opts.layers) : path.join(root, 'layers.json'));
  if (opts.base) {
    const listFile = opts['overlay-list'] ? path.resolve(opts['overlay-list']) : path.join(root, '.compose-overlay-files.txt');
    const overlay = fs.existsSync(listFile) ? readOverlayList(listFile) : [];
    const { findings, checked } = checkBaseL2Shape({ root, layers, overlay });
    const block = layers.codeShape.baseL2Enforcement === 'block';
    for (const f of findings) console.log(`${block ? 'FAIL' : 'report'} ${formatFinding(f)}`);
    console.log(`check-code-shape: base L2, ${checked} file(s), ${findings.length} finding(s), enforcement ${block ? 'block' : 'report'}`);
    process.exit(block && findings.length > 0 ? 1 : 0);
  }
  const files = resolveOverlayFiles(opts, root);
  if (files.length === 0) {
    console.log('check-code-shape: no overlay files (base alone), nothing to check');
    return;
  }
  const { findings, checked } = checkOverlayShape({ root, layers, files });
  for (const f of findings) console.error(formatFinding(f));
  if (findings.length > 0) {
    console.error(`check-code-shape: ${findings.length} finding(s) in ${files.length} overlay file(s)`);
    process.exit(1);
  }
  console.log(`check-code-shape: ${checked} overlay code file(s) clean`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
