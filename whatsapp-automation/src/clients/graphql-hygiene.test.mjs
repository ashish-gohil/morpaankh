/*
 * graphql-hygiene — the one test that can catch a JavaScript comment inside a
 * GraphQL document.
 *
 * GraphQL has no /* *\/ and no //. Shopify answers a document containing one
 * with HTTP 200 carrying a `syntax error, unexpected invalid token ("/")`, so
 * nothing retries and nothing alarms on the status code. It killed the Flow R
 * cart sweep in production on 2026-11-02, and wa-reconcile logged
 * `Shopify GraphQL errors: syntax error, unexpected invalid token ("/") at
 * [12, 3]` five times before anyone looked.
 *
 * NO BEHAVIOURAL TEST CAN FIND THIS. The fakes never parse the query string,
 * so a document with a comment in it passes every unit test in this repo, and
 * validating a hand-copied clean version proves something about the copy. The
 * only thing that works is reading the real source and refusing the character.
 *
 * It reads the files rather than the exports because a document is a template
 * literal argument, not a value anything hands back.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'fakes') out.push(...sourceFiles(p));
    } else if (p.endsWith('.mjs') && !p.endsWith('.test.mjs')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every template literal passed straight to graphql(...), with the line it
 * starts on. Tracks ${...} nesting so an interpolated fragment (CALC, and the
 * repo has several) does not end the literal early.
 */
export function graphqlDocuments(source) {
  const docs = [];
  const re = /graphql\(\s*`/g;
  let m;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 0;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        depth += 1;
        i += 1;
        continue;
      }
      if (c === '}' && depth > 0) {
        depth -= 1;
        continue;
      }
      if (c === '`' && depth === 0) break;
    }
    docs.push({
      text: source.slice(start, i),
      line: source.slice(0, start).split('\n').length,
    });
    re.lastIndex = i + 1;
  }
  return docs;
}

describe('graphql hygiene', () => {
  const files = sourceFiles(SRC);

  it('finds the documents at all', () => {
    const total = files.reduce((n, f) => n + graphqlDocuments(readFileSync(f, 'utf8')).length, 0);
    // A scanner that silently matches nothing would pass every assertion
    // below, which is the one way this test could lie.
    expect(total).toBeGreaterThan(20);
  });

  it('no GraphQL document carries a JavaScript comment', () => {
    const offences = [];
    for (const f of files) {
      for (const doc of graphqlDocuments(readFileSync(f, 'utf8'))) {
        const rel = f.slice(SRC.length + 1);
        if (doc.text.includes('/*') || doc.text.includes('*/')) {
          offences.push(`${rel}:${doc.line} block comment inside a GraphQL document`);
        }
        for (const line of doc.text.split('\n')) {
          if (/^\s*\/\//.test(line)) {
            offences.push(`${rel}:${doc.line} line comment inside a GraphQL document: ${line.trim()}`);
          }
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('catches a comment the way the live failure was shaped', () => {
    // The Flow R document, reduced: a comment above a field. Shopify answered
    // 200 with "unexpected invalid token" and the sweep sent nothing.
    const bad = [
      'const data = await graphql(',
      '  `query Carts($q: String!){',
      '     /* the shopper who passed OTP */',
      '     abandonedCheckouts(first: 10, query: $q){ nodes{ id } }',
      '   }`,',
      ');',
    ].join('\n');
    const docs = graphqlDocuments(bad);
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toContain('/*');
  });

  it('reads an interpolated fragment to the end of the document', () => {
    const src = 'graphql(`mutation A($id: ID!){ orderEditBegin(id:$id){ calculatedOrder{ ${CALC} } } }`, { id })';
    const [doc] = graphqlDocuments(src);
    expect(doc.text).toContain('orderEditBegin');
    expect(doc.text.trim().endsWith('}')).toBe(true);
  });
});
