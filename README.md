English | [中文](README.zh.md)

# dsh-llm-kiro-local

A Kiro provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM seam.

This is a local fork of [joshryandavis/dsh-llm-aws-kiro](https://github.com/joshryandavis/dsh-llm-aws-kiro),
retargeted at the harness 0.2.x message model and package line. Fork-specific changes are
committed on top of the upstream history, so `git fetch upstream && git merge upstream/main`
keeps working.

The package is a standalone Cordis plugin: it mounts in any harness composition through
`cordis.yml`, registers the `kiro` provider route on `ctx.llm`, and needs no changes to the
harness itself.

## What it handles

| Concern | Implementation |
|---|---|
| **Existing credentials** | Picks up an existing kiro-cli login (the `auth_kv` table of kiro-cli's SQLite store, IDC and social tokens) and the Kiro IDE token (`~/.aws/sso/cache/kiro-auth-token.json` with its OIDC client registration) — no second sign-in. An optional `bearerTokenEnv` reference bypasses ambient discovery for CI/bots. |
| **Token refresh** | Silent refresh of expired tokens through the AWS SSO OIDC `/token` endpoint (Builder ID / IAM Identity Center) or the Kiro desktop auth service (Google/GitHub social), write-back into the kiro-cli store so both consumers stay in sync. A 403 mid-stream re-reads the shared store, then refreshes directly, then falls back to `kiro-cli whoami --format json`, which authenticates the live session and rotates an expired token. Every refresh transport is bounded by a timeout. Last-resort failure surfaces as `MISSING_CREDENTIAL`/AUTH with guidance. |
| **The backend** | Region/endpoint resolution (SSO region → Kiro API region), the management control plane (`List-Available-Profiles`, `List-Available-Models`, shared `~/.kiro-management-models-cache.json` catalog cache), and the runtime `generateAssistantResponse` call over the AWS event-stream protocol (Smithy framing via `@smithy/core`), with capacity backoff, first-token timeout, and the harness idle watchdog. |
| **Models** | A bootstrap catalog mirroring the kiro-cli-verified menu (21 models with context windows, output caps, reasoning capability, image modality), exact wire-id resolution (dashed harness ids ⇄ dotted wire ids), and the authenticated management catalog, which refreshes the served metadata and appends models that shipped after the bootstrap list — reaching the model picker, not just the Models page. The picker lists `auto` first, then the rest by descending credit multiplier with the cost shown in the label; a model the authenticated catalog no longer lists is dropped instead of offered. The reasoning-effort picker offers `off` plus each model's own Kiro effort rungs from its authenticated effort schema (e.g. `low`/`medium`/`high`/`xhigh`/`max`), with the Kiro thinking markers on the system prompt. |

Every runtime request carries the harness attribution inside `user-agent`, merged from
`@deepseek-ai/dsh-llm` `attributionHeaders()` onto the AWS SDK prefix the backend authorizes on, and
the same value as `x-amz-user-agent`.

The merge is not cosmetic. Measured on kiro-cli 2.36: a `user-agent` without the
`aws-sdk-rust/... app/AmazonQ-For-CLI` prefix is answered `403 User is not authorized to make this
call`, and so is one whose `x-amz-user-agent` keeps the prefix while `user-agent` drops it. Appending
the attribution to the prefix keeps both properties, so the adapter contract is satisfied without
losing authorization.

Settings section removed: harness 0.2.x projects a plugin's `Config` schema through `SettingsForms`
itself, so the provider registers a configurable route on `ctx.llm` instead of installing its own
settings section. The plugin's config still comes from its `cordis.patch.yml` entry.

## Icon and attribution

`icon.svg` is the official Kiro mark, downloaded from https://kiro.dev/icon.svg.
"Kiro" and its mark are trademarks of Amazon Web Services; the icon is used here
only to identify the product this plugin connects to. Replace it if you
redistribute the plugin under different branding.

## Install

The package is ESM and declares the harness packages it talks to as peer dependencies — the host
DSH installation provides them. It also declares the `dsh` bundle manifest
(`cordis.patch.yml` ships with the package), so it mounts as a profile bundle as well as a
plain plugin dependency.

```bash
dsh plugin --profile <profile> add dsh-llm-kiro-local
```

Mount it in `cordis.yml`:

```yaml
- id: llm-kiro
  name: 'dsh-llm-kiro-local'
  config:
    region: us-east-1        # optional; the credential's region wins when omitted
    reasoningEffort: high    # optional; off | low | medium | high | xhigh | max (default high)
```

That is the whole configuration for an existing kiro-cli or Kiro IDE login: credentials are picked
up ambiently, refreshed silently, and written back. A static bearer token works too:

```yaml
- id: llm-kiro
  name: 'dsh-llm-kiro-local'
  config:
    bearerTokenEnv: KIRO_BEARER_TOKEN   # stored via the harness credentials service
```

## Config reference

All fields are optional; the `llm-kiro` user-settings section uses the same schema and can be
edited at runtime — a change reaches the next request without a restart.

| Field | Default | Meaning |
|---|---|---|
| `region` | credential's region, else `us-east-1` | Kiro API region override. |
| `runtimeURL` | `https://runtime.<region>.kiro.dev` | Runtime endpoint override for gateway/proxy deployments. |
| `profileArn` | management discovery | Profile ARN override. |
| `bearerTokenEnv` | — | Credential reference for a static bearer token; bypasses ambient discovery. |
| `thinking` | `enabled` | Deployment lock; `disabled` limits every request to `off`. |
| `reasoningEffort` | `high` | Default effort; `off` disables thinking. Levels a model lacks round to its nearest rung. |
| `maxTokens` | `8192` | Default per-request output cap; per-model caps and explicit values win. |
| `defaultContextWindow` | `200000` | Context capacity for models without an exact value. |
| `models` | bootstrap catalog + authenticated discovery | Explicit model list; a non-empty value is served verbatim and disables discovery. |
| `streamIdleTimeoutMs` | `300000` | Per-read idle budget. |
| `firstTokenTimeoutMs` | `90000` | First-event budget; per-model overrides exist for slow models. |
| `retryPolicy` | normal, five retries | Provider-owned retry policy for `dsh-llm-retry`. |
| `kiroCliDbPath` | platform application-support | kiro-cli SQLite store override. |
| `ssoCacheDir` | `~/.aws/sso/cache` | Kiro IDE token directory override. |
| `allowKiroCliRefresh` | `true` | Whether 403 recovery may shell out to `kiro-cli`. |

Each entry of `models` accepts:

| Key | Default | Meaning |
|---|---|---|
| `id` | required | Harness model id shown in the picker (dashed form, e.g. `claude-sonnet-4-6`). |
| `kiroModelId` | derived from `id` | Exact wire id the runtime accepts (dotted form, e.g. `claude-sonnet-4.6`). |
| `name` | `id` | Picker label. |
| `reasoning` | `false` | Whether the model exposes reasoning content. |
| `contextWindow` | `200000` | Combined request/response capacity. |
| `maxTokens` | `8192` | Per-request output cap. |
| `inputModalities` | `['text']` | Accepted modalities; `image` enables image input. |
| `firstTokenTimeoutMs` | global default | Longer first-event budget for a slow model. |

## Models

Bootstrap catalog (harness id → wire id):

| Harness id | Wire id | Context | Reasoning | Images |
|---|---|---|---|---|
| `claude-opus-5-5` / `claude-opus-5` | `claude-opus-5.5` / `claude-opus-5` | 1M | ✓ | ✓ |
| `claude-opus-4-8` / `claude-opus-4-7` | `claude-opus-4.8` / `claude-opus-4.7` | 1M | ✓ | ✓ |
| `claude-opus-4-6` / `claude-opus-4-5` | `claude-opus-4.6` / `claude-opus-4.5` | 1M / 200K | ✓ | ✓ |
| `claude-sonnet-5` / `claude-sonnet-4-6` | `claude-sonnet-5` / `claude-sonnet-4.6` | 1M | ✓ | ✓ |
| `claude-sonnet-4-5` / `claude-sonnet-4` | `claude-sonnet-4.5` / `claude-sonnet-4` | 200K | ✓ | ✓ |
| `claude-haiku-4-5` | `claude-haiku-4.5` | 200K | ✗ | ✓ |
| `claude-fable-5` | `claude-fable-5` | 1M | ✓ | ✓ |
| `gpt-5-6-sol` / `gpt-5-6-terra` / `gpt-5-6-luna` | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | 1M | ✓ | ✗ |
| `deepseek-3-2` | `deepseek-3.2` | 164K | ✓ | ✗ |
| `minimax-m2-5` / `minimax-m2-1` | `minimax-m2.5` / `minimax-m2.1` | 196K | ✗ | ✗ |
| `glm-5` | `glm-5` | 200K | ✓ | ✗ |
| `qwen3-coder-next` | `qwen3-coder-next` | 256K | ✓ | ✗ |
| `auto` | `auto` | 1M | ✓ | ✓ |

Both dashed and dotted spellings resolve to the wire id. The bootstrap list is the pre-discovery
fallback and the pre-discovery menu; the authenticated management catalog
(`List-Available-Models`, per credential, per region) refreshes matched entries' capacities,
effort schemas, reasoning metadata and credit multiplier, and appends models the bootstrap list has
not learned yet. An explicit non-empty `models` list replaces discovery entirely and is served
verbatim, keeping the order its author wrote.

Discovery reaches the harness model picker: reading the model list serves the cache immediately and
refreshes it in the background for the next read, so a slow or unreachable management endpoint never
delays a picker or a request.

Once an authenticated catalog is present, it is authoritative in two ways:

- **Retired models drop out.** An entry the catalog no longer lists is removed rather than offered
  without a price, because selecting it would fail at request time. With no catalog fetched yet,
  nothing is treated as retired.
- **The picker orders by cost.** `auto` comes first, the rest follow in descending credit
  multiplier, and the multiplier appears in the label (`Claude Sonnet 5 · 1.3x`). A model the
  catalog did not price keeps its bare name and sorts last.

The catalog cache at `~/.kiro-management-models-cache.json` is shared with pi-provider-kiro:
that tool writes format version 1, this provider reads that layout and writes version 2. Entries are
held for eight hours before a refetch; delete the file to force one immediately.

## Development

```bash
pnpm install
pnpm run build       # tsc -b: compiles this package; deps resolve from the pinned @deepseek-ai packages
pnpm test            # vitest suite (121 tests): endpoints, store, refresh, models, effort, serialize,
                     # translate, adapter transport, real Loader composition
```

The suite pins behaviour that is easy to regress silently: the picker order, the eight-hour cache
boundary, the retirement rule for models the catalog dropped, and the request body each transport
sends.

Tests resolve the harness packages from the published `@deepseek-ai/*` packages in `node_modules`
(peer dependencies plus the dev-dependency set at the versions the code is developed against), so
they exercise the exact published APIs. Credential tests are fully isolated from the host
machine's real kiro-cli / Kiro IDE stores.

## Known limitations

A genuine gap, worth fixing if it ever matters:

- **Interactive login is not bundled.** With no ambient credentials the provider fails with
  `MISSING_CREDENTIAL` and points at `kiro-cli login` or the Kiro IDE. A device-code flow could be
  added on the management seam. The guidance covers the normal case, so this is a convenience gap,
  not a blocker.

## Deferred and deliberately not done

Each of these was evaluated and left alone. They are recorded so nobody re-opens them expecting a
bug.

- **A cost badge beside the model name.** The composer renders `conversation.input.model.label`, and
  a Client half was written for it following the shape of the official model-label plugin, but its
  registration never took effect on a link-installed package: the entry imported without failing
  boot, yet the slot kept only its built-in occupant. The multiplier therefore rides in the model
  name. Three implementations were tried; diagnosing further needs the browser console, which the
  Host cannot reach. The visible cost is equivalent — only the styling differs.
- **Replay state is not emitted.** History is resent as provider-neutral content on follow-ups. This
  is a design choice matching the other adapters, not a limitation: the Kiro backend does not ask
  for replay state.
- **The catalog refresh is pull-based, not scheduled.** Reading the model list serves the cached or
  bootstrap catalog and refreshes the cache for the next read, so a newly enabled model appears
  after the next refresh — at most eight hours after the catalog changes. Scheduling it would add a
  timer and a failure path for a menu that rarely moves.
- **A model is only as fresh as the last successful refresh.** The bootstrap list deliberately does
  not carry the newest entries, so the catalog stays authoritative; a cache that is missing or stale
  hides those models until a refresh succeeds. Serving stale-but-present data instead would need the
  retirement rule to also reason about age, which is a larger change than the case justifies.

## Verified behaviour that is sometimes assumed broken

Measured on kiro-cli 2.36.0, not assumed:

- **Reasoning arrives as native events.** `thinkingText` and `thinkingSignature` carry it; a model
  that dispatches internally (such as `auto`) emits no reasoning event at all rather than inlining
  `<thinking>` tags into visible content. No inline dialect was observed on any tested model.
- **Every refresh transport is bounded.** AWS SSO OIDC, the Kiro desktop auth service, and the
  `kiro-cli whoami` fallback each run under a timeout, so a hung auth endpoint fails the layer
  instead of stalling the turn.
- **Retired models are dropped, not offered.** An entry the authenticated catalog no longer lists is
  removed once a catalog has been read; with no catalog yet, nothing is treated as retired.

## License

MIT
