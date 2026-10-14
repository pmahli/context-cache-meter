# context-cache-meter

A [Claude Code](https://claude.com/claude-code) mod that draws a band above the prompt: how full the context is, whether the prompt cache is warm or cold, and when to `/compact`.

```
Kontext ██████░░░░ 61 % bis Auto-Compact (102k/167k)  ·  Cache ● warm, noch 41 Min  ·  Zugstart 99 % aus Cache
```

> **Language:** the texts in the band and in the toasts are currently German. Everything else (code, docs) is English. A language option is a small change if there is interest.

## What it shows

- **Context**: tokens against the auto-compact mark, so the bar tells you how far you are from the automatic compaction, not from the hard limit. If auto-compact is off or the mark cannot be read, it falls back to the model's context window.
- **Cache**:
  - `● warm, noch X Min`, with `⚠` in the last fifth of the lifetime
  - `● aktiv` while a turn is running
  - `○ kalt (seit X Min), ~Xk neu` once it has lapsed, with the amount the next answer has to write again

  The remaining time is calculated (last response + lifetime). The API does not report it.
- **Turn start** (from 115 columns): the share of input tokens the cache served on the first request of a turn, with the pause before it. It is measured per request, not summed over the turn, so a cold start is not hidden by the cache hits that follow it.
- **Cold start note**: one line when a request found the cache cold after a known pause. If the pause was between 5 minutes and the configured lifetime, the note adds a suspicion that only the 5-minute lifetime applies (also once per session as a toast). It is a suspicion, not a measurement: a model switch, `/compact` or changed tools empty the cache the same way.
- **Hints at 70 % and 90 %** of the auto-compact mark: a toast (once per rise) and a yellow or red line. After `/compact` or `/clear` both are armed again.
- **Compact button at 90 %**: only then, and not while a turn is running. The first press arms it, a second press within 8 seconds compacts, because a compaction cannot be undone.

## Setting

| Option | Default | Meaning |
| --- | --- | --- |
| `cacheTtlMinutes` | `60` | How long the cache stays warm after the last response: `5` (the API default) or `60` (the 1-hour cache). Set it to match your session. |

## Install

In a terminal session:

```
/plugin install context-cache-meter --marketplace pmahli/context-cache-meter
```

The `/plugin` command is not available in the Code tab of the desktop app, but a mod installed from a terminal at the user scope also loads there.

## Develop

```
claude plugin validate .
claude plugin test .
```

The mod keeps its values in the session's `$.state`. `hooks/meter.ts` holds the pure helpers, `hooks/register.tsx` the hooks.

## License

[MIT](LICENSE)
