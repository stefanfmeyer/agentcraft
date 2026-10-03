# Running AgentCraft with a remote Foreman (NouStef mini PC + Windows game)

Architecture: the **Foreman** (agent orchestrator) runs headless on the Linux mini PC and
drives the characters as sessions of the Hermes gateway (NouStef). The **game** runs on
Windows and connects to the Foreman over the network (LAN or Tailscale). Agents work on
repos that live on the mini PC.

```
Windows PC                              mini PC (Linux)
+------------------------+              +--------------------------------------+
| Minecraft + AgentCraft |   WS + tok   | Foreman  (node, --backend hermes)    |
| mod  (client view)     | <----------> |   state, tasks, worktrees, merges    |
+------------------------+   :7878      |   POST /agentcraft/tool              |
                                         | Hermes gateway API server :8642      |
                                         |   character sessions (NouStef)       |
                                         +--------------------------------------+
```

## One-time setup (mini PC)

```sh
# in the repo checkout
cd foreman && npm install
# the backend needs the gateway key
echo 'AGENTCRAFT_HERMES_KEY=<API_SERVER_KEY from ~/.hermes/.env>' >> ~/.agentcraft.env
```

## Start the Foreman (mini PC)

```sh
# remote mode: bind a LAN/Tailscale address; requires a shared token
export AGENTCRAFT_TOKEN=$(openssl rand -hex 16)
tools/launch-linux.sh --remote <mini-pc-ip> --repo /home/stefan/Developer/<repo>

# stop it
tools/launch-linux.sh --stop
```

The Foreman creates six persistent gateway sessions (one per character:
`agentcraft-hermes-marlow`, `-juniper`, `-kit`, `-wren`, `-rowan`, `-tove`). They keep
their history across Foreman restarts; state (tasks, decisions, worktrees) is saved under
`~/.agentcraft/hermes/`.

## Play (Windows PC)

```powershell
$env:AGENTCRAFT_TOKEN = "<the token from the mini PC>"
tools\launch.ps1 -Backend hermes -ForemanHost <mini-pc-ip> -Repo C:\path\to\repo
```

`-ForemanHost` points the game at the remote Foreman and skips starting a local one. The
repo path given to the **Foreman** is the mini PC path; repos on the Windows disk are not
visible to the agents (work happens where the Foreman runs).

## Security notes

- A non-loopback Foreman refuses every WebSocket/HTTP client without the shared token
  (`Authorization: Bearer <token>`; the mod sends it automatically from
  `AGENTCRAFT_TOKEN`).
- Browser origins are refused in every mode (DNS-rebinding guard kept).
- The characters reach the Foreman's coordination endpoint from the same machine
  (loopback). They authenticate with the same token when the endpoint is exposed.
- The merge guarantee is unchanged: nothing is merged without an in-game decision
  answered by the player, and agents' git can never push.

## Differences from the claude backend

- Characters are Hermes gateway sessions with full tool access on the mini PC (terminal,
  files) instead of claude CLI sessions locked to their worktree. The worktree discipline
  is enforced by prompts, not by a tool policy sandbox. Merge safety is unchanged.
- There is no lead review turn; a finished task goes straight to a merge decision with
  the CI result and the worker's summary.
- No per-turn token spend tracking (the gateway meters usage globally).
