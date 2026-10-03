package dev.agentcraft.client.foreman;

import dev.agentcraft.client.ClientEnv;

/**
 * Where the Foreman lives and how to authenticate to it.
 *
 * <pre>
 * AGENTCRAFT_HOST   Foreman host (default 127.0.0.1); set it to the mini PC's LAN/Tailscale
 *                   IP to play against a remote Foreman
 * AGENTCRAFT_PORT   Foreman port (default 7878)
 * AGENTCRAFT_TOKEN  shared secret (required in remote mode; sent as the Authorization bearer
 *                   on the WebSocket upgrade)
 * </pre>
 */
public final class ForemanEnv {
	private ForemanEnv() {
	}

	public static String host() {
		String h = ClientEnv.raw("AGENTCRAFT_HOST");
		return h == null || h.isBlank() ? "127.0.0.1" : h.trim();
	}

	public static String token() {
		String t = ClientEnv.raw("AGENTCRAFT_TOKEN");
		return t == null ? "" : t.trim();
	}
}
