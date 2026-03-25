import { initWasm, Resvg } from "@resvg/resvg-wasm";
// @ts-ignore — Bun embed: returns a $bunfs path at runtime in compiled binaries
import resvgWasmPath from "../node_modules/@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };
import { readFile, unlink } from "fs/promises";
import { readFileSync, existsSync } from "fs";

const AVATAR_SIZE = 256;
const INLINE_SVG_WIDTH = 800;

let wasmInitialized = false;
let fontBuffers: Uint8Array[] = [];

/** Try to load system fonts for SVG text rendering */
function loadSystemFonts(): Uint8Array[] {
  const fontPaths = [
    // Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    // macOS
    "/System/Library/Fonts/Helvetica.ttc",
  ];
  const bufs: Uint8Array[] = [];
  for (const p of fontPaths) {
    try {
      if (existsSync(p)) bufs.push(readFileSync(p));
    } catch {}
  }
  return bufs;
}

/** Initialize the WASM module — must be called before any SVG rendering */
export async function initResvg(): Promise<void> {
  if (wasmInitialized) return;
  const wasmBytes = await Bun.file(resvgWasmPath).arrayBuffer();
  await initWasm(wasmBytes);
  fontBuffers = loadSystemFonts();
  wasmInitialized = true;
}

/** Build the message to send to Claude for avatar generation */
export function buildProfilePrompt(description: string, svgPath: string): string {
  return `Generate an SVG image for a profile avatar and write it to ${svgPath} using the Write tool.

Requirements:
- Valid SVG with xmlns="http://www.w3.org/2000/svg"
- Square viewBox (e.g. viewBox="0 0 256 256")
- Simple, bold, recognizable at small sizes (chat avatar)
- Vibrant colors
- No external images, fonts, or links
- Write ONLY the SVG file, no other files

Description: ${description}

After writing the file, respond with just "Avatar SVG written."`;
}

/** Convert SVG file to PNG and return the bytes */
export async function convertAvatarSvg(svgPath: string): Promise<Uint8Array> {
  const svg = await readFile(svgPath, "utf-8");

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: AVATAR_SIZE },
    font: fontBuffers.length ? { fontBuffers, defaultFontFamily: "DejaVu Sans" } : undefined,
  });
  const png = resvg.render().asPng();

  // Clean up the SVG file
  await unlink(svgPath).catch(() => {});

  return png;
}

/** Sanitize SVG for resvg: fix unescaped &, strip unsupported foreignObject */
function sanitizeSvg(svg: string): string {
  // Fix unescaped & (not already part of &amp; &lt; &gt; &quot; &apos; &#NNN; &#xHHH;)
  let s = svg.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
  // Strip <foreignObject>...</foreignObject> blocks (resvg can't render them)
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  return s;
}

/** Convert an inline SVG string to PNG bytes */
export function svgToPng(svg: string): Uint8Array {
  const resvg = new Resvg(sanitizeSvg(svg), {
    fitTo: { mode: "width", value: INLINE_SVG_WIDTH },
    font: fontBuffers.length ? { fontBuffers, defaultFontFamily: "DejaVu Sans" } : undefined,
  });
  return resvg.render().asPng();
}

export type RichSegment =
  | { type: "text"; content: string }
  | { type: "svg"; content: string }
  | { type: "attach"; content: string };

/** Extract SVG blocks and <attach> tags from text, returning segments in order */
export function extractSvgBlocks(text: string): RichSegment[] {
  const combinedRegex = /(<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>[\s\S]*?<\/svg>)|(<attach>([\s\S]*?)<\/attach>)/g;
  const segments: RichSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combinedRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) segments.push({ type: "text", content: before });
    }
    if (match[1]) {
      segments.push({ type: "svg", content: match[1] });
    } else if (match[3]) {
      segments.push({ type: "attach", content: match[3].trim() });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const after = text.slice(lastIndex).trim();
    if (after) segments.push({ type: "text", content: after });
  }

  return segments;
}
