/**
 * LISA wordmark for the terminal.
 *
 * ANSI Shadow glyphs with a 24-bit orange->red gradient. Static art rather than a
 * figlet dependency: we only ever render one word.
 */

const WORDMARK = [
  " ██╗      ██╗ ███████╗  █████╗ ",
  " ██║      ██║ ██╔════╝ ██╔══██╗",
  " ██║      ██║ ███████╗ ███████║",
  " ██║      ██║ ╚════██║ ██╔══██║",
  " ███████╗ ██║ ███████║ ██║  ██║",
  " ╚══════╝ ╚═╝ ╚══════╝ ╚═╝  ╚═╝",
];

const TAGLINE = "autonomous qa — claude drives your staging app";

const FROM: RGB = [255, 170, 40];
const TO: RGB = [240, 60, 90];

type RGB = [number, number, number];

export function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

/** Banners are decoration: suppress them off-TTY, in CI, and on request. */
export function shouldShowBanner(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.LISA_NO_BANNER && !process.env.CI;
}

function ramp(text: string, width: number, offset = 0): string {
  if (!supportsColor()) return text;
  const span = Math.max(width - 1, 1);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const t = Math.min((i + offset) / span, 1);
    const [r, g, b] = FROM.map((c, k) => Math.round(c + (TO[k] - c) * t));
    out += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return out + "\x1b[0m";
}

function dim(text: string): string {
  return supportsColor() ? `\x1b[2m${text}\x1b[0m` : text;
}

/** Full six-row wordmark. Use for bare `lisa`, `lisa init`, `lisa install`. */
export function bannerFull(version?: string): string {
  const width = Math.max(...WORDMARK.map((l) => l.length));
  const art = WORDMARK.map((l) => ramp(l.padEnd(width), width)).join("\n");
  const foot = version ? `${TAGLINE}  ${dim(`v${version}`)}` : TAGLINE;
  return `\n${art}\n ${dim(foot)}\n`;
}

/** One-line mark. Use for routine commands where six rows would be noise. */
export function bannerLine(suffix?: string): string {
  const mark = ramp("▍lisa", 6);
  return suffix ? `${mark} ${dim(suffix)}` : mark;
}

export function printBanner(version?: string): void {
  if (shouldShowBanner()) process.stdout.write(bannerFull(version));
}
