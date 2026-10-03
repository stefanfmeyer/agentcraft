package dev.agentcraft.client;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import net.minecraft.client.Minecraft;

/**
 * Environment switches for the client. All are read from environment variables (or the
 * equivalent -D system property, e.g. -Dagentcraft.mute=0) once at startup.
 *
 * <pre>
 * AGENTCRAFT_DEV_PORT   DevBridge port (default 7879), 127.0.0.1 only
 * AGENTCRAFT_DEV        0 disables the DevBridge (default on)
 * AGENTCRAFT_MUTE       1 (default) forces master+music volume to 0 at startup; 0 keeps your volume
 * AGENTCRAFT_FOCUS      0 (default) = the window opens WITHOUT taking focus; 1 = normal focus
 * AGENTCRAFT_AUTOWORLD  1 (default) = create/load the "AgentCraft HQ" world on startup; 0 = title screen
 * AGENTCRAFT_SHOTS_DIR  where dev.screenshot writes PNGs (default &lt;repo&gt;/artifacts/shots)
 * AGENTCRAFT_HOST       Foreman host (default 127.0.0.1; remote Foreman: its LAN/Tailscale IP)
 * AGENTCRAFT_TOKEN      shared secret for a remote Foreman (sent as the WS Authorization bearer)
 * </pre>
 */
public final class ClientEnv {
	private ClientEnv() {
	}

	public static final int DEV_PORT = intValue("AGENTCRAFT_DEV_PORT", 7879);
	public static final boolean DEV_BRIDGE = flag("AGENTCRAFT_DEV", true);
	public static final boolean MUTE = flag("AGENTCRAFT_MUTE", true);
	public static final boolean TAKE_FOCUS = flag("AGENTCRAFT_FOCUS", false);
	public static final boolean AUTO_WORLD = flag("AGENTCRAFT_AUTOWORLD", true);

	public static String raw(String envName) {
		String prop = System.getProperty(envName.toLowerCase(Locale.ROOT).replace('_', '.'));
		if (prop != null && !prop.isBlank()) {
			return prop.trim();
		}
		String env = System.getenv(envName);
		return env == null || env.isBlank() ? null : env.trim();
	}

	public static boolean flag(String envName, boolean def) {
		String v = raw(envName);
		if (v == null) {
			return def;
		}
		return switch (v.toLowerCase(Locale.ROOT)) {
			case "1", "true", "yes", "on" -> true;
			case "0", "false", "no", "off" -> false;
			default -> def;
		};
	}

	public static int intValue(String envName, int def) {
		String v = raw(envName);
		if (v == null) {
			return def;
		}
		try {
			return Integer.parseInt(v);
		} catch (NumberFormatException e) {
			return def;
		}
	}

	/**
	 * Directory screenshots are written to. In the dev layout the game dir is
	 * &lt;repo&gt;/mod/run, so the default is &lt;repo&gt;/artifacts/shots.
	 */
	public static Path shotsDir() {
		String override = raw("AGENTCRAFT_SHOTS_DIR");
		if (override != null) {
			return Path.of(override).toAbsolutePath().normalize();
		}
		Path gameDir = Minecraft.getInstance().gameDirectory.toPath().toAbsolutePath().normalize();
		Path repo = gameDir.getParent() != null ? gameDir.getParent().getParent() : null;
		if (repo != null && Files.isDirectory(repo.resolve("mod")) && Files.isDirectory(repo.resolve("docs"))) {
			return repo.resolve("artifacts").resolve("shots");
		}
		return gameDir.resolve("agentcraft-shots");
	}
}
