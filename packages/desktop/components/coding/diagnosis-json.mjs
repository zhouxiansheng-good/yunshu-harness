/** Small bounded JSON reader: duplicate decoded keys are errors, not last-wins. */
export function parseDiagnosisJson(text, maximumDepth = 32) {
  let at = 0;
  const fail = () => { throw new Error('diagnosis-invalid-json'); };
  const space = () => { while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? '') && at < text.length) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') { at++; continue; }
      if (c === '"') {
        try { return JSON.parse(text.slice(start, at)); } catch { fail(); }
      }
    }
    fail();
  }
  function value(depth) {
    if (depth > maximumDepth) fail();
    space();
    const c = text[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; space(); const result = Object.create(null), keys = new Set();
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        space(); if (text[at] !== '"') fail();
        const key = string();
        if (keys.has(key)) throw new Error('diagnosis-duplicate-json-key');
        keys.add(key); space(); if (text[at++] !== ':') fail();
        result[key] = value(depth + 1); space();
        const end = text[at++]; if (end === '}') return result;
        if (end !== ',') fail();
      }
    }
    if (c === '[') {
      at++; space(); const result = [];
      if (text[at] === ']') { at++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space(); const end = text[at++];
        if (end === ']') return result;
        if (end !== ',') fail();
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const number = text.slice(at).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) fail();
    at += number[0].length; const result = Number(number[0]);
    if (!Number.isFinite(result)) fail();
    return result;
  }
  const result = value(0); space(); if (at !== text.length) fail(); return result;
}
