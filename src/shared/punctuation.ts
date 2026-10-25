// Rewrites em and en dashes in model replies as plain punctuation (colon, comma, hyphen), which reads
// less machine-written. Code blocks and inline code are left alone. Shared with the web UI (served as
// /shared/punctuation.js), so this file must not import anything.

const DASH = /[\u2013\u2014]/;
const DASHES = /[\u2013\u2014]/g;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// Words that continue the sentence after a dash ("fast, and cheap" rather than "fast: and cheap").
const CONTINUES = /^(and|but|or|nor|so|yet|not|which|who|whom|whose|where|when|while|though|although|because|since|just|even|especially|including|like|than|then|plus|only|usually|often|mostly|maybe|perhaps|instead|unless|except|without|with|for|from|to|in|on|at|by|as|if|i\.e\.|e\.g\.)\b/i;
// "- ", "1. ", "## " or "> " in front of a line.
const LEAD = /^(\s*(?:>\s*)*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+)?)/;

function fixLine(line: string): string {
  let s = line
    // Ranges: 1–4, 2020—2024.
    .replace(/(\d)\s*[\u2013\u2014]\s*(?=\d)/g, '$1-')
    // A dash used as a bullet or attribution.
    .replace(/^(\s*(?:>\s*)*)[\u2013\u2014]\s+/, '$1- ')
    // "Here is what changed —"
    .replace(/\s*[\u2013\u2014]\s*$/, ':');
  if (!DASH.test(s)) return s;

  // A label at the start of a list item or heading: "- **Run** — starts it" becomes "- **Run**: starts it".
  const lead = LEAD.exec(s)![1]!;
  const rest = s.slice(lead.length);
  const marked = /^(\*\*[^*]+\*\*|__[^_]+__|\u0000\d+\u0000)\s*[\u2013\u2014]\s*/.exec(rest);
  const plain = /^([^\u2013\u2014.!?:;]{1,60}?)\s*[\u2013\u2014]\s*/.exec(rest);
  if (marked) s = `${lead}${marked[1]}: ${rest.slice(marked[0].length)}`;
  else if (plain && lead.trim() && (s.match(DASHES) ?? []).length === 1 && !CONTINUES.test(rest.slice(plain[0].length))) s = `${lead}${plain[1]}: ${rest.slice(plain[0].length)}`;

  // Two dashes inside one sentence are a parenthesis: "The router — which picks — is fast".
  s = s.replace(/\s*[\u2013\u2014]\s*([^\u2013\u2014.!?]{1,160}?)\s*[\u2013\u2014]\s*/g, (_m, inner: string) => `, ${inner}, `);

  // Any other dash: a comma when the sentence carries on, otherwise a colon.
  return s.replace(/\s*[\u2013\u2014]\s*/g, (_m, offset: number, whole: string) => {
    const next = whole.slice(offset + _m.length);
    if (offset === 0) return next ? '' : _m;
    return CONTINUES.test(next) ? ', ' : ': ';
  });
}

/** Applies fixLine to the prose of one line, keeping `inline code` as it is. */
function fixProse(line: string): string {
  if (!DASH.test(line)) return line;
  const code: string[] = [];
  const masked = line.replace(/(`+)[\s\S]*?\1/g, (m) => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  });
  return fixLine(masked).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)]!);
}

export function plainPunctuation(text: string): string {
  if (!text || !DASH.test(text)) return text;
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const m = FENCE.exec(line);
      if (fence) {
        if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) fence = null;
        return line;
      }
      if (m) {
        fence = m[1]!;
        return line;
      }
      return fixProse(line);
    })
    .join('\n');
}
