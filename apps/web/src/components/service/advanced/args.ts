// Command arrays (CMD, ENTRYPOINT, health check commands) are edited as one
// line. These split a line the way a shell would for plain words and
// quotes, and join an array back so it round-trips.

export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      current += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(current);
      current = "";
      has = false;
    } else {
      current += c;
      has = true;
    }
  }
  if (has) out.push(current);
  return out;
}

export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (a === "" ? '""' : /[\s"'\\]/.test(a) ? `'${a.replace(/'/g, `'"'"'`)}'` : a)).join(" ");
}
