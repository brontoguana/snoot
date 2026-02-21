import { Resvg } from "@resvg/resvg-js";
import { readFile, unlink } from "fs/promises";

const AVATAR_SIZE = 256;

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
  });
  const png = resvg.render().asPng();

  // Clean up the SVG file
  await unlink(svgPath).catch(() => {});

  return png;
}
