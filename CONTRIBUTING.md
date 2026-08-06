# Contributing

Thanks for looking. Open Session is a self-hosted agent-infrastructure server —
one Bun process serving a web UI, a set of integrations, and the machinery that
runs agent sessions in git worktrees.

## How contributions work

We take contributions as **human-written text, not code**. Describe the change
you'd like — a bug, a missing feature, a design objection — informally in a
`.txt` or `.md` file in [`adrs/`](adrs/), and open a pull request containing
just that file. If we're aligned, we handle the implementation (this is an
agent-infrastructure project; implementation is what the infrastructure is
for). Your name stays on the proposal.

Plain language beats a spec. Say what's wrong or missing, what you'd expect to
happen instead, and why it matters to you. A paragraph is enough; see
[`adrs/README.md`](adrs/README.md) for the little structure there is.

Two things that should *not* go through `adrs/`:

- **Vulnerabilities** — report privately, see [SECURITY.md](SECURITY.md).
  Never a public issue or proposal.
- **Bug reports** with no opinion about the fix — a regular issue is fine.
  Include what you ran, what happened, and `opensession doctor` output. If it
  is an install problem, the full installer output — it prints every step it
  took.

Code pull requests aren't the path for outside contributions — forking is.
The project is MIT-licensed and built to be made your own: instance config
covers branding, persona, repos and integrations without touching source
(see [Make it your own](README.md#make-it-your-own)), and a fork covers
everything else. The rest of this document is for people doing exactly that.

## Getting set up

```sh
git clone https://github.com/tellahq/opensession.git
cd opensession
bun install
bun run setup          # writes ~/.opensession/config.json and ~/.opensession.env
bun run opensession.ts # or: opensession start --foreground
```

You need [Bun](https://bun.sh) and `git`. Everything else is optional until you
touch the feature that needs it — `gh` for pull-request work, the
[OpenCode](https://opencode.ai) binary to actually execute agent turns, Docker
only if you are working on sandboxes.

The UI comes up at `http://127.0.0.1:3850`. There is no login by default; see
[the trust model](docs/setup/README.md#trust-model-read-this) before binding it
anywhere but loopback.

## Verifying your changes

```sh
bun run typecheck      # must be clean
bun test               # must be green
```

CI runs both, plus an end-to-end install on Linux and macOS. If you touched
`install.sh`, the CLI or the service definitions, that installer job is the one
that matters — it catches the things unit tests cannot, like a `PATH` that
works interactively and not from a script.

## Things that will surprise you

**Backend changes need a real restart.** The in-process watcher rebuilds the
frontend live, but nothing reloads the server. `opensession restart` (or
`systemctl restart opensession`) after a backend edit — and once, not after
every save.

**`bun --hot` is deliberately not used in production.** On Bun 1.3.14 a failed
reload can permanently stop timer delivery while HTTP keeps serving, which
looks like "sessions are running but never progress".

**Integrations are declared, not hand-wired.** Adding one means appending an
entry to `src/server/integrations/registry.ts` — config key, env flag,
credentials, constructor. `loadAgents()` is a loop over that array; you should
not need to touch `opensession.ts`. The array order is boot order, because
agents register webhook routes in sequence.

**Automations are per-instance data, not source.** Anything specific to one
company's product, customers or people belongs in that instance's config. The
repository ships only generic recipes — see
[recipes/README.md](recipes/README.md) for where the line is.

## Code style

Match the file you are editing. The codebase is fairly consistent about this,
and consistency beats any individual preference.

Comments should explain *why*, particularly when the code looks odd. A lot of
the stranger-looking decisions here encode a specific incident — `KillMode=mixed`
in the systemd unit, the `IPAddressDeny` line, the deny-before-allow ordering in
permission maps. If you find one of those and it has no comment, adding the
explanation is a genuinely useful contribution (as a proposal, per above).

Prefer deleting to adding. If a change makes something simpler, say so; that is
not a small thing.

## Security

Agent runs process untrusted text — customer tickets, pull-request diffs, issue
bodies. The rule is that constraints are enforced at the tool and environment
layer, never in a prompt:

- automation runs get a minimal environment with none of your tokens
- each automation carries an MCP-server allowlist
- customer-facing and identity-mutating tools are hard-denied for unattended runs
- money-moving tools are stripped from the model's tool list entirely

If a proposal touches any of that, call it out explicitly. If you find a way
around it, report it privately — see [SECURITY.md](SECURITY.md), which also
sets out what counts as a vulnerability here and what is working as designed.

## License

By contributing — proposals included — you agree that your contributions are
licensed under the [MIT License](LICENSE), the same license as the
project.
