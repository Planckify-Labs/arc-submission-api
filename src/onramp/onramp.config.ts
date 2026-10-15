/**
 * Onramp configuration, resolved once from env.
 *
 * Spec: mobile-app docs/onramp-app-kit-spec.md §2.3, §5.2, §5.3.
 *
 * Everything the app needs to decide whether Buy is shown comes from here
 * through `GET /onramp/config` (the x402 "rails are API-driven" rule), so
 * a new chain or token, the environment flip, and the kill switch are all
 * env changes with no app release.
 *
 * Pure: takes a getter, returns a value. No Nest, so the spec can test it
 * without a module.
 */

export type OnrampEnvironment = "sandbox" | "production";

/** One receivable chain. `widgetChain` stays server-side. */
export interface OnrampSupportEntry {
  /** CAIP-2 chain id the app matches wallets against, e.g. "eip155:5042002". */
  chainKey: string;
  /** Chain label the widget understands for asset scoping, e.g. "arc". */
  widgetChain: string;
  tokens: string[];
}

/**
 * Why Buy is off. Ops vocabulary only (no values, no secrets), returned so
 * a debug build can say why the tab is missing instead of hiding it in
 * silence.
 */
export type OnrampDisabledReason =
  | "flag_off"
  | "no_api_key"
  | "no_supported_chain"
  | "no_hosted_page"
  | "no_referrer_domain";

export interface OnrampConfig {
  enabled: boolean;
  disabledReason: OnrampDisabledReason | null;
  environment: OnrampEnvironment;
  apiKey: string | null;
  apiBaseUrl: string;
  widgetBaseUrl: string;
  /** Bare hostname, never from a request header (§5.3). */
  referrerDomain: string | null;
  /**
   * The page that hosts the widget (§4.5.1 route A2, the
   * `takumipay-onramp` project). Required: the widget's CSP is
   * `frame-ancestors https: http://localhost:*`, so a page bundled into
   * the app (`file://`, or Metro on a LAN address) is refused.
   */
  hostedPageUrl: string | null;
  support: OnrampSupportEntry[];
  /** https hosts the widget may open in the system browser (§7). */
  externalLinkHosts: string[];
  sessionsPerWindow: number;
  sessionWindowMs: number;
}

/** §2.3. Server and client must use the SAME widget origin (error 1910). */
const ENVIRONMENT_DEFAULTS: Record<
  OnrampEnvironment,
  { apiBaseUrl: string; widgetBaseUrl: string; support: OnrampSupportEntry[] }
> = {
  sandbox: {
    apiBaseUrl: "https://api-test.circle.com",
    widgetBaseUrl: "https://onramp-sandbox.arc.io",
    // Arc Testnet. The only chain the widget delivers to is Arc (§2.1).
    support: [
      {
        chainKey: "eip155:5042002",
        widgetChain: "arc",
        tokens: ["USDC", "EURC"],
      },
    ],
  },
  production: {
    apiBaseUrl: "https://api.circle.com",
    widgetBaseUrl: "https://onramp.arc.io",
    // Arc mainnet availability is unconfirmed (spec Q10). Production stays
    // dark until ONRAMP_SUPPORT names a chain explicitly.
    support: [],
  },
};

const DEFAULT_EXTERNAL_LINK_HOSTS = ["arc.io", "circle.com", "transak.com"];

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** True for a bare hostname: no scheme, port, path, wildcard or IP. */
export function isBareHostname(value: string): boolean {
  if (!HOSTNAME_RE.test(value)) return false;
  // An all-numeric last label is an IPv4 literal, not a hostname.
  const last = value.slice(value.lastIndexOf(".") + 1);
  return !/^\d+$/.test(last);
}

function parseSupport(raw: string | undefined): OnrampSupportEntry[] | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ONRAMP_SUPPORT is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ONRAMP_SUPPORT must be a JSON array");
  }
  return parsed.map((entry, i) => {
    const e = entry as Partial<OnrampSupportEntry>;
    if (
      typeof e?.chainKey !== "string" ||
      !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(e.chainKey) ||
      typeof e.widgetChain !== "string" ||
      !e.widgetChain ||
      !Array.isArray(e.tokens) ||
      e.tokens.length === 0 ||
      !e.tokens.every(
        (t) => typeof t === "string" && /^[A-Z0-9]{2,12}$/.test(t),
      )
    ) {
      throw new Error(`ONRAMP_SUPPORT[${i}] is malformed`);
    }
    return {
      chainKey: e.chainKey,
      widgetChain: e.widgetChain,
      tokens: e.tokens,
    };
  });
}

