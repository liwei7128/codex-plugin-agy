const patterns: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED:PRIVATE_KEY]"],
  [/(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED:AUTH_HEADER]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED:ANTHROPIC_KEY]"],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:OPENAI_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED:GOOGLE_API_KEY]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g, "[REDACTED:GITHUB_TOKEN]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:AWS_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED:JWT]"],
];

export class SecretRedactor {
  private readonly values: string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.values = [...new Set(Object.entries(env).flatMap(([name, value]) =>
      /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name) &&
      !/^(CODEX_AGY_WORKER_TOKEN|SSH_AUTH_SOCK|GPG_KEY)$/i.test(name) && value && value.length >= 8
        ? [value] : [],
    ))].sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    for (const [pattern, replacement] of patterns) input = input.replace(pattern, replacement);
    for (const value of this.values) input = input.replaceAll(value, "[REDACTED:ENV_SECRET]");
    return input;
  }

  deep<T>(input: T): T {
    return this.visit(input, 0) as T;
  }

  private visit(value: unknown, depth: number): unknown {
    if (typeof value === "string") return this.text(value);
    if (!value || typeof value !== "object") return value;
    if (depth >= 64) return "[TRUNCATED]";
    if (Array.isArray(value)) return value.map(item => this.visit(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const normalized = key.toLowerCase().replaceAll(/[-_]/g, "");
      if (item != null && /^(apikey|accesstoken|refreshtoken|password|authorization|clientsecret|secret|token|privatekey|authtoken)$/.test(normalized)) {
        return [key, normalized === "authorization" ? "[REDACTED:AUTH_HEADER]" : "[REDACTED:ENV_SECRET]"];
      }
      return [this.text(key), this.visit(item, depth + 1)];
    }));
  }
}
