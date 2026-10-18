# dsh-control

English | [中文](README.zh.md)

**Every machine already runs dsh. Make this one window the front end for all of them.**

Chat with the dsh instances on your other machines, natively from your local sidebar.
Remote sessions stream back token by token; the remote uses its own model credentials,
tools and sandbox. Zero changes on the remote. Zero dependencies. One-line install.

![dsh-control in action](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/hero.png)

*Two dsh windows answering the same question. The left window shows a session auto-named
`控制端·<local title>` (①) — that naming only happens on the machine the plugin drives. The right
window shows the workspace `cn-dsh2` the plugin created (②) and the model route set to the
environment name (③).*

> 🎬 A 15-second capture (one-click connect → streaming reply) is being recorded.

## Install

```sh
dsh plugin --profile <your profile> add github:6mt/dsh-control
```

Use the profile you already run (usually `web` or `desktop`). No build step, no native
modules, no dependencies — the plugin is plain JavaScript and installs as-is.

<details>
<summary>GitHub slow or blocked? Install from the release tarball instead</summary>

Download [dsh-control-0.2.0.tgz](https://github.com/6mt/dsh-control/releases/download/v0.2.0/dsh-control-0.2.0.tgz)
and run:

```sh
dsh plugin --profile <your profile> add ./dsh-control-0.2.0.tgz
```
</details>

After installing, **fully quit and reopen dsh** (⌘Q — closing the window is not enough),
then:

- Right sidebar →「远程 dsh 环境」→ type `user@host` → connect
- Left sidebar →「🌐 远程环境」→ pick the environment tab to enter the remote's full UI

> Upgrades need the same ⌘Q: a plugin's host half loads at process start.

> An npm package (`dsh-control`) is prepared and can be published later; the GitHub
> command above is the current install path.

## Versions & updating

- **What you get**: `github:6mt/dsh-control` installs the newest commit of `main` and
  **pins it in your profile's lockfile** — it does not silently follow later commits.
- **Update**: `dsh plugin --profile <your profile> update dsh-control`
  *(pnpm re-resolves the git ref and pulls the new code)*
- **Pin a version**: `github:6mt/dsh-control#v0.2.0` (tag) or `github:6mt/dsh-control#<commit>`
- Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## How is this different from the same-named `dsh-control` skill?

There is another project called `jacjackai/dsh-control` — a **skill** that lets an AI agent
operate the DSH **on your own machine**. This repository is a **plugin** for a different
job: **across machines**. It brings the dsh instances you already run on other servers into
one local window (their sessions appear natively in the sidebar, and the whole remote UI
can be opened in place). The two can coexist.

## How is this different from dsh-remote / dsh-remote-ssh?

![How the two approaches differ](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/compare.svg)

| | Remote-workspace plugins (dsh-remote, …) | **dsh-control** |
|---|---|---|
| The remote machine is a | **file system** (SFTP tool set) | **dsh that is already running there** |
| Sessions live | local session + remote directory | **remote sessions, native in your sidebar** |
| Credentials & tools | configured locally, SSH config duplicated | the remote's own — nothing copied |
| Remote needs | only SSH | dsh installed (≥0.2.0-rc.2) with its web instance running |
| Changes on the remote | some deploy dsh for you | **zero** (read-only probing + the remote's own API) |

The two **coexist** (tested side by side): no dsh on the remote → use dsh-remote;
dsh already there → use dsh-control.

## What it does

![The remote dsh environments panel](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/panel.png)

*The「远程 dsh 环境」panel: type `user@host` and connect — the row then reports its state and
whether the environment already has its workspace.*

- **One-click connect** — type `user@host`; the plugin probes the remote dsh, fetches
  its access token and opens an encrypted channel (~5 s)
- **Automatic workspace** — each environment gets a same-named local workspace; any
  session created inside it automatically becomes a remote session
- **True streaming** — remote replies flow in token by token, not dumped at the end
- **Paired naming** — remote sessions are named `控制端·<local title>`, so both sides match
- **Visible & self-healing** — remote sessions are marked in the sidebar; disconnects
  are reported honestly and repaired by one click

### The whole remote UI, brought inside

「🌐 远程环境」in the sidebar renders the remote machine's **complete dsh interface**
(workspaces, sessions, chat, settings) inside one local page, with a tab per environment:

![The remote environment page](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/remote-env.png)

*A real run on the remote machine. ① the environment tab — one tab per machine;
② the remote's own workspaces and sessions; ③ a real session running there — subagents,
code blocks and model usage all inside the page; ④ open it in a standalone window.*

- **The real interface, not a re-implementation** — the remote dsh renders itself, so it
  tracks whatever version the remote runs
- **Same-origin proxy** — the page is served by your local web server; the remote's
  credentials are injected server-side, so the browser never sees a token and any auth
  shell in front of the remote is irrelevant (traffic reaches the remote's loopback
  through the encrypted channel)
- **Switching panels keeps it alive** — go handle a local session and come back; the
  remote view is still there, no reload, no reconnect
- **Compression kept for assets** — only the document is uncompressed (it gets
  instrumented); bundles keep gzip

## Security

**What it does on your machine**: one state file
(`$DSH_HOME/dsh-control/state.json`, mode 0600, holds the remote access tokens) and an
on-demand SSH tunnel process.
**What it never does**: no installs or writes on the remote, no lifecycle management of
the remote dsh, never reads your other local credentials, tokens never enter logs.
When passwordless SSH is not set up it shows the exact one-line fix — passwords are
never stored. Details in [SECURITY.md](SECURITY.md).

## Known limitations

- The remote must already run dsh (≥ 0.2.0-rc.2) with its web instance (otherwise use a
  remote-workspace plugin)
- Connects over SSH (passwordless or configured key; a no-SSH "direct address" mode is
  implemented but not yet exposed in the UI)
- The remote-environment page **is** the remote's own UI: actions there really affect the
  remote machine (exactly as if you opened it in a browser)
- The first visit loads the remote's front-end assets (a few seconds depending on the
  network); later visits do not reload
- Sidebar markers and the streaming feel are verified by eye per release
- Cancelling a remote turn is implemented but marked experimental

## Development

```sh
node --check lib/*.js
for t in test/*.test.mjs; do node "$t"; done   # 52 checks: unit / contract / structural invariants
scripts/verify-boot-selfheal.sh                # boot self-heal (needs a local dsh runtime)
```

## License

MIT © 6mt