function parseHttpsUrl(name: string, raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must be https`);
  return url.toString().replace(/\/$/, "");
}

/**
 * The hosted page URL, kept exactly as given (its trailing slash makes the
 * page's relative bundle path resolve). https, or `http://localhost` in
 * sandbox only: the widget accepts a localhost frame parent, which is how
 * a dev phone reaches a local page through `adb reverse`.
 */
function parseHostedPageUrl(
  raw: string | undefined,
  environment: OnrampEnvironment,
): string | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("ONRAMP_HOSTED_PAGE_URL is not a valid URL");
  }
  const localDev =
    environment === "sandbox" &&
    url.protocol === "http:" &&
    url.hostname === "localhost";
  if (url.protocol !== "https:" && !localDev) {
    throw new Error(
      "ONRAMP_HOSTED_PAGE_URL must be https (http://localhost only in sandbox)",
    );
  }
  return url.toString();
}

function parseCsv(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Build the config. Throws on a malformed value so a bad deploy fails at
 * boot rather than minting sessions against the wrong origin.
 *
 * `enabled` is true only when the flag is on AND an API key is set AND at
 * least one chain is supported AND a hosted page is configured.
 * Production additionally needs a `referrerDomain`, which is enforced
 * there for card / Apple Pay / Google Pay (§2.3).
 */
export function resolveOnrampConfig(
  get: (key: string) => string | undefined,
): OnrampConfig {
  const environment: OnrampEnvironment =
    get("ONRAMP_ENVIRONMENT") === "production" ? "production" : "sandbox";
  const defaults = ENVIRONMENT_DEFAULTS[environment];

  const referrerRaw = get("ONRAMP_REFERRER_DOMAIN")?.trim() || null;
  if (referrerRaw && !isBareHostname(referrerRaw)) {
    throw new Error(
      "ONRAMP_REFERRER_DOMAIN must be a bare hostname (no scheme, port or path)",
    );
  }

  const apiKey = get("ONRAMP_API_KEY")?.trim() || null;
  const support = parseSupport(get("ONRAMP_SUPPORT")) ?? defaults.support;
  // On unless explicitly switched off; it still needs a key and a chain.
  const flag = get("ONRAMP_ENABLED") !== "false";

  const externalLinkHosts =
    parseCsv(get("ONRAMP_EXTERNAL_LINK_HOSTS")) ?? DEFAULT_EXTERNAL_LINK_HOSTS;
  for (const host of externalLinkHosts) {
    if (!isBareHostname(host)) {
      throw new Error("ONRAMP_EXTERNAL_LINK_HOSTS must be bare hostnames");
    }
  }

  const sessionsPerWindow = Number(get("ONRAMP_SESSION_RATE_LIMIT") ?? "10");
  const hostedPageUrl = parseHostedPageUrl(
    get("ONRAMP_HOSTED_PAGE_URL"),
    environment,
  );

  const disabledReason: OnrampDisabledReason | null = !flag
    ? "flag_off"
    : apiKey === null
      ? "no_api_key"
      : support.length === 0
        ? "no_supported_chain"
        : hostedPageUrl === null
          ? "no_hosted_page"
          : environment === "production" && referrerRaw === null
            ? "no_referrer_domain"
            : null;

  return {
    enabled: disabledReason === null,
    disabledReason,
    environment,
    apiKey,
    apiBaseUrl:
      parseHttpsUrl("ONRAMP_API_BASE_URL", get("ONRAMP_API_BASE_URL")) ??
      defaults.apiBaseUrl,
    widgetBaseUrl:
      parseHttpsUrl("ONRAMP_WIDGET_BASE_URL", get("ONRAMP_WIDGET_BASE_URL")) ??
      defaults.widgetBaseUrl,
    referrerDomain: referrerRaw,
    hostedPageUrl,
    support,
    externalLinkHosts,
    sessionsPerWindow:
      Number.isFinite(sessionsPerWindow) && sessionsPerWindow > 0
        ? sessionsPerWindow
        : 10,
    sessionWindowMs: 10 * 60 * 1000,
  };
}
